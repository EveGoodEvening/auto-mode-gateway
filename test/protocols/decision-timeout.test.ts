import { afterEach, describe, expect, it, vi } from 'vitest';
import anthropicScenes from '../fixtures/anthropic/scenes.json' with { type: 'json' };
import chatScenes from '../fixtures/chat/scenes.json' with { type: 'json' };
import responsesScenes from '../fixtures/responses/scenes.json' with { type: 'json' };
import { anthropicAdapter } from '../../src/protocols/anthropic/adapter.js';
import { chatAdapter } from '../../src/protocols/openai-chat/adapter.js';
import { responsesAdapter } from '../../src/protocols/openai-responses/adapter.js';
import { DECISION_TIMEOUT_MS, decisionTimeout } from '../../src/protocols/anthropic/safety.js';
import type { AdapterOptions, ProtocolAdapter } from '../../src/protocols/types.js';
import type { Verdict } from '../../src/gate/types.js';

type Event = Record<string, unknown>;
const HUMAN_TIMEOUT_MS = 600_000;
const EXTENDED = DECISION_TIMEOUT_MS + HUMAN_TIMEOUT_MS;

function verdict(outcome: Verdict['outcome'] = 'allow'): Verdict {
  return { outcome, reasons: ['inert fixture'], latency_ms: 0, cost_usd: 0, policy_version: 'fixture' };
}
function sse(text: string): Response {
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
function responsesEvents(item: Event): Event[] {
  const initial = { ...item, status: 'in_progress', arguments: '' };
  return [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: initial },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item: structuredClone(item) },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [structuredClone(item)], usage: responsesScenes.usage } },
  ];
}

