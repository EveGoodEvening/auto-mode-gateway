import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { ResponseBudget, type ResponseReservation } from './response-budget.js';
import { JsonRetentionScanner, type JsonRetentionProtocol } from './json-retention.js';

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const EMPTY_BYTES = new Uint8Array(0);
const DATA_NEWLINE = new Uint8Array([10]);
const KEEPALIVE_FRAME = new TextEncoder().encode(': ping\n\n');

/** Semantic strings and raw allocation have separate, explicitly transferred lifetimes. */
export interface SseFrame {
  readonly raw: Uint8Array;
  readonly event?: string | undefined;
  readonly data?: string | undefined;
  readonly id?: string | undefined;
  readonly complete: boolean;
  releaseSemantic(): void;
  release(): void;
}

export interface SseEvent {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
  readonly retry?: number;
}

/** Zero-copy data fields with exactly the semantic LF joining used by SSE. */
export function* sseDataSegments(raw: Uint8Array): Iterable<Uint8Array> {
  let cursor = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  let first = true;
  while (cursor < raw.length) {
    const start = cursor;
    while (cursor < raw.length && raw[cursor] !== 10 && raw[cursor] !== 13) cursor++;
    const end = cursor;
    if (raw[cursor++] === 13 && raw[cursor] === 10) cursor++;
    if (end - start < 4 || raw[start] !== 100 || raw[start + 1] !== 97 || raw[start + 2] !== 116 || raw[start + 3] !== 97) continue;
    if (end - start !== 4 && raw[start + 4] !== 58) continue;
    let value = Math.min(end, start + 5);
    if (raw[value] === 32) value++;
    if (!first) yield DATA_NEWLINE;
    first = false;
    yield raw.subarray(value, end);
  }
}

/** Exact JSON spelling/duplicate semantics; uncertainty keeps the whole frame reserved. */
export function sseReasoningBytes(raw: Uint8Array, protocol: JsonRetentionProtocol, reasoningIndex?: (index: number) => boolean | undefined, budget?: ResponseBudget, partialPrefix = false): number {
  const metadata = budget?.reserve(256);
  const preview = new Map<number, boolean>();
  let total = 0;
  let frameStart = 0;
  let cursor = 0;
  let first = true;
  try {
    while (cursor < raw.length) {
      const lineStart = cursor;
      while (cursor < raw.length && raw[cursor] !== 10 && raw[cursor] !== 13) cursor++;
      if (cursor === raw.length) break;
      const lineEnd = cursor;
      if (raw[cursor++] === 13 && raw[cursor] === 10) cursor++;
      const bomBlank = lineStart === 0 && lineEnd === 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      if (lineStart !== lineEnd && !bomBlank) continue;
      const frame = raw.subarray(frameStart, cursor);
      if (first && partialPrefix) total += frame.byteLength;
      else {
        const scanner = new JsonRetentionScanner(protocol, 'event', budget);
        let dataBytes = 0;
        try {
          for (const segment of sseDataSegments(frame)) { dataBytes += segment.byteLength; scanner.push(segment); }
          const info = scanner.finish();
          if (dataBytes) {
            if (!info.complete || info.ambiguous) total += frame.byteLength;
            else {
              const lifecycle = protocol === 'responses'
                ? info.type === 'response.output_item.added' || info.type === 'response.output_item.done'
                : info.type === 'content_block_start';
              if (lifecycle && info.outputIndex !== undefined && info.itemType !== undefined) {
                const known = preview.get(info.outputIndex) ?? reasoningIndex?.(info.outputIndex);
                if (!preview.has(info.outputIndex)) metadata?.resize(metadata.bytes + 128);
                preview.set(info.outputIndex, known === true || ['thinking', 'redacted_thinking', 'signature', 'reasoning'].includes(info.itemType));
              }
              const indexed = info.outputIndex === undefined ? false : preview.get(info.outputIndex) ?? reasoningIndex?.(info.outputIndex);
              const text = info.type === 'response.output_text.delta' || info.type === 'response.output_text.done'
                || ((info.type === 'response.content_part.added' || info.type === 'response.content_part.done') && info.partType === 'output_text');
              if (info.type?.includes('reasoning') || ['thinking', 'redacted_thinking', 'signature', 'reasoning'].includes(info.itemType ?? '')
                || ['thinking_delta', 'redacted_thinking_delta', 'signature_delta', 'reasoning_text'].includes(info.partType ?? '')
                || indexed === true || (info.outputIndex !== undefined && indexed === undefined && !text)) total += frame.byteLength;
              else total += Math.min(frame.byteLength, info.reasoningBytes + info.pendingBytes);
            }
          }
        } finally { scanner.finish(); }
      }
      first = false;
      frameStart = cursor;
    }
    return total + raw.length - frameStart;
  } finally { preview.clear(); metadata?.release(); }
}

