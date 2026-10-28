import { createParser, type EventSourceMessage } from 'eventsource-parser';

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;

/** A semantic sidecar. Forward raw, not a reconstruction of event/data. */
export interface SseFrame {
  readonly raw: Uint8Array;
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
  readonly complete: boolean;
}

export interface SseEvent {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
  readonly retry?: number;
}

/** Pull-based raw framing keeps at most one frame plus the current input chunk. */
export function parseSse(
  source: ReadableStream<Uint8Array>,
  options: { maxFrameBytes?: number } = {},
): ReadableStream<SseFrame> {
  const maximum = options.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_SSE_FRAME_BYTES) {
    throw new RangeError('SSE frame limit must be between 1 and 1048576 bytes');
  }
  const reader = source.getReader();
  let buffer = new Uint8Array(Math.min(4096, maximum));
  let length = 0;
  let lineLength = 0;
  let pendingCr = false;
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let ended = false;
  let stopped = false;
  let first = true;

  function append(byte: number): void {
    if (length === maximum) throw new RangeError('SSE frame exceeds byte limit');
    if (length === buffer.length) {
      const grown = new Uint8Array(Math.min(maximum, buffer.length * 2));
      grown.set(buffer);
      buffer = grown;
    }
    buffer[length++] = byte;
  }

  function finish(complete: boolean): SseFrame {
    const raw = buffer.slice(0, length);
    length = 0;
    let event: EventSourceMessage | undefined;
    if (complete) {
      // Decode only a complete raw frame: UTF-8 may span any input chunk.
      let text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);
      if (first && text.startsWith('\uFEFF')) text = text.slice(1);
      const parser = createParser({ onEvent(value) { event = value; } });
      // v3 defers a final CR until the following feed. The raw scanner has
      // already established that this CR terminates a complete blank line.
      parser.feed(text.endsWith('\r') ? `${text}\n` : text);
    }
    first = false;
    return Object.freeze({ raw, complete, ...event });
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
            if (blank) {
              controller.enqueue(finish(true));
              return;
            }
          }
          if (offset === chunk.length) {
            if (ended) {
              stopped = true;
              reader.releaseLock();
              if (length > 0) controller.enqueue(finish(false));
              controller.close();
              return;
            }
            const result = await reader.read();
            if (stopped) return;
            ended = result.done;
            chunk = result.value ?? new Uint8Array(0);
            offset = 0;
            continue;
          }
          const byte = chunk[offset++]!;
          append(byte);
          if (byte === 13) {
            pendingCr = true;
          } else if (byte === 10) {
            const blank = lineLength === 0;
            lineLength = 0;
            if (blank) {
              controller.enqueue(finish(true));
              return;
            }
          } else {
            lineLength++;
            if (first && length === 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
              lineLength = 0;
            }
          }
        }
      } catch (error) {
        if (!stopped) {
          stopped = true;
          controller.error(error);
          try { await reader.cancel(error); } finally { reader.releaseLock(); }
        }
      }
    },
    async cancel(reason) {
      if (stopped) return;
      stopped = true;
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
}

/** Only newly constructed semantic events are encoded; original frames stay raw. */
export function encodeSse(frame: SseFrame | SseEvent): Uint8Array {
  if ('raw' in frame) return frame.raw;
  const lines: string[] = [];
  for (const field of ['event', 'id'] as const) {
    const value = frame[field];
    if (value !== undefined) {
      if (/[\r\n]/u.test(value) || (field === 'id' && value.includes('\0'))) {
        throw new TypeError('Invalid SSE field');
      }
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
  format: Uint8Array | (() => Uint8Array) = new TextEncoder().encode(': ping\n\n'),
): {
  setHeld(held: boolean): void;
  wrap(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
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
    wrap(source) {
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
                controller.enqueue(next.value);
              }
              return;
            }
          } catch (error) {
            if (!stopped) {
              stopped = true;
              closed = true;
              changed();
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
          try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
      }, { highWaterMark: 0 });
    },
  };
}
