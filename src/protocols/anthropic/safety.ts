import { parse as parsePartial } from 'partial-json';
import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import type { Verdict } from '../../gate/types.js';
import type { Answers } from '../../decision/types.js';
import { ResponseBudget, type ResponseReservation } from '../response-budget.js';
import { assertSseField } from '../sse.js';

export const MAX_TOOL_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Early thinking passes through; ordered suffix retention shares this subset cap, without stripping.
export const MAX_REASONING_BYTES = 4 * 1024 * 1024;
export const IDLE_TIMEOUT_MS = 30_000;
export const COMPLETION_TIMEOUT_MS = 60_000;
export const DECISION_TIMEOUT_MS = 60_000;

export class AnthropicResponseError extends Error {
  readonly blocked = true;
  constructor(message: string, readonly parseStatus?: 'unparseable', readonly diagnostic?: unknown) {
    super(message);
    this.name = 'AnthropicResponseError';
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseToolInput(json: string): unknown {
  try {
    const input: unknown = JSON.parse(json);
    if (!record(input)) throw new Error('Tool input must be an object');
    return input;
  } catch {
    let diagnostic: unknown;
    try { diagnostic = parsePartial(json); } catch { /* Diagnostics never authorize execution. */ }
    throw new AnthropicResponseError('Unparseable tool input', 'unparseable', diagnostic);
  }
}

/** Validates a tool block and returns its serialized input size for retention accounting. */
export function validateToolBlock(block: Record<string, unknown>): number {
  if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
    throw new AnthropicResponseError('Invalid tool identity');
  }
  if (!record(block.input)) throw new AnthropicResponseError('Unparseable tool input', 'unparseable');
  const bytes = new TextEncoder().encode(JSON.stringify(block.input)).byteLength;
  if (bytes > MAX_TOOL_BYTES) throw new AnthropicResponseError('Tool input exceeds 1 MiB');
  return bytes;
}

export function toolCall(block: Record<string, unknown>): ToolCall {
  validateToolBlock(block);
  return { id: block.id as string, name: block.name as string, input: block.input, raw: block };
}

/** Races are always cleaned up, including disconnects while an upstream read is pending. */
export async function bounded<T>(work: Promise<T>, milliseconds: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted || milliseconds <= 0) {
    void work.catch(() => undefined);
    throw signal.aborted ? signal.reason ?? new AnthropicResponseError('Response cancelled') : new AnthropicResponseError('Response deadline exceeded');
  }
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new AnthropicResponseError('Response deadline exceeded')), Math.max(0, milliseconds));
  const abort = () => deadline.reject(signal.reason ?? new AnthropicResponseError('Response cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function decide(calls: readonly ToolCall[], context: RequestContext, options: AdapterOptions): Promise<Map<string, Verdict>> {
  const results = new Map<string, Verdict>();
  if (!calls.length) return results;
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new AnthropicResponseError('Decision deadline exceeded')), DECISION_TIMEOUT_MS);
  try {
    // Sequential work bounds in-flight providers and shares a single whole-turn deadline.
    for (const call of calls) results.set(call.id, await bounded(Promise.resolve().then(() => options.onToolCall(call, context, signal)), DECISION_TIMEOUT_MS, signal));
    return results;
  } finally {
    clearTimeout(timer);
  }
}

export function explanation(verdict: Verdict): string {
  if (verdict.rule === 'provider-unavailable' || verdict.rule === 'decision-timeout') return '[auto-mode-proxy] decision providers unavailable';
  let text = '';
  const append = (value: string): void => {
    text += value.slice(0, Math.max(0, 4096 - text.length));
  };
  // Preserve the existing joined-prefix format without first allocating an unbounded full join.
  if (verdict.rule) append(verdict.rule);
  for (const part of verdict.reasons) {
    if (!part) continue;
    if (text) append('; ');
    append(part);
    if (text.length === 4096) break;
  }
  if (text.length < 4096 && verdict.probabilities) {
    let first = true;
    for (const name in verdict.probabilities) {
      if (!Object.hasOwn(verdict.probabilities, name)) continue;
      if (first) { if (text) append('; '); first = false; }
      else append(', ');
      append(name);
      append('=');
      append(String(verdict.probabilities[name as keyof Answers]));
      if (text.length === 4096) break;
    }
  }
  return `[auto-mode-proxy] ${text || 'tool execution blocked'}`;
}