/** Bound both retained UTF-16 strings and nonfatal UTF-8 replacement expansion. */
export function decodedStringBytes(raw: Uint8Array): number {
  let units = 0;
  let encoded = 0;
  for (let index = 0; index < raw.length;) {
    const byte = raw[index]!;
    if (byte < 128) { units++; encoded++; index++; continue; }
    const size = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
    let valid = size > 0 && index + size <= raw.length;
    for (let part = 1; valid && part < size; part++) valid = (raw[index + part]! & 0xc0) === 0x80;
    const second = raw[index + 1] ?? 0;
    if ((byte === 0xe0 && second < 0xa0) || (byte === 0xed && second >= 0xa0) || (byte === 0xf0 && second < 0x90) || (byte === 0xf4 && second >= 0x90)) valid = false;
    if (valid) { units += size === 4 ? 2 : 1; encoded += size; index += size; }
    else { units++; encoded += 3; index++; }
  }
  return Math.max(units * 2, encoded);
}

/** Pull-based framing reserves every allocation before copying, decoding or constructing data. */
export function parseSse(source: ReadableStream<Uint8Array>, options: {
  maxFrameBytes?: number;
  budget?: ResponseBudget;
  classifyReasoning?: (raw: Uint8Array, partialPrefix?: boolean) => number;
  potentialReasoning?: boolean;
} = {}): ReadableStream<SseFrame> {
  const maximum = options.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_SSE_FRAME_BYTES) throw new RangeError('SSE frame limit must be between 1 and 1048576 bytes');
  const budget = options.budget ?? new ResponseBudget(8 * 1024 * 1024, 4 * 1024 * 1024);
  const managed = options.budget !== undefined;
  const reader = source.getReader();
  let buffer: Uint8Array = EMPTY_BYTES;
  let scratch: ResponseReservation | undefined;
  let input: ResponseReservation | undefined;
  let length = 0;
  let lineLength = 0;
  let pendingCr = false;
  let chunk: Uint8Array = EMPTY_BYTES;
  let offset = 0;
  let ended = false;
  let stopped = false;
  let first = true;
  let scratchPotential = false;
  let readerReleased = false;
  const releaseReader = (): void => { if (!readerReleased) { readerReleased = true; reader.releaseLock(); } };

  function releaseInput(): void { chunk = EMPTY_BYTES; input?.release(); input = undefined; offset = 0; }
  function cleanup(): void { releaseInput(); buffer = EMPTY_BYTES; scratch?.release(); scratch = undefined; if (!managed) budget.close(); }
  function append(byte: number): void {
    if (length === maximum) throw new RangeError('SSE frame exceeds byte limit');
    if (length === buffer.length) {
      const capacity = Math.min(maximum, Math.max(128, buffer.length * 2));
      if (!scratch) scratchPotential = options.potentialReasoning === true && (input?.reasoning ?? 0) > 0;
      const grownLease = budget.reserve(capacity, scratchPotential ? capacity : 0);
      let grown: Uint8Array;
      try { grown = new Uint8Array(capacity); grown.set(buffer); }
      catch (error) { grownLease.release(); throw error; }
      buffer = grown;
      scratch?.release();
      scratch = grownLease;
    }
    buffer[length++] = byte;
  }

  function finish(complete: boolean): SseFrame {
    if (!scratch) throw new Error('Missing SSE allocation');
    if (offset === chunk.length) releaseInput();
    const raw = buffer.subarray(0, length);
    const reasoning = options.classifyReasoning?.(raw) ?? (options.potentialReasoning ? raw.byteLength : 0);
    scratch.resize(buffer.byteLength + 256, reasoning);
    const rawLease = scratch;
    budget.registerBytes(raw, rawLease);
    scratch = undefined;
    buffer = EMPTY_BYTES;
    length = 0;
    let event: EventSourceMessage | undefined;
    let semantic: ResponseReservation | undefined;
    let temporary: ResponseReservation | undefined;
    try {
      if (complete) {
        const decoded = decodedStringBytes(raw);
        const subset = reasoning >= raw.byteLength ? decoded : Math.min(decoded, reasoning * 2);
        semantic = budget.reserve(decoded * 2, subset * 2);
        let dataLines = 0;
        for (const segment of sseDataSegments(raw)) { if (segment !== DATA_NEWLINE) dataLines++; }
        const extra = (dataLines > 1 ? decoded : 0) + (raw.at(-1) === 13 ? decoded : 0) + 4096;
        temporary = budget.reserve(extra, reasoning ? Math.min(extra, (dataLines > 1 ? subset : 0) + (raw.at(-1) === 13 ? subset : 0) + 4096) : 0);
        const skipBom = first && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
        const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(skipBom ? raw.subarray(3) : raw);
        const parser = createParser({ onEvent(value) { event = value; } });
        parser.feed(text.endsWith('\r') ? `${text}\n` : text);
        temporary.release();
        temporary = undefined;
      }
      first = false;
      const frame: SseFrame = Object.freeze({
        raw, complete,
        get event() { return event?.event; },
        get data() { return event?.data; },
        get id() { return event?.id; },
        releaseSemantic() { event = undefined; semantic?.release(); semantic = undefined; },
        release() { event = undefined; semantic?.release(); semantic = undefined; rawLease.release(); },
      });
      if (!managed) { semantic?.release(); rawLease.release(); }
      return frame;
    } catch (error) { event = undefined; temporary?.release(); semantic?.release(); rawLease.release(); throw error; }
  }

  return new ReadableStream<SseFrame>({
    async pull(controller) {
      try {
        while (!stopped) {
          if (pendingCr && (offset < chunk.length || ended)) {
            pendingCr = false;
            if (offset < chunk.length && chunk[offset] === 10) append(chunk[offset++]!);
            const blank = lineLength === 0;
            lineLength = 0;
            if (blank) { controller.enqueue(finish(true)); return; }
          }
          if (offset === chunk.length) {
            releaseInput();
            if (ended) {
              const frame = length > 0 ? finish(false) : undefined;
              stopped = true;
              releaseReader();
              cleanup();
              if (frame) controller.enqueue(frame);
              controller.close(); return;
            }
            const result = await reader.read();
            if (stopped) return;
            ended = result.done;
            if (result.value) {
              input = budget.claimBytes(result.value);
              if (options.potentialReasoning) {
                const reasoning = options.classifyReasoning?.(result.value, length > 0) ?? result.value.byteLength;
                input.resize(input.bytes, reasoning);
              }
              chunk = result.value;
            }
            offset = 0;
            continue;
          }
          const byte = chunk[offset++]!;
          append(byte);
          if (byte === 13) pendingCr = true;
          else if (byte === 10) {
            const blank = lineLength === 0; lineLength = 0;
            if (blank) { controller.enqueue(finish(true)); return; }
          } else {
            lineLength++;
            if (first && length === 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) lineLength = 0;
          }
        }
      } catch (error) {
        if (!stopped) { stopped = true; cleanup(); controller.error(error); try { await reader.cancel(error); } catch { /* Original failure wins. */ } finally { releaseReader(); } }
      }
    },
    async cancel(reason) { if (stopped) return; stopped = true; cleanup(); try { await reader.cancel(reason); } catch { /* Cancellation remains terminal. */ } finally { releaseReader(); } },
  }, { highWaterMark: 0 });
}

