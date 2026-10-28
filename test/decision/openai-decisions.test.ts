import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideChain } from '../../src/decision/chain.js';
import { OpenAIDecisionsProvider, openAIDecisionsUrl, parseOpenAIDecisionsResponse } from '../../src/decision/openai-decisions.js';
import type { DecisionState, ProviderConfig } from '../../src/decision/types.js';
import { DEFAULT_POLICY, resolvePolicy } from '../../src/policy/effective.js';

const questions = DEFAULT_POLICY.questions;
const state: DecisionState = { action: { tool: 'Bash', command: 'npm install' }, environment: { platform: 'linux', project_dir: '/project', trusted_directories: [] }, user_request: 'Install dependencies' };
function config(base_url = 'https://ai-gateway.vercel.sh/v1', extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { kind: 'openai-decisions', base_url, api_key: 'decisions-test-credential', model: 'openai/gpt-6-luna-decisions', envelope: 'none', ...extra };
}
function wire() {
  return { model: 'openai/gpt-6-luna-decisions', answers: Object.keys(questions).map((name, index) => ({ type: 'predicate', name, probability: index / 5 })), usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 } };
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('OpenAI Decisions request and answer contract', () => {
  it.each(['https://ai-gateway.vercel.sh/v1', 'https://api.openai.com/v1'])('uses native predicates and state JSON at %s', async (base) => {
    const policy = resolvePolicy({ questions: { destructive: { instructions: 'Evaluate irreversible loss.', criteria: { true: 'Existing data is lost.', false: 'Existing data is retained.' } } } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(wire()));
    vi.stubGlobal('fetch', fetcher);
    const provider = new OpenAIDecisionsProvider('luna', config(base, {
      headers: { authorization: 'not-the-key', 'content-type': 'text/plain', 'x-route': 'trusted' },
      body_extra: { model: 'untrusted', input: 'untrusted', questions: [], providerOptions: { gateway: { only: ['openai'] } } },
    }), 1000);
    const result = await provider.decide(state, policy.questions);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${base}/decisions`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${config().api_key}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-route')).toBe('trusted');
    expect(init?.redirect).toBe('manual');
    const request = JSON.parse(String(init?.body)) as { model: string; input: string; questions: { type: string; name: string; instructions: string }[]; providerOptions: unknown };
    expect(request.model).toBe(config().model);
    expect(JSON.parse(request.input)).toEqual(state);
    expect(request.questions.map(({ type, name }) => ({ type, name }))).toEqual(Object.keys(questions).map((name) => ({ type: 'predicate', name })));
    const destructive = request.questions.find(({ name }) => name === 'destructive')!;
    for (const part of [policy.questions.destructive.instructions, ...Object.values(policy.questions.destructive.criteria)]) expect(destructive.instructions).toContain(part);
    expect(request.providerOptions).toEqual({ gateway: { only: ['openai'] } });
    expect(result).toMatchObject({ provider: 'luna', model: wire().model, answers: { destructive: 0, matches_user_request: 1 }, usage: { input_tokens: 100, output_tokens: 0 }, cost_usd: null });
  });
  it('associates shuffled answers by name, not position', () => {
    const response = wire();
    response.answers.reverse();
    expect(parseOpenAIDecisionsResponse(response).answers).toEqual({ destructive: 0, exfiltration: 0.2, remote_code_exec: 0.4, security_weakening: 0.6, outside_scope: 0.8, matches_user_request: 1 });
  });
  it('accepts origin roots and complete endpoints without appending twice', () => {
    expect(openAIDecisionsUrl('https://api.openai.com/')).toBe('https://api.openai.com/v1/decisions');
    expect(openAIDecisionsUrl('https://ai-gateway.vercel.sh/v1/decisions/')).toBe('https://ai-gateway.vercel.sh/v1/decisions');
  });
  it.each(['https://user:password@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid/v1#secret', 'file:///tmp/decisions'])('rejects unsafe endpoint %s before transport', (url) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    expect(() => new OpenAIDecisionsProvider('luna', config(url), 1000)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('whole-provider failure and ordered failover', () => {
  const invalidAnswers: [string, (answers: unknown[]) => unknown[]][] = [
    ['refusal', (answers) => [{ type: 'refusal', name: 'destructive' }, ...answers.slice(1)]],
    ['missing', (answers) => answers.slice(1)],
    ['duplicate', (answers) => [answers[1], ...answers.slice(1)]],
    ['extra', (answers) => [...answers, { type: 'predicate', name: 'extra', probability: 0 }]],
    ['unknown name', (answers) => [{ type: 'predicate', name: '__proto__', probability: 0 }, ...answers.slice(1)]],
    ['unnamed', (answers) => [{ type: 'predicate', name: null, probability: 0 }, ...answers.slice(1)]],
    ['wrong answer type', (answers) => [{ type: 'choice', name: 'destructive', probability: 0 }, ...answers.slice(1)]],
  ];
  it.each(invalidAnswers)('fails over atomically after %s without merging partial scores', async (_name, change) => {
    const failed = { ...wire(), answers: change(wire().answers) };
    const success = wire();
    success.answers = success.answers.map((answer) => ({ ...answer, probability: 0.25 }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(failed)).mockResolvedValueOnce(json(success));
    vi.stubGlobal('fetch', fetcher);
    const result = await decideChain([
      new OpenAIDecisionsProvider('first', config(), 1000),
      new OpenAIDecisionsProvider('second', config('https://api.openai.com/v1'), 1000),
      new OpenAIDecisionsProvider('unused', config(), 1000),
    ], state, questions);
    expect(result.provider).toBe('second');
    expect(Object.values(result.answers)).toEqual(Array(6).fill(0.25));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://ai-gateway.vercel.sh/v1/decisions', 'https://api.openai.com/v1/decisions']);
  });
  it.each([undefined, null, '0.2', -0.1, 1.1, NaN, Infinity])('rejects invalid probability %s', (probability) => {
    const response = wire();
    expect(() => parseOpenAIDecisionsResponse({ ...response, answers: [{ type: 'predicate', name: 'destructive', probability }, ...response.answers.slice(1)] })).toThrow();
  });
  it.each([null, {}, { answers: {} }, { ...wire(), refusal: 'declined' }, { ...wire(), error: { message: 'private' } }])('does not return answers from an unsuccessful response', (response) => {
    expect(() => parseOpenAIDecisionsResponse(response)).toThrow();
  });
  it('exhausts the chain rather than returning partial approval', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ ...wire(), answers: wire().answers.slice(1) })));
    await expect(decideChain([new OpenAIDecisionsProvider('luna', config(), 1000)], state, questions)).rejects.toMatchObject({ code: 'exhausted' });
  });
});

describe('usage and transport boundaries', () => {
  it('retains unknown usage and cost instead of manufacturing zeros', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ answers: wire().answers })));
    const result = await new OpenAIDecisionsProvider('luna', config(), 1000).decide(state, questions);
    expect(result.usage).toEqual({});
    expect(result.cost_usd).toBeNull();
  });
  it('uses configured pricing only when billable usage is known', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(wire())).mockResolvedValueOnce(json({ ...wire(), usage: { input_tokens: 100 } }));
    vi.stubGlobal('fetch', fetcher);
    const provider = new OpenAIDecisionsProvider('luna', config(undefined, { pricing: { input_usd_per_million: 2, output_usd_per_million: 4 } }), 1000);
    expect((await provider.decide(state, questions)).cost_usd).toBeCloseTo(0.0002);
    expect((await provider.decide(state, questions)).cost_usd).toBeNull();
  });
  it.each([null, { input_tokens: -1 }, { output_tokens: 0.1 }, { input_tokens: '100' }, { output_tokens: Number.MAX_SAFE_INTEGER + 1 }])('rejects malformed token accounting', (usage) => {
    expect(() => parseOpenAIDecisionsResponse({ ...wire(), usage })).toThrow();
  });
  it.each(['malformed JSON', 'oversized valid answers', 'HTTP error'] as const)('fails over without accepting scores from %s', async (failure) => {
    const rejected = failure === 'malformed JSON'
      ? new Response('{private-invalid-json')
      : failure === 'oversized valid answers'
        ? json({ ...wire(), extra: 'x'.repeat(1_048_576) })
        : new Response('private-provider-body', { status: 401 });
    const accepted = { ...wire(), answers: wire().answers.map((answer) => ({ ...answer, probability: 0.25 })) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected).mockResolvedValueOnce(json(accepted));
    vi.stubGlobal('fetch', fetcher);
    const result = await decideChain([
      new OpenAIDecisionsProvider('unavailable', config(), 1000),
      new OpenAIDecisionsProvider('available', config('https://api.openai.com/v1'), 1000),
    ], state, questions);
    expect(result.provider).toBe('available');
    expect(Object.values(result.answers)).toEqual(Array(6).fill(0.25));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