export function blockedText(call: ToolCall, verdict: Verdict): string {
  return `${explanation(verdict)}. Tool ${call.name.slice(0, 256)} was blocked. Review the operation and execute it manually only if appropriate.`;
}

/** One authoritative schema for native streaming and nonstreaming results. */
export function safeguardResults(calls: readonly ToolCall[], decisions: ReadonlyMap<string, Verdict>): unknown[] {
  const toolUses: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const call of calls) {
    const verdict = decisions.get(call.id)!;
    toolUses[call.id] = verdict.outcome === 'allow' ? { type: 'evaluated', outcome: 'not_flagged' }
      : { type: 'evaluated', outcome: 'flagged', explanation: explanation(verdict) };
  }
  return [{ type: 'dangerous_tool_use', status: { type: 'available', tool_uses: toolUses } }];
}

export function encodeEvent(value: Record<string, unknown>): Uint8Array {
  const type = value.type;
  assertSseField('event', type);
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
}

/** Observations are capped and detached: shadow never delays or changes original delivery. */
export function shadowStream(source: ReadableStream<Uint8Array>, observe: (source: ReadableStream<Uint8Array>, budget: ResponseBudget, signal: AbortSignal) => Promise<unknown>, trackObservation?: (work: Promise<void>) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let readerReleased = false;
  const releaseReader = (): void => { if (!readerReleased) { readerReleased = true; reader.releaseLock(); } };
  const budget = new ResponseBudget(MAX_RESPONSE_BYTES, MAX_REASONING_BYTES);
  budget.reserve(1024);
  const cancellation = new AbortController();
  const queue = new Map<number, Uint8Array>();
  let head = 0;
  let tail = 0;
  let queuedBytes = 0;
  let ended = false;
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = (reason: unknown): void => {
    if (stopped) return;
    stopped = true;
    cancellation.abort(reason);
    for (const [index, bytes] of queue) {
      queue.delete(index);
      queuedBytes -= bytes.byteLength;
      budget.releaseBytes(bytes);
    }
    wake?.();
    wake = undefined;
  };
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!queue.size && !ended && !stopped) {
        const notification = Promise.withResolvers<void>();
        wake = notification.resolve;
        await notification.promise;
      }
      if (stopped) { controller.error(cancellation.signal.reason); return; }
      const bytes = queue.get(head);
      if (bytes) { queue.delete(head++); queuedBytes -= bytes.byteLength; controller.enqueue(bytes); }
      else controller.close();
    },
    cancel(reason) { stop(reason); },
  }, { highWaterMark: 0 });
  const work = Promise.resolve().then(() => observe(observed, budget, cancellation.signal)).then(() => {}, () => {}).finally(() => {
    stop(new AnthropicResponseError('Shadow observation ended'));
    budget.close();
  });
  try { trackObservation?.(work); } catch { /* Bookkeeping cannot affect delivery. */ }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let original: ResponseReservation | undefined;
      try {
        const item = await reader.read();
        if (item.done) {
          ended = true;
          wake?.();
          wake = undefined;
          releaseReader();
          controller.close();
          return;
        }
        if (!stopped) {
          let copied: ResponseReservation | undefined;
          try {
            if (queuedBytes + item.value.byteLength > MAX_RESPONSE_BYTES / 2) throw new AnthropicResponseError('Shadow observer too slow');
            original = budget.reserve(item.value.byteLength, item.value.byteLength);
            copied = budget.reserve(item.value.byteLength + 256, item.value.byteLength);
            const bytes = item.value.slice();
            budget.registerBytes(bytes, copied);
            queue.set(tail++, bytes);
            queuedBytes += bytes.byteLength;
            copied = undefined;
            wake?.();
            wake = undefined;
          } catch (error) {
            copied?.release();
            stop(error);
          }
        }
        controller.enqueue(item.value);
      } catch (error) {
        stop(error); controller.error(error);
        if (!readerReleased) { try { await reader.cancel(error); } catch { /* Preserve the delivery failure. */ } finally { releaseReader(); } }
      }
      finally { original?.release(); }
    },
    async cancel(reason) { stop(reason); if (!readerReleased) { try { await reader.cancel(reason); } catch { /* Cancellation is terminal. */ } finally { releaseReader(); } } },
  }, { highWaterMark: 0 });
}

export function unique(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new AnthropicResponseError('Duplicate tool ID');
    ids.add(call.id);
  }
}