/** A semantic field may never introduce another SSE line or frame. */
export function assertSseField(field: 'event' | 'id', value: unknown): asserts value is string {
  if (typeof value !== 'string' || /[\r\n]/u.test(value) || (field === 'id' && value.includes('\0'))) throw new TypeError('Invalid SSE field');
}

/** Only newly constructed semantic events are encoded; original frames stay raw. */
export function encodeSse(frame: SseFrame | SseEvent): Uint8Array {
  if ('raw' in frame) return frame.raw;
  const lines: string[] = [];
  for (const field of ['event', 'id'] as const) {
    const value = frame[field];
    if (value !== undefined) {
      assertSseField(field, value);
      lines.push(`${field}: ${value}`);
    }
  }
  if (frame.retry !== undefined) {
    if (!Number.isSafeInteger(frame.retry) || frame.retry < 0) throw new TypeError('Invalid SSE retry');
    lines.push(`retry: ${frame.retry}`);
  }
  if (frame.data !== undefined) {
    for (const line of frame.data.split(/\r\n|\r|\n/u)) lines.push(`data: ${line}`);
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n\n`);
}

/** Wrap the final serialized byte stream; ticks never accumulate without demand. */
export function pingKeepalive(
  intervalMs: number,
  format: Uint8Array | (() => Uint8Array) = KEEPALIVE_FRAME,
): {
  setHeld(held: boolean): void;
  wrap(source: ReadableStream<Uint8Array>, ownership?: { delivered(bytes: Uint8Array): void; discarded(bytes: Uint8Array): void }): ReadableStream<Uint8Array>;
  close(): void;
} {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('Invalid keepalive interval');
  let held = false;
  let closed = false;
  let wrapped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const changed = () => { clear(); wake?.(); wake = undefined; };
  return {
    setHeld(value) { held = value; changed(); },
    close() { closed = true; held = false; changed(); },
    wrap(source, ownership) {
      if (wrapped || closed) throw new TypeError('Keepalive wrapper is single-use');
      wrapped = true;
      const reader = source.getReader();
      let stopped = false;
      let reading = false;
      let result: ReadableStreamReadResult<Uint8Array> | undefined;
      let failure: { error: unknown } | undefined;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (!stopped) {
              const signal = Promise.withResolvers<'changed' | 'ping'>();
              wake = () => signal.resolve('changed');
              if (!reading && result === undefined && failure === undefined) {
                reading = true;
                void reader.read().then((value) => {
                  reading = false;
                  if (stopped) { if (!value.done) ownership?.discarded(value.value); return; }
                  result = value;
                  wake?.();
                }, (error: unknown) => {
                  reading = false;
                  failure = { error };
                  wake?.();
                });
              }
              if (failure !== undefined) throw failure.error;
              if (result === undefined) {
                if (held && !closed) timer = setTimeout(() => signal.resolve('ping'), intervalMs);
                const reason = await signal.promise;
                clear();
                wake = undefined;
                if (stopped) return;
                if (reason !== 'ping' || !held || closed) continue;
                controller.enqueue(typeof format === 'function' ? format() : format);
                return;
              }
              const next = result;
              result = undefined;
              wake = undefined;
              if (next.done) {
                stopped = true;
                closed = true;
                reader.releaseLock();
                controller.close();
              } else {
                try { controller.enqueue(next.value); ownership?.delivered(next.value); }
                catch (error) { ownership?.discarded(next.value); throw error; }
              }
              return;
            }
          } catch (error) {
            if (!stopped) {
              stopped = true;
              closed = true;
              changed();
              if (result && !result.done) ownership?.discarded(result.value);
              result = undefined;
              controller.error(error);
              try { await reader.cancel(error); } finally { reader.releaseLock(); }
            }
          }
        },
        async cancel(reason) {
          if (stopped) return;
          stopped = true;
          closed = true;
          changed();
          if (result && !result.done) ownership?.discarded(result.value);
          result = undefined;
          try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
      }, { highWaterMark: 0 });
    },
  };
}
