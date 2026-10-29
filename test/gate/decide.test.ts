import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import type { Answers, DecisionProvider, DecisionResult } from '../../src/decision/types.js';
import type { ReviewResult } from '../../src/decision/llm-review.js';
import { createGate, deterministicOutcome, thresholdOutcome } from '../../src/gate/decide.js';
import { normalizeToolCall } from '../../src/gate/normalize/index.js';
import type { Action, GateContext } from '../../src/gate/types.js';
import { resolvePolicy } from '../../src/policy/effective.js';

function config() {
  return configSchema.parse({
    routes: [{ prefix: '/', protocol: 'anthropic-messages', upstream: 'mock' }],
    upstreams: { mock: { base_url: 'http://127.0.0.1:1234', api_key: 'literal-upstream-credential' } },
    decision: { chain: ['one'], providers: { one: { kind: 'systemone', base_url: 'http://127.0.0.1:1235', model: 'inert', api_key: 'literal-provider-credential' } } },
  });
}
const safe: Answers = { destructive: 0.1, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 };
const action: Action = { kind: 'command', tool: 'Bash', text: 'npm install inert', paths: [], content_truncated: false, raw: { justification: 'ASSISTANT_APPROVAL', result: 'TOOL_RESULT' } };
const ctx: GateContext = { platform: 'linux', project_dir: '/project', workdir: '/project', trusted_directories: ['/project'], home_dir: '/home/client', lastUserText: 'Install inert' };
function provider(answers = safe, id = 'one') {
  const decide = vi.fn(async (): Promise<DecisionResult> => ({ answers: { ...answers }, provider: id, model: 'inert', latency_ms: 0, usage: { input_tokens: 10 }, cost_usd: 0.01 }));
  return { id, decide };
}
const audit = vi.fn();
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('threshold precedence and exact boundaries', () => {
  const policy = resolvePolicy();
  it.each([
    [{ destructive: 0.7 }, 'block'], [{ destructive: 0.699999 }, 'uncertain'],
    [{ destructive: 0.5, matches_user_request: 0.3 }, 'block'],
    [{ destructive: 0.499999, matches_user_request: 0.3 }, 'uncertain'],
    [{ destructive: 0.5, matches_user_request: 0.300001 }, 'uncertain'],
    [{ destructive: 0.3, outside_scope: 0.5 }, 'allow'],
    [{ destructive: 0.300001 }, 'uncertain'], [{ outside_scope: 0.500001 }, 'uncertain'],
  ] as const)('classifies %j as %s', (scores, outcome) => {
    expect(thresholdOutcome({ ...safe, ...scores }, policy)).toBe(outcome);
  });
  it.each(['destructive', 'exfiltration', 'remote_code_exec', 'security_weakening'] as const)('blocks each risk dimension: %s', (risk) => {
    expect(thresholdOutcome({ ...safe, [risk]: 0.7 }, policy)).toBe('block');
  });
  it('honors resolved threshold overrides and block-before-allow precedence', () => {
    expect(thresholdOutcome(safe, resolvePolicy({ thresholds: { risk_block: 0.1, risk_allow: 1, intent_mismatch: 0.3, intent_risk: 0.5, outside_scope_allow: 1 } }))).toBe('block');
  });
});

describe('shared deterministic boundary', () => {
  const policy = resolvePolicy();
  it.each([
    [{ ...action, text: 'pwd' }, 'allow'],
    [{ ...action, kind: 'other' as const, text: undefined }, 'allow'],
    [action, 'review'],
    [{ ...action, kind: 'file_write' as const, paths: ['/project/note.txt'], content_excerpt: 'inert' }, 'review'],
    [{ ...action, kind: 'other' as const, paths: ['/project/.env'], recognized_exemption: 'read' as const }, 'review'],
    [{ ...action, kind: 'other' as const, paths: ['/project/.env'] }, 'review'],
    [{ ...action, text: 'rm -rf /' }, 'block'],
    [{ ...action, kind: 'other' as const, execution_unavailable: true }, 'block'],
    [{ ...action, kind: 'file_write' as const, content_truncated: true }, 'block'],
  ])('preserves the real pre-provider result for %j', async (input, outcome) => {
    const result = deterministicOutcome(input, ctx, policy);
    expect(result.outcome).toBe(outcome);
    const p = provider();
    const cfg = config(); cfg.gate.on_provider_failure = 'allow';
    const verdict = await createGate(cfg, { providers: [p], audit, policy }).decide(input, ctx);
    if (outcome === 'review') {
      expect(p.decide).toHaveBeenCalledTimes(1);
      expect(verdict.provider).toBe('one');
    } else {
      expect(p.decide).not.toHaveBeenCalled();
      expect(verdict).toMatchObject({ outcome, rule: result.rule, reasons: result.reasons });
    }
  });
});

