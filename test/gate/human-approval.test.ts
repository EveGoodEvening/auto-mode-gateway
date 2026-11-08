import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, type ApprovalSubject } from '../../src/approval/broker.js';
import { collectConfigSecrets, createAuditRecord, type AuditInput } from '../../src/audit/record.js';
import { configSchema } from '../../src/config/schema.js';
import type { Answers, DecisionResult } from '../../src/decision/types.js';
import type { ReviewProvider, ReviewResult } from '../../src/decision/llm-review.js';
import { createGate, DECISION_DEADLINE_MS } from '../../src/gate/decide.js';
import type { Action, GateContext } from '../../src/gate/types.js';
import { explanation } from '../../src/protocols/anthropic/safety.js';
import { createStatus } from '../../src/server/status.js';

const CREDENTIAL = 'literal-provider-credential-xyz';
function config(extra: Record<string, unknown> = {}) {
  return configSchema.parse({
    routes: [{ prefix: '/', protocol: 'anthropic-messages', upstream: 'mock' }],
    upstreams: { mock: { base_url: 'http://127.0.0.1:1234', api_key: 'literal-upstream-credential' } },
    decision: { chain: ['one'], providers: { one: { kind: 'systemone', base_url: 'http://127.0.0.1:1235', model: 'inert', api_key: CREDENTIAL } } },
    human_approval: { enabled: true, timeout_ms: 1000 },
    ...extra,
  });
}
const gray: Answers = { destructive: 0.4, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 };
const action: Action = { kind: 'command', tool: 'Bash', argv: ['curl', '-H', `x-key: ${CREDENTIAL}`, 'https://example.invalid'], paths: [], content_truncated: false,
  raw: { justification: 'RAW_JUSTIFICATION', result: 'RAW_RESULT' } };
const ctx: GateContext = { platform: 'linux', project_dir: '/project', workdir: '/project', trusted_directories: ['/project'], lastUserText: 'Fetch the page',
  route: '/', protocol: 'anthropic-messages', session_id: 'session-1' };
