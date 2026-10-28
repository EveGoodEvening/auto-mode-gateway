import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecisionChain, createDecisionProvider, decideChain } from '../../src/decision/chain.js';
import { DEFAULT_POLICY } from '../../src/policy/effective.js';
import { DecisionError, type Answers, type DecisionProvider, type DecisionResult, type DecisionState, type ProviderConfig } from '../../src/decision/types.js';

const state: DecisionState = { action: { tool: 'Bash', command: 'npm install' }, environment: { platform: 'linux', project_dir: '/project', trusted_directories: [] }, user_request: 'Install dependencies' };
const answers = Object.fromEntries(Object.keys(DEFAULT_POLICY.questions).map((id) => [id, 0.1])) as Answers;
const result: DecisionResult = { answers, provider: 'second', model: 'jev-latest', usage: {}, cost_usd: null, latency_ms: 0 };
const providerConfig: ProviderConfig = { kind: 'systemone', base_url: 'http://127.0.0.1/v1', api_key: 'sentinel', model: 'jev-latest', envelope: 'none' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('ordered decision chain', () => {
  it('fails over in order and stops on first success', async () => {
    const first = vi.fn().mockRejectedValue(new Error('raw-secret-key'));
    const second = vi.fn().mockResolvedValue(result);
    const third = vi.fn();
    expect(await decideChain([{ id: 'first', decide: first }, { id: 'second', decide: second }, { id: 'third', decide: third }], state, DEFAULT_POLICY.questions)).toMatchObject({ provider: 'second' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]!);
    expect(third).not.toHaveBeenCalled();
  });
  it('reports only sanitized exhaustion without raw provider failures', async () => {
    const providers: DecisionProvider[] = [{ id: 'first', decide: async () => { throw new Error('Bearer secret-sentinel'); } }];
    await expect(decideChain(providers, state, DEFAULT_POLICY.questions)).rejects.toEqual(new DecisionError('exhausted'));
    await expect(decideChain([], state, DEFAULT_POLICY.questions)).rejects.toMatchObject({ code: 'exhausted' });
  });
  it('enforces default 60s whole-chain bound even with noncooperative providers', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const next = vi.fn();
    const pending = decideChain([{ id: 'hang', decide: (_state, _questions, options) => { signal = options?.signal; return Promise.withResolvers<DecisionResult>().promise; } }, { id: 'next', decide: next }], state, DEFAULT_POLICY.questions).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ code: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
  it('propagates cancellation without trying another provider', async () => {
    const controller = new AbortController();
    const next = vi.fn();
    let signal: AbortSignal | undefined;
    const pending = decideChain([{ id: 'hang', decide: (_state, _questions, options) => { signal = options?.signal; return Promise.withResolvers<DecisionResult>().promise; } }, { id: 'next', decide: next }], state, DEFAULT_POLICY.questions, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect(await pending).toMatchObject({ code: 'aborted' });
    expect(signal?.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
  it('supports an earlier absolute deadline and abort-before-start', async () => {
    const decide = vi.fn();
    await expect(decideChain([{ id: 'one', decide }], state, DEFAULT_POLICY.questions, { deadline_ms: Date.now() - 1 })).rejects.toMatchObject({ code: 'timeout' });
    const controller = new AbortController(); controller.abort();
    await expect(decideChain([{ id: 'one', decide }], state, DEFAULT_POLICY.questions, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(decide).not.toHaveBeenCalled();
  });
  it('constructs only actual SystemOne providers and rejects future kinds actionably', async () => {
    expect(createDecisionProvider('one', providerConfig, 1000).id).toBe('one');
    expect(() => createDecisionProvider('future', { ...providerConfig, kind: 'openai-decisions' }, 1000)).toThrow(/requires C09/);
    const future = createDecisionChain({ chain: ['future'], providers: { future: { ...providerConfig, kind: 'openai-decisions' } } }, 1000);
    await expect(future.decide(state, DEFAULT_POLICY.questions)).rejects.toMatchObject({ code: 'exhausted' });
    const missing = createDecisionChain({ chain: ['missing'], providers: {} }, 1000);
    await expect(missing.decide(state, DEFAULT_POLICY.questions)).rejects.toMatchObject({ code: 'exhausted' });
  });
  it.each([['one', 'future'], ['future', 'one']])('constructs real adapters lazily and fails over unsupported entries: %s %s', async (first, second) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: 'noul', noul }])) })));
    vi.stubGlobal('fetch', fetcher);
    const chain = createDecisionChain({ chain: [first, second], providers: { one: providerConfig, future: { ...providerConfig, kind: 'openai-decisions' } } }, 1000);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await chain.decide(state, DEFAULT_POLICY.questions)).provider).toBe('one');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