describe('review outcome provenance', () => {
  it.each([false, true])('distinguishes valid denial from invalid review without changing block/cache semantics: %s', async (invalid) => {
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      verdict: 'block', reason: 'Inert review result', provider: 'second_stage', model: 'inert',
      latency_ms: 0, usage: {}, cost_usd: null, ...(invalid ? { invalid_response: true } : {}),
    }));
    const gate = createGate(config(), { providers: [provider({ ...safe, destructive: 0.4 })], reviewer: { review }, audit });
    const first = await gate.decide(action, ctx);
    const second = await gate.decide(action, ctx);
    expect(first).toMatchObject({ outcome: 'block', raw_outcome: 'uncertain', rule: invalid ? 'llm-review-invalid' : 'llm-review' });
    expect(second).toMatchObject({ outcome: 'block', raw_outcome: 'uncertain' });
    expect(second.cache_hit === true).toBe(!invalid);
    expect(review).toHaveBeenCalledTimes(invalid ? 2 : 1);
  });
});

describe('gate branches and audit', () => {
  it.each([
    [{ ...action, text: 'rm -rf /' }, 'root-home-delete'],
    [{ ...action, kind: 'other' as const, execution_unavailable: true }, 'execution-unavailable'],
    [{ ...action, kind: 'file_write' as const, paths: ['/project/note'], content_truncated: true }, 'content-truncated'],
    [{ ...action, kind: 'file_write' as const, paths: ['/project/note'], content_excerpt: 'a'.repeat(2048) + 'rm -rf /' }, 'content-truncated'],
  ])('blocks structural/hard barrier before fail-open %s', async (input, rule) => {
    const cfg = config(); cfg.gate.on_provider_failure = 'allow';
    const p = provider();
    const gate = createGate(cfg, { providers: [p], audit });
    expect(await gate.decide(input, ctx)).toMatchObject({ outcome: 'block', rule });
    expect(p.decide).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledTimes(1);
  });
  it.each(['command', 'url', 'file_write'] as const)('blocks unavailable configured %s arguments before provider fail-open', async (kind) => {
    const cfg = config();
    cfg.gate.on_provider_failure = 'allow';
    const p = provider();
    const gate = createGate(cfg, { providers: [p], audit });
    const action = normalizeToolCall('openai-chat', {
      id: 'mapped-missing', name: 'custom', input: { command: 'pwd', url: 'https://example.invalid', path: 'inert.txt', new_string: 'inert fallback' }, raw: {},
    }, ctx, { tool_map: { custom: { kind, arg: 'payload' } } });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'execution-unavailable' });
    expect(p.decide).not.toHaveBeenCalled();
  });
  it.each([
    { ...action, kind: 'other' as const, text: undefined, paths: [] },
    { ...action, kind: 'other' as const, text: undefined, recognized_exemption: 'todo' as const },
    { ...action, kind: 'other' as const, text: undefined, recognized_exemption: 'task' as const },
    { ...action, text: 'pwd' },
  ])('allows non-sensitive genuine other and recognized exemptions', async (input) => {
    const p = provider(); const gate = createGate(config(), { providers: [p], audit });
    expect((await gate.decide(input, ctx)).outcome).toBe('allow');
    expect(p.decide).not.toHaveBeenCalled();
  });
  it.each([
    { ...action, text: 'cat ~/.ssh/id_rsa' },
    { ...action, text: 'cat /project/reports/ledger.tsv' },
    { ...action, kind: 'other' as const, paths: ['/project/plain.txt'], recognized_exemption: 'read' as const },
    { ...action, kind: 'other' as const, paths: ['/project/.env'], recognized_exemption: 'read' as const },
    { ...action, kind: 'other' as const, paths: ['/project/.env'] },
  ])('reviews content reads and sensitive paths before any exemption', async (input) => {
    const p = provider({ ...safe, exfiltration: 0.9 });
    expect(await createGate(config(), { providers: [p], audit }).decide(input, ctx)).toMatchObject({ outcome: 'block', provider: 'one' });
    expect(p.decide).toHaveBeenCalledTimes(1);
  });
  it('retains raw gray and blocks when no reviewer is configured, independent of failure allow', async () => {
    const cfg = config(); cfg.gate.on_provider_failure = 'allow';
    const gate = createGate(cfg, { providers: [provider({ ...safe, destructive: 0.4 })], audit });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', raw_outcome: 'uncertain', rule: 'gray-block' });
    expect(gate.stats()).toMatchObject({ decisions: 1, block: 1, uncertain: 1, provider_failures: 0 });
  });
  it('redacts configured literals before truncation and excludes raw assistant/results', async () => {
    const p = provider(); const gate = createGate(config(), { providers: [p], audit });
    await gate.decide({ ...action, text: 'echo literal-upstream-credential literal-provider-credential' }, { ...ctx, lastUserText: 'x'.repeat(990) + 'literal-provider-credential' });
    const state = p.decide.mock.calls[0];
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('literal-provider');
    expect(serialized).not.toContain('literal-upstream');
    expect(serialized).not.toContain('ASSISTANT_APPROVAL');
    expect(serialized).not.toContain('TOOL_RESULT');
  });
  it('permits exactly 2048 UTF-8 bytes to reach review without approving an unseen suffix', async () => {
    const p = provider();
    const write: Action = { ...action, kind: 'file_write', paths: ['/project/note'], content_excerpt: 'a'.repeat(2048) };
    expect(await createGate(config(), { providers: [p], audit }).decide(write, ctx)).toMatchObject({ outcome: 'allow', provider: 'one' });
    expect(p.decide).toHaveBeenCalledTimes(1);
  });
  it('audits every cached/rule/model verdict exactly once and isolates sink failure', async () => {
    const sink = vi.fn(() => { throw new Error('disk failure'); });
    const gate = createGate(config(), { providers: [provider()], audit: sink });
    await gate.decide(action, ctx); await gate.decide(action, ctx); await gate.decide({ ...action, text: 'pwd' }, ctx);
    expect(sink).toHaveBeenCalledTimes(3); expect(gate.stats()).toMatchObject({ decisions: 3, allow: 3, cache_hits: 1 });
    await gate.flushAudit();
  });
});