function provider(answers = gray) {
  const decide = vi.fn(async (): Promise<DecisionResult> => ({ answers: { ...answers }, provider: 'one', model: 'inert', latency_ms: 0, usage: { input_tokens: 10, output_tokens: 2 }, cost_usd: 0.01 }));
  return { id: 'one', decide };
}
function reviewer(verdict: ReviewResult['verdict'], extra: Partial<ReviewResult> = {}) {
  const review = vi.fn(async (): Promise<ReviewResult> => ({ verdict, reason: `reviewer says ${verdict} ${CREDENTIAL}`, provider: 'second_stage', model: 'inert',
    latency_ms: 0, usage: { input_tokens: 5, output_tokens: 1 }, cost_usd: 0.001, ...extra }));
  return { review } satisfies ReviewProvider;
}
function broker(options: Partial<ConstructorParameters<typeof ApprovalBroker>[0]> = {}) {
  return new ApprovalBroker({ timeout_ms: 1000, max_pending: 10, ...options });
}
/** Answers the first pending request once it appears. */
function answer(approvals: ApprovalBroker, decision: 'allow' | 'block', seen?: ApprovalSubject[]) {
  const unsubscribe = approvals.subscribe(() => {
    const pending = approvals.list()[0];
    if (!pending) return;
    unsubscribe();
    seen?.push(pending.subject);
    queueMicrotask(() => approvals.decide(pending.id, decision));
  });
}
const audit = vi.fn<(input: AuditInput) => void>();
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('gray without reviewer escalates to a human', () => {
  it.each([['allow', 'allow', 'human-approved'], ['block', 'block', 'human-denied']] as const)('human %s', async (decision, outcome, rule) => {
    const approvals = broker();
    const seen: ApprovalSubject[] = [];
    answer(approvals, decision, seen);
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const verdict = await gate.decide(action, ctx);
    expect(verdict).toMatchObject({ outcome, rule, raw_outcome: 'uncertain', provider: 'one' });
    expect(verdict.reasons).toEqual([rule, 'gray-no-reviewer']);
    expect(verdict.probabilities).toEqual(gray);
    expect(verdict.stages?.map((stage) => stage.stage)).toEqual(['decision', 'human']);
    expect(verdict.stages?.[1]).toMatchObject({ stage: 'human', provider: 'human', input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    expect(verdict.cost_usd).toBeCloseTo(0.01);
    expect(seen[0]).toMatchObject({ tool: 'Bash', kind: 'command', escalation: 'gray-no-reviewer', route: '/', protocol: 'anthropic-messages', session_id: 'session-1', user_request: 'Fetch the page', workdir: '/project' });
    expect(seen[0]?.reviewer_reason).toBeUndefined();
    expect(gate.stats()).toMatchObject({ decisions: 1, [outcome]: 1, uncertain: 1, human_pending: 0,
      human_approved: decision === 'allow' ? 1 : 0, human_denied: decision === 'block' ? 1 : 0, human_timeout: 0 });
    await gate.flushAudit();
    expect(audit.mock.calls[0]?.[0].verdict.stages?.some((stage) => stage.stage === 'human')).toBe(true);
  });

  it('times out to a block and counts it', async () => {
    vi.useFakeTimers();
    const approvals = broker({ timeout_ms: 500 });
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const pending = gate.decide(action, ctx);
    await vi.waitFor(() => expect(approvals.size).toBe(1));
    expect(gate.stats().human_pending).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ outcome: 'block', rule: 'human-timeout' });
    expect(gate.stats()).toMatchObject({ human_pending: 0, human_timeout: 1, human_approved: 0, human_denied: 0 });
  });

  it('waits beyond the model decision deadline (human wait is outside DECISION_DEADLINE_MS)', async () => {
    vi.useFakeTimers();
    const approvals = broker({ timeout_ms: DECISION_DEADLINE_MS * 3 });
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const pending = gate.decide(action, ctx);
    await vi.waitFor(() => expect(approvals.size).toBe(1));
    await vi.advanceTimersByTimeAsync(DECISION_DEADLINE_MS * 2);
    expect(approvals.size).toBe(1);
    approvals.decide(approvals.list()[0]!.id, 'allow');
    expect(await pending).toMatchObject({ outcome: 'allow', rule: 'human-approved' });
  });

  it('caller abort while waiting blocks as caller-aborted', async () => {
    const approvals = broker();
    const controller = new AbortController();
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const pending = gate.decide(action, { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(approvals.size).toBe(1));
    controller.abort();
    expect(await pending).toMatchObject({ outcome: 'block', rule: 'caller-aborted' });
    expect(approvals.size).toBe(0);
    expect(gate.stats().human_pending).toBe(0);
  });

  it('broker shutdown blocks as human-approval-aborted', async () => {
    const approvals = broker();
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const pending = gate.decide(action, ctx);
    await vi.waitFor(() => expect(approvals.size).toBe(1));
    approvals.close();
    expect(await pending).toMatchObject({ outcome: 'block', rule: 'human-approval-aborted' });
  });

  it('queue full blocks as human-approval-unavailable without waiting', async () => {
    const approvals = broker({ max_pending: 1 });
    void approvals.request({ tool: 'x', kind: 'other', paths: [], escalation: 'gray-no-reviewer' });
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const verdict = await gate.decide(action, ctx);
    expect(verdict).toMatchObject({ outcome: 'block', rule: 'human-approval-unavailable' });
    expect(verdict.stages?.map((stage) => stage.stage)).toEqual(['decision', 'human']);
    approvals.close();
  });

  it('a request after broker shutdown blocks as unavailable without blaming a full queue', async () => {
    const approvals = broker();
    approvals.close();
    const gate = createGate(config(), { providers: [provider()], audit, approvals });
    const verdict = await gate.decide(action, ctx);
    expect(verdict).toMatchObject({ outcome: 'block', rule: 'human-approval-unavailable' });
    expect(approvals.size).toBe(0);
    const text = explanation(verdict);
    expect(text).toBe('[auto-mode-proxy] human approval unavailable (queue full or gateway shutting down); the action was blocked');
    expect(text).not.toContain('approval queue full');
  });

  it('subject carries only redacted state: no configured credential or raw input', async () => {
    const approvals = broker();
    const seen: ApprovalSubject[] = [];
    answer(approvals, 'block', seen);
    const gate = createGate(config(), { providers: [provider()], reviewer: reviewer('uncertain'), audit, approvals });
    await gate.decide(action, { ...ctx, lastUserText: `use ${CREDENTIAL}`, session_id: `s-${CREDENTIAL}` });
    const serialized = JSON.stringify(seen);
    expect(seen).toHaveLength(1);
    expect(serialized).toContain('curl');
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain('RAW_JUSTIFICATION');
    expect(serialized).not.toContain('RAW_RESULT');
    expect(seen[0]?.argv).toBeUndefined();
    expect(seen[0]?.reviewer_reason).toContain('reviewer says uncertain');
  });

  it('never caches an escalated verdict: an identical action escalates again', async () => {
    const approvals = broker();
    const p = provider();
    const gate = createGate(config(), { providers: [p], audit, approvals });
    answer(approvals, 'allow');
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'allow', rule: 'human-approved' });
    answer(approvals, 'block');
    const second = await gate.decide(action, ctx);
    expect(second).toMatchObject({ outcome: 'block', rule: 'human-denied' });
    expect(second.cache_hit).toBeUndefined();
    expect(p.decide).toHaveBeenCalledTimes(2);
    expect(approvals.recent().map((item) => item.result)).toEqual(['block', 'allow']);
  });
});

