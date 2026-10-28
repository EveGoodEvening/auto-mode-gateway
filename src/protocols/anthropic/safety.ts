import { parse as parsePartial } from 'partial-json';
import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import type { Verdict } from '../../gate/types.js';

export const MAX_TOOL_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Thinking remains byte-transparent until a real upstream compatibility error supplies evidence.
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
  const probabilities = verdict.probabilities ? Object.entries(verdict.probabilities).map(([name, probability]) => `${name}=${probability}`).join(', ') : '';
  return `[auto-mode-proxy] ${[verdict.rule, ...verdict.reasons, probabilities].filter(Boolean).join('; ').slice(0, 4096) || 'tool execution blocked'}`;
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
  return new TextEncoder().encode(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`);
}

/** Observations are capped and detached: shadow never delays or changes original delivery. */
export function shadowStream(source: ReadableStream<Uint8Array>, observe: (bytes: Uint8Array<ArrayBuffer>) => Promise<unknown>, trackObservation?: (work: Promise<void>) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          if (!overflow) {
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            chunks = [];
            const work = Promise.resolve().then(() => observe(bytes)).then(() => {}, () => {});
            try { trackObservation?.(work); } catch { /* Observation bookkeeping cannot change shadow delivery. */ }
          }
          controller.close();
          return;
        }
        size += item.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { overflow = true; chunks = []; }
        else if (!overflow) chunks.push(item.value.slice());
        controller.enqueue(item.value);
      } catch (error) { chunks = []; controller.error(error); }
    },
    async cancel(reason) { chunks = []; await reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

export function unique(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new AnthropicResponseError('Duplicate tool ID');
    ids.add(call.id);
  }
}