describe('failure, cancellation and cache boundaries', () => {
  it('hard-denies without constructing a configured provider', async () => {
    const cfg = config(); cfg.decision.providers.one!.kind = 'openai-decisions';
    const gate = createGate(cfg, { audit });
    expect(await gate.decide({ ...action, text: 'rm -rf /' }, ctx)).toMatchObject({ outcome: 'block', rule: 'root-home-delete' });
    expect(gate.stats().provider_failures).toBe(0);
  });
  it.each([['one', 'future'], ['future', 'one']])('reaches real SystemOne with chain %j', async (...chain) => {
    const cfg = config();
    cfg.decision.providers.future = { ...cfg.decision.providers.one!, kind: 'openai-decisions' };
    cfg.decision.chain = chain;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      answers: Object.fromEntries(Object.entries(safe).map(([id, noul]) => [id, { type: 'noul', noul }])),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const gate = createGate(cfg, { audit });
      expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'allow', provider: 'one' });
      expect(fetch).toHaveBeenCalledTimes(chain[0] === 'future' ? 2 : 1);
      expect(gate.stats().provider_health.future?.failures).toBe(chain[0] === 'future' ? 1 : 0);
    } finally { fetch.mockRestore(); }
  });
  it.each([NaN, Infinity, -0.01, 1.01, undefined])('fails over malformed probability %s and tracks health', async (score) => {
    const invalid = provider({ ...safe, destructive: score } as Answers, 'bad'); const good = provider(safe, 'good');
    const gate = createGate(config(), { providers: [invalid, good], audit });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'allow', provider: 'good' });
    expect(gate.stats().provider_health).toEqual({ bad: { failures: 1, successes: 0 }, good: { failures: 0, successes: 1 } });
  });
  it.each(['block', 'allow'] as const)('uses explicit provider failure %s without caching failure', async (failure) => {
    const cfg = config(); cfg.gate.on_provider_failure = failure;
    const p = provider(); p.decide.mockRejectedValue(new Error('private-provider-error'));
    const gate = createGate(cfg, { providers: [p], audit });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: failure, rule: 'provider-unavailable' });
    await gate.decide(action, ctx); expect(p.decide).toHaveBeenCalledTimes(2);
  });
  it('caller abort can never fail open, even if provider ignores abort', async () => {
    const cfg = config(); cfg.gate.on_provider_failure = 'allow';
    const controller = new AbortController();
    const p: DecisionProvider = { id: 'one', decide: () => Promise.withResolvers<DecisionResult>().promise };
    const gate = createGate(cfg, { providers: [p], audit });
    const work = gate.decide(action, { ...ctx, signal: controller.signal }); controller.abort();
    expect(await work).toMatchObject({ outcome: 'block', rule: 'caller-aborted' });
    expect(await gate.decide(action, { ...ctx, signal: controller.signal })).toMatchObject({ outcome: 'block' });
  });
  it('cancels a noncooperative reviewer without fail-open or losing first-stage evidence', async () => {
    const cfg = config(); cfg.gate.on_provider_failure = 'allow';
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const gate = createGate(cfg, { providers: [provider({ ...safe, destructive: 0.4 })], audit,
      reviewer: { review: (_state, _answers, options) => { signal = options?.signal; entered.resolve(); return Promise.withResolvers<ReviewResult>().promise; } } });
    const pending = gate.decide(action, { ...ctx, signal: controller.signal });
    await entered.promise;
    controller.abort();
    expect(await pending).toMatchObject({ outcome: 'block', rule: 'caller-aborted', raw_outcome: 'uncertain', provider: 'one', probabilities: { destructive: 0.4 }, cost_usd: null,
      stages: [{ stage: 'decision', input_tokens: 10, cost_usd: 0.01 }, { stage: 'review', input_tokens: null, cost_usd: null }] });
    expect(signal?.aborted).toBe(true);
  });
  it('bounds an ignoring provider to 60 seconds and aborts its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const p: DecisionProvider = { id: 'one', decide: (_state, _questions, options) => { signal = options?.signal; return Promise.withResolvers<DecisionResult>().promise; } };
    const gate = createGate(config(), { providers: [p], audit }); const work = gate.decide(action, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await work).toMatchObject({ outcome: 'block', rule: 'decision-timeout' }); expect(signal?.aborted).toBe(true);
  });
  it('reuses only complete successes and returns independent verdict objects', async () => {
    const p = provider(); const gate = createGate(config(), { providers: [p], audit });
    const first = await gate.decide(action, ctx); first.reasons.push('poison'); first.probabilities!.destructive = 1;
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'allow', cache_hit: true, cost_usd: 0, probabilities: safe });
    expect(p.decide).toHaveBeenCalledTimes(1);
  });
  it.each([
    { lastUserText: 'different user intent' }, { project_dir: '/different' },
    { trusted_directories: ['/different'] }, { workdir: '/different' },
    { platform: 'windows' }, { git_branch: 'other' },
  ])('does not cross effective context %j', async (change) => {
    const p = provider(); const gate = createGate(config(), { providers: [p], audit });
    await gate.decide(action, ctx); await gate.decide(action, { ...ctx, ...change });
    expect(p.decide).toHaveBeenCalledTimes(2);
  });
  it('isolates full-content digests, action identity and expiry', async () => {
    let time = 0; const p = provider(); const gate = createGate(config(), { providers: [p], audit, now: () => time });
    const write: Action = { ...action, kind: 'file_write', paths: ['/project/note'], content_excerpt: 'inert', content_digest: 'first' };
    await gate.decide(write, ctx); await gate.decide({ ...write, content_digest: 'second' }, ctx);
    await gate.decide({ ...write, tool: 'OtherWrite' }, ctx);
    time = 600_000; await gate.decide(write, ctx); expect(p.decide).toHaveBeenCalledTimes(4);
  });
  it('isolates config instances, credential changes, policy, provider order and shadow/enforce', async () => {
    const p = provider(); const cfg = config();
    const first = createGate(cfg, { providers: [p], audit }); await first.decide(action, ctx);
    cfg.gate.mode = 'shadow'; cfg.policy.version = 'changed'; cfg.decision.providers.one!.api_key = 'changed-secret';
    const shadow = createGate(cfg, { providers: [p], audit }); await shadow.decide(action, ctx);
    cfg.gate.mode = 'enforce';
    const enforce = createGate(cfg, { providers: [p], audit }); await enforce.decide(action, ctx);
    expect(p.decide).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls[1]?.[0]).toMatchObject({ delivery: 'shadow' });
    expect((await first.decide(action, ctx)).cache_hit).toBe(true);
  });
});