interface Case { name: string; adapter: ProtocolAdapter; stream: boolean; response: () => Response }
const cases: Case[] = [
  { name: 'anthropic stream', adapter: anthropicAdapter, stream: true,
    response: () => sse((anthropicScenes.single as Event[]).map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')) },
  { name: 'anthropic nonstream', adapter: anthropicAdapter, stream: false, response: () => json(anthropicScenes.nonstream) },
  { name: 'chat stream', adapter: chatAdapter, stream: true,
    response: () => sse((chatScenes.single as Event[]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n') },
  { name: 'chat nonstream', adapter: chatAdapter, stream: false, response: () => json(chatScenes.nonstream) },
  { name: 'responses stream', adapter: responsesAdapter, stream: true,
    response: () => sse(responsesEvents(responsesScenes.exec).map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join('')) },
  { name: 'responses nonstream', adapter: responsesAdapter, stream: false,
    response: () => json({ id: 'resp_fixture', status: 'completed', output: [responsesScenes.exec], usage: responsesScenes.usage }) },
];

/** Holds every decision for `holdMs` of simulated time, then allows it. */
async function held(item: Case, holdMs: number, decisionTimeoutMs?: number) {
  const signals: AbortSignal[] = [];
  const pending: ((value: Verdict) => void)[] = [];
  const first = Promise.withResolvers<void>();
  const options: AdapterOptions = {
    signal: new AbortController().signal,
    holdKeepaliveMs: 5_000,
    ...(decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs }),
    onToolCall: (_call, _context, signal) => {
      signals.push(signal);
      first.resolve();
      const decision = Promise.withResolvers<Verdict>();
      pending.push(decision.resolve);
      return decision.promise;
    },
  };
  const text = item.adapter.transformResponse(item.response(), { stream: item.stream }, options).then(response => response.text());
  const settled = text.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  await vi.advanceTimersByTimeAsync(0);
  await first.promise;
  await vi.advanceTimersByTimeAsync(holdMs);
  // Release the held decision and any later sequential call in the same turn.
  for (let round = 0; round < 4; round++) {
    for (const resolve of pending.splice(0)) resolve(verdict('allow'));
    await vi.advanceTimersByTimeAsync(0);
  }
  return { result: await settled, signals };
}

afterEach(() => { vi.useRealTimers(); });

describe('decisionTimeout', () => {
  it('defaults to the 60s whole-turn deadline and ignores invalid overrides', () => {
    expect(decisionTimeout({})).toBe(60_000);
    expect(decisionTimeout({ decisionTimeoutMs: 0 })).toBe(60_000);
    expect(decisionTimeout({ decisionTimeoutMs: -1 })).toBe(60_000);
    expect(decisionTimeout({ decisionTimeoutMs: Number.NaN })).toBe(60_000);
    expect(decisionTimeout({ decisionTimeoutMs: Infinity })).toBe(60_000);
    expect(decisionTimeout({ decisionTimeoutMs: EXTENDED })).toBe(EXTENDED);
    // Node timers above 2^31-1 fire immediately; the override is capped instead.
    expect(decisionTimeout({ decisionTimeoutMs: 2 ** 40 })).toBe(2_147_483_647);
  });
});

describe.each(cases)('held human decision: $name', (item) => {
  it('is not aborted after 60s when decisionTimeoutMs covers the human wait', async () => {
    vi.useFakeTimers();
    const { result, signals } = await held(item, 5 * 60_000, EXTENDED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('[auto-mode-proxy]');
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal.aborted).toBe(false);
    if (item.stream) {
      // Keepalives continue for the full hold, not just the first 60s.
      const pings = result.value.match(/ping/g)?.length ?? 0;
      expect(pings).toBeGreaterThanOrEqual(55);
    }
  });

  it('keeps the 60s default deadline when no override is supplied', async () => {
    vi.useFakeTimers();
    const { result, signals } = await held(item, DECISION_TIMEOUT_MS + 1);
    expect(result.ok).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('still fails closed when the hold exceeds the extended deadline', async () => {
    vi.useFakeTimers();
    const { result, signals } = await held(item, 90_001, 90_000);
    expect(result.ok).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
  });
});

function responsesTwoEvents(first: Event, second: Event): Event[] {
  const events: Event[] = [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } }];
  [first, second].forEach((item, index) => {
    events.push(
      { type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: item.arguments },
      { type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments },
      { type: 'response.output_item.done', output_index: index, item: structuredClone(item) },
    );
  });
  events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [structuredClone(first), structuredClone(second)], usage: responsesScenes.usage } });
  return events;
}
const secondExec = { ...responsesScenes.exec, id: 'fc_exec_2', call_id: 'call_exec_2' };
const anthropicTwo = { ...anthropicScenes.nonstream, content: [...anthropicScenes.nonstream.content,
  { type: 'tool_use', id: 'tool_n2', name: 'Bash', input: { command: 'echo second' } }] };
const twoCallCases: Case[] = [
  { name: 'anthropic stream', adapter: anthropicAdapter, stream: true,
    response: () => sse((anthropicScenes.parallel as Event[]).map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')) },
  { name: 'anthropic nonstream', adapter: anthropicAdapter, stream: false, response: () => json(anthropicTwo) },
  { name: 'chat stream', adapter: chatAdapter, stream: true,
    response: () => sse((chatScenes.multiple as Event[]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n') },
  { name: 'chat nonstream', adapter: chatAdapter, stream: false, response: () => json(chatScenes.nonstream) },
  { name: 'responses stream', adapter: responsesAdapter, stream: true,
    response: () => sse(responsesTwoEvents(responsesScenes.exec, secondExec).map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join('')) },
  { name: 'responses nonstream', adapter: responsesAdapter, stream: false,
    response: () => json({ id: 'resp_fixture', status: 'completed', output: [responsesScenes.exec, secondExec], usage: responsesScenes.usage }) },
];

/** Each sequential decision in the turn is held for `holdMs` before being allowed. */
async function heldEach(item: Case, holdMs: number, extra: Partial<AdapterOptions>) {
  const signals: AbortSignal[] = [];
  const pending: ((value: Verdict) => void)[] = [];
  const options: AdapterOptions = {
    signal: new AbortController().signal,
    holdKeepaliveMs: 5_000,
    ...extra,
    onToolCall: (_call, _context, signal) => {
      signals.push(signal);
      const decision = Promise.withResolvers<Verdict>();
      pending.push(decision.resolve);
      return decision.promise;
    },
  };
  const text = item.adapter.transformResponse(item.response(), { stream: item.stream }, options).then(response => response.text());
  const settled = text.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  let done = false;
  void settled.then(() => { done = true; });
  for (let call = 0; call < 2 && !done; call++) {
    for (let round = 0; round < 20 && pending.length === 0 && !done; round++) await vi.advanceTimersByTimeAsync(0);
    if (done) break;
    await vi.advanceTimersByTimeAsync(holdMs);
    for (const resolve of pending.splice(0)) resolve(verdict('allow'));
    await vi.advanceTimersByTimeAsync(0);
  }
  return { result: await settled, signals };
}

describe('decisionTimeout per-call extension', () => {
  it('adds one extension per additional call and stays capped', async () => {
    const { turnDecisionTimeout } = await import('../../src/protocols/anthropic/safety.js');
    expect(turnDecisionTimeout({ decisionTimeoutMs: EXTENDED, decisionExtensionMs: HUMAN_TIMEOUT_MS }, 1)).toBe(EXTENDED);
    expect(turnDecisionTimeout({ decisionTimeoutMs: EXTENDED, decisionExtensionMs: HUMAN_TIMEOUT_MS }, 3)).toBe(EXTENDED + 2 * HUMAN_TIMEOUT_MS);
    expect(turnDecisionTimeout({ decisionTimeoutMs: EXTENDED }, 3)).toBe(EXTENDED);
    expect(turnDecisionTimeout({ decisionExtensionMs: -5 }, 3)).toBe(DECISION_TIMEOUT_MS);
    expect(turnDecisionTimeout({ decisionTimeoutMs: EXTENDED, decisionExtensionMs: 2 ** 40 }, 2)).toBe(2_147_483_647);
  });
});

describe.each(twoCallCases)('two sequential human decisions in one turn: $name', (item) => {
  const HOLD = 9.5 * 60_000;
  it('gives each escalated call its own human budget', async () => {
    vi.useFakeTimers();
    const { result, signals } = await heldEach(item, HOLD, { decisionTimeoutMs: EXTENDED, decisionExtensionMs: HUMAN_TIMEOUT_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('[auto-mode-proxy]');
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal.aborted).toBe(false);
  });

  it('fails closed with a single shared human budget (no extension)', async () => {
    vi.useFakeTimers();
    const { result } = await heldEach(item, HOLD, { decisionTimeoutMs: EXTENDED });
    expect(result.ok).toBe(false);
  });

  it('still fails closed once the per-call budgets are exhausted', async () => {
    vi.useFakeTimers();
    const { result } = await heldEach(item, 11 * 60_000, { decisionTimeoutMs: EXTENDED, decisionExtensionMs: HUMAN_TIMEOUT_MS });
    expect(result.ok).toBe(false);
  });
});