describe('reviewer with human approval', () => {
  it('reviewer uncertain escalates; reviewer reason is redacted and stages are kept', async () => {
    const approvals = broker();
    const r = reviewer('uncertain');
    answer(approvals, 'allow');
    const gate = createGate(config(), { providers: [provider()], reviewer: r, audit, approvals });
    const verdict = await gate.decide(action, ctx);
    expect(verdict).toMatchObject({ outcome: 'allow', rule: 'human-approved', raw_outcome: 'uncertain' });
    expect(verdict.reasons[1]).toBe('reviewer-uncertain');
    expect(JSON.stringify(verdict)).not.toContain(CREDENTIAL);
    expect(verdict.stages?.map((stage) => stage.stage)).toEqual(['decision', 'review', 'human']);
    expect(verdict.cost_usd).toBeCloseTo(0.011);
    // Neither the human verdict nor the pre-human reviewer result is cached.
    answer(approvals, 'block');
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'human-denied' });
    expect(r.review).toHaveBeenCalledTimes(2);
  });

  it.each(['allow', 'block'] as const)('reviewer %s stays final and cached without a human', async (decision) => {
    const approvals = broker();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const r = reviewer(decision);
    const gate = createGate(config(), { providers: [provider()], reviewer: r, audit, approvals });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: decision, rule: 'llm-review' });
    expect((await gate.decide(action, ctx)).cache_hit).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(r.review).toHaveBeenCalledTimes(1);
  });

  it('invalid reviewer response still blocks without asking a human', async () => {
    const approvals = broker();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const gate = createGate(config(), { providers: [provider()], reviewer: reviewer('block', { invalid_response: true }), audit, approvals });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'llm-review-invalid' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('reviewer unavailable keeps the provider-failure path, not a human', async () => {
    const approvals = broker();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const gate = createGate(config(), { providers: [provider()], reviewer: { review: async () => { throw new Error('down'); } }, audit, approvals });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'provider-unavailable' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('without human approval, an uncertain reviewer verdict is an invalid (uncached) block', async () => {
    const cfg = config({ human_approval: { enabled: false } });
    const r = reviewer('uncertain');
    const gate = createGate(cfg, { providers: [provider()], reviewer: r, audit });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'llm-review-invalid' });
    await gate.decide(action, ctx);
    expect(r.review).toHaveBeenCalledTimes(2);
  });
});