describe('content approval state and cache semantics', () => {
  it.each(['anthropic-messages', 'openai-responses', 'openai-chat'] as const)('%s: native reads reach the actual provider with redacted user intent and remain context-cached', async (protocol) => {
    const captured: string[] = [];
    const p: DecisionProvider = { id: 'one', async decide(state) {
      captured.push(JSON.stringify(state));
      return { answers: { ...safe }, provider: 'one', model: 'inert', latency_ms: 0, usage: {}, cost_usd: null };
    } };
    const context = { ...ctx, lastUserText: 'Review only parser source; do not disclose business data literal-provider-credential' };
    const read = normalizeToolCall(protocol, { id: 'read', name: 'read_file', input: JSON.stringify({ path: 'reports/ledger.tsv' }), raw: { justification: 'ASSISTANT_APPROVAL' } }, context);
    const gate = createGate(config(), { providers: [p], audit });
    expect(deterministicOutcome(read, context, resolvePolicy()).outcome).toBe('review');
    expect(await gate.decide(read, context)).toMatchObject({ outcome: 'allow', provider: 'one' });
    expect(await gate.decide(read, context)).toMatchObject({ cache_hit: true, cost_usd: 0 });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('Review only parser source; do not disclose business data');
    expect(captured[0]).toContain('reports/ledger.tsv');
    expect(captured[0]).not.toContain('literal-provider-credential');
    expect(captured[0]).not.toContain('ASSISTANT_APPROVAL');
    await gate.decide(read, { ...context, lastUserText: 'Different actual user request' });
    expect(captured).toHaveLength(2);
    const changed = config(); changed.policy.version = 'different-reviewed-policy';
    const other = createGate(changed, { providers: [p], audit });
    expect((await other.decide(read, context)).policy_version).toBe('different-reviewed-policy');
    expect(captured).toHaveLength(3);
  });
  it('retains hard barriers before read approval even with failure allow', async () => {
    const cfg = config(); cfg.gate.on_provider_failure = 'allow';
    const p = provider(); const gate = createGate(cfg, { providers: [p], audit });
    for (const input of [
      { ...action, text: 'rm -rf /', recognized_exemption: 'read' as const },
      { ...action, kind: 'other' as const, execution_unavailable: true, recognized_exemption: 'read' as const },
      { ...action, kind: 'file_write' as const, content_truncated: true, recognized_exemption: 'read' as const },
    ]) expect((await gate.decide(input, ctx)).outcome).toBe('block');
    expect(p.decide).not.toHaveBeenCalled();
  });
});
