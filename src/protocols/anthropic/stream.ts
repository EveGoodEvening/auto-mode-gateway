import { parseSse } from '../sse.js';
import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { AnthropicResponseError, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, approve, bounded, parseToolInput, record, toolCall, unique } from './safety.js';

interface PendingTool {
  block: Record<string, unknown>;
  fragments: string[];
  bytes: number;
}

/** Execution bytes stay private through EOF, complete JSON, and whole-response ID uniqueness. */
export function transformAnthropicStream(source: ReadableStream<Uint8Array>, context: RequestContext, options: AdapterOptions): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  const upstream = source.getReader();
  let deadline = Infinity;
  let lastByteAt = Date.now();
  const timedSource = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await bounded(upstream.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByteAt), deadline - Date.now()), signal);
        if (item.done) controller.close();
        else {
          if (item.value.byteLength) lastByteAt = Date.now();
          controller.enqueue(item.value);
        }
      } catch (error) {
        controller.error(error);
        void upstream.cancel(error).catch(() => undefined);
      }
    },
    cancel(reason) { return upstream.cancel(reason); },
  }, { highWaterMark: 0 });
  const frames = parseSse(timedSource).getReader();
  const active = new Map<number, PendingTool>();
  const indices = new Set<number>();
  const ids = new Set<string>();
  const calls: ToolCall[] = [];
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let hasTools = false;
  let stopped = false;
  let finished = false;
  let releaseIndex = 0;
  let completionTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  function hold(raw: Uint8Array): void {
    heldBytes += raw.byteLength;
    if (heldBytes > MAX_RESPONSE_BYTES) throw new AnthropicResponseError('Held response exceeds 8 MiB');
    held.push(raw);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortListener = () => {
        clearTimeout(completionTimer);
        controller.error(signal.reason ?? new AnthropicResponseError('Response cancelled'));
        void frames.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    },
    async pull(controller) {
      try {
        if (signal.aborted) throw signal.reason ?? new AnthropicResponseError('Response cancelled');
        if (finished) {
          const raw = held[releaseIndex++];
          if (raw) controller.enqueue(raw);
          else {
            if (abortListener) signal.removeEventListener('abort', abortListener);
            controller.close();
          }
          return;
        }
        while (true) {
          const item = await frames.read();
          if (item.done) {
            if (active.size) {
              for (const pending of active.values()) {
                if (pending.fragments.length) parseToolInput(pending.fragments.join(''));
              }
              throw new AnthropicResponseError('Incomplete tool response at EOF', 'unparseable');
            }
            if (hasTools && !stopped) throw new AnthropicResponseError('Incomplete tool response at EOF', 'unparseable');
            clearTimeout(completionTimer);
            unique(calls);
            await approve(calls, context, { ...options, signal });
            finished = true;
            const raw = held[releaseIndex++];
            if (raw) controller.enqueue(raw);
            else {
              if (abortListener) signal.removeEventListener('abort', abortListener);
              controller.close();
            }
            return;
          }
          const frame = item.value;
          if (!frame.complete) throw new AnthropicResponseError('Incomplete SSE frame at EOF', 'unparseable');
          if (frame.data === undefined || frame.data === '') { controller.enqueue(frame.raw); return; }
          let event: unknown;
          try { event = JSON.parse(frame.data); }
          catch {
            if (frame.event?.startsWith('content_block_') || frame.event === 'message_delta' || frame.event === 'message_stop') throw new AnthropicResponseError('Unparseable SSE event', 'unparseable');
            controller.enqueue(frame.raw);
            return;
          }
          if (!record(event)) {
            if (frame.event?.startsWith('content_block_')) throw new AnthropicResponseError('Invalid SSE execution event');
            controller.enqueue(frame.raw);
            return;
          }
          if (frame.event && typeof event.type === 'string' && frame.event !== event.type && (frame.event.startsWith('content_block_') || event.type.startsWith('content_block_'))) throw new AnthropicResponseError('Conflicting execution event identity');
          const type = event.type ?? frame.event;
          const index = event.index;
          const block = event.content_block;
          if (type === 'content_block_start' && record(block) && block.type === 'tool_use') {
            if (stopped || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || indices.has(index)) throw new AnthropicResponseError('Invalid tool block index');
            if (typeof block.id !== 'string' || ids.has(block.id)) throw new AnthropicResponseError('Duplicate or invalid tool ID');
            ids.add(block.id);
            indices.add(index);
            // Validate the start identity and object-shaped initial input before buffering deltas.
            toolCall(block);
            active.set(index, { block, fragments: [], bytes: 0 });
            if (!hasTools) {
              hasTools = true;
              deadline = Date.now() + COMPLETION_TIMEOUT_MS;
              completionTimer = setTimeout(() => cancellation.abort(new AnthropicResponseError('Tool completion deadline exceeded')), COMPLETION_TIMEOUT_MS);
            }
            hold(frame.raw);
          } else if (type === 'content_block_delta' && record(event.delta) && event.delta.type === 'input_json_delta') {
            const pending = typeof index === 'number' ? active.get(index) : undefined;
            if (!pending || typeof event.delta.partial_json !== 'string') throw new AnthropicResponseError('Orphan or invalid tool input delta', 'unparseable');
            const fragment = event.delta.partial_json;
            pending.bytes += new TextEncoder().encode(fragment).byteLength;
            heldBytes += new TextEncoder().encode(fragment).byteLength;
            if (pending.bytes > MAX_TOOL_BYTES) throw new AnthropicResponseError('Tool input exceeds 1 MiB');
            pending.fragments.push(fragment);
            hold(frame.raw);
          } else if (type === 'content_block_stop' && typeof index === 'number' && active.has(index)) {
            const pending = active.get(index)!;
            if (pending.fragments.length && Object.keys(pending.block.input as Record<string, unknown>).length) throw new AnthropicResponseError('Conflicting initial and streamed tool input', 'unparseable');
            const input = pending.fragments.length ? parseToolInput(pending.fragments.join('')) : pending.block.input;
            calls.push(toolCall({ ...pending.block, input }));
            active.delete(index);
            hold(frame.raw);
          } else if (typeof index === 'number' && active.has(index)) {
            throw new AnthropicResponseError('Unexpected event inside tool block');
          } else if (type === 'message_stop' || type === 'message_delta') {
            if (type === 'message_stop') stopped = true;
            if (hasTools) hold(frame.raw);
            else { controller.enqueue(frame.raw); return; }
          } else {
            // Text, thinking, ping, comments, unknown events and upstream errors are never decision-blocked.
            controller.enqueue(frame.raw);
            return;
          }
        }
      } catch (error) {
        clearTimeout(completionTimer);
        if (abortListener) signal.removeEventListener('abort', abortListener);
        cancellation.abort(error);
        void frames.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(completionTimer);
      if (abortListener) signal.removeEventListener('abort', abortListener);
      cancellation.abort(reason);
      await frames.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}
