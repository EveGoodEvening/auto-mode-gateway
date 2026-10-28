import { parse as parsePartial } from 'partial-json';
import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';

export const MAX_TOOL_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Transparent C05 thinking is never held. Any later compatibility buffer shares this cap.
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

export function toolCall(block: Record<string, unknown>): ToolCall {
  if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
    throw new AnthropicResponseError('Invalid tool identity');
  }
  if (!record(block.input)) throw new AnthropicResponseError('Unparseable tool input', 'unparseable');
  const bytes = new TextEncoder().encode(JSON.stringify(block.input)).byteLength;
  if (bytes > MAX_TOOL_BYTES) throw new AnthropicResponseError('Tool input exceeds 1 MiB');
  return { id: block.id, name: block.name, input: block.input, raw: block };
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

export async function approve(calls: readonly ToolCall[], context: RequestContext, options: AdapterOptions): Promise<void> {
  if (!calls.length) return;
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new AnthropicResponseError('Decision deadline exceeded')), DECISION_TIMEOUT_MS);
  try {
    const verdict = await bounded(Promise.resolve().then(() => options.onToolCalls(calls, context, signal)), DECISION_TIMEOUT_MS, signal);
    if (verdict !== 'allow') throw new AnthropicResponseError('Tool response blocked');
  } finally {
    clearTimeout(timer);
  }
}

export function unique(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new AnthropicResponseError('Duplicate tool ID');
    ids.add(call.id);
  }
}