describe('mode boundaries', () => {
  it('shadow mode never escalates and keeps the hypothetical gray-block', async () => {
    const cfg = config(); cfg.gate.mode = 'shadow';
    const approvals = broker();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const gate = createGate(cfg, { providers: [provider()], audit, approvals });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'gray-block' });
    const r = reviewer('uncertain');
    const reviewed = createGate(cfg, { providers: [provider()], reviewer: r, audit, approvals });
    expect(await reviewed.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'llm-review-invalid' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('disabled (no broker) preserves gray-block', async () => {
    const gate = createGate(config({ human_approval: { enabled: false } }), { providers: [provider()], audit });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'gray-block' });
    expect(gate.stats()).toMatchObject({ human_pending: 0, human_approved: 0, human_denied: 0, human_timeout: 0 });
  });

  it('clear model allow/block never reaches a human', async () => {
    const approvals = broker();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const gate = createGate(config(), { providers: [provider({ ...gray, destructive: 0.1 })], audit, approvals });
    expect(await gate.decide(action, ctx)).toMatchObject({ outcome: 'allow', rule: 'model-threshold' });
    const blocking = createGate(config(), { providers: [provider({ ...gray, destructive: 0.9 })], audit, approvals });
    expect(await blocking.decide(action, ctx)).toMatchObject({ outcome: 'block', rule: 'model-threshold' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('human-facing surfaces', () => {
  it.each(['human-denied', 'human-timeout', 'human-approval-unavailable', 'human-approval-aborted'])('explains %s without echoing agent text', (rule) => {
    const text = explanation({ outcome: 'block', rule, reasons: [rule, 'reviewer-uncertain', 'AGENT_TEXT'], latency_ms: 0, cost_usd: 0, policy_version: 'v' });
    expect(text).toMatch(/^\[auto-mode-proxy\] human approval|^\[auto-mode-proxy\] a human reviewer denied/);
    expect(text).not.toContain('AGENT_TEXT');
  });

  it('status surfaces human counters only when enabled', async () => {
    const stats = { decisions: 1, allow: 1, block: 0, uncertain: 1, cache_hits: 0, provider_failures: 0, provider_health: {},
      human_pending: 2, human_approved: 1, human_denied: 3, human_timeout: 4 };
    const enabled = await createStatus(config(), () => stats).response(new Headers(), '127.0.0.1').json() as { counters: Record<string, number> };
    expect(enabled.counters).toEqual({ allow: 1, block: 0, uncertain: 1, human_pending: 2, human_approved: 1, human_denied: 3, human_timeout: 4 });
    const disabled = await createStatus(config({ human_approval: { enabled: false } }), () => stats).response(new Headers(), '127.0.0.1').json() as { counters: Record<string, number> };
    expect(disabled.counters).toEqual({ allow: 1, block: 0, uncertain: 1 });
  });

  it('audit record accepts the human stage and redacts the approval token', () => {
    const cfg = config({ human_approval: { enabled: true, token: 'approval-token-secret' } });
    expect(collectConfigSecrets(cfg)).toContain('approval-token-secret');
    const record = createAuditRecord({ action: { ...action, text: 'echo approval-token-secret' }, verdict: { outcome: 'allow', reasons: ['human-approved'], rule: 'human-approved', latency_ms: 1,
      stages: [{ stage: 'human', provider: 'human', latency_ms: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0 }] } }, collectConfigSecrets(cfg));
    expect(JSON.stringify(record)).not.toContain('approval-token-secret');
    expect(record.stages).toEqual([{ stage: 'human', provider: 'human', latency_ms: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0 }]);
  });
});
