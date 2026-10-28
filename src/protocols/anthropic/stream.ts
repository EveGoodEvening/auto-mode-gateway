import { parseSse } from '../sse.js';
import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { AnthropicResponseError, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, decide, blockedText, safeguardResults, encodeEvent, shadowStream, bounded, parseToolInput, record, unique, validateToolBlock } from './safety.js';

interface PendingTool {
  block: Record<string, unknown>;
  fragments: string[];
  bytes: number;
}

/** Execution bytes stay private through EOF, complete JSON, and whole-response ID uniqueness. */
export function transformAnthropicStream(source: ReadableStream<Uint8Array>, context: RequestContext, options: AdapterOptions): ReadableStream<Uint8Array> {
  if (options.mode === 'shadow') return shadowStream(source, async bytes => {
    const observed = transformAnthropicStream(new Response(bytes).body!, context, { ...options, mode: 'enforce', onNativeDelivered: undefined });
    const reader = observed.getReader();
    try { while (!(await reader.read()).done) { /* Drain hypothetical delivery only. */ } }
    finally { reader.releaseLock(); }
  }, options.trackObservation);
  const native = options.delivery === 'native' && context.safeguards !== undefined;
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
  const callIndices = new Map<string, number>();
  const heldEvents = new Map<Uint8Array, Record<string, unknown>>();
  const contentBlocks = new Map<number, boolean>();
  const suffixBlocks = new Set<number>();
  let reasoningBytes = 0;
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let hasTools = false;
  let stopped = false;
  let finished = false;
  let releaseIndex = 0;
  let completionTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let keepaliveTimer: NodeJS.Timeout | undefined;

  function charge(bytes: number, reasoning = false): void {
    if (heldBytes + bytes > MAX_RESPONSE_BYTES) throw new AnthropicResponseError('Held response exceeds 8 MiB');
    if (reasoning && reasoningBytes + bytes > MAX_REASONING_BYTES) throw new AnthropicResponseError('Held reasoning exceeds 4 MiB');
    heldBytes += bytes;
    if (reasoning) reasoningBytes += bytes;
  }

  function hold(raw: Uint8Array, event?: Record<string, unknown>, reasoning = false): void {
    charge(raw.byteLength, reasoning);
    held.push(raw);
    if (event) heldEvents.set(raw, event);
  }

  function encodeHeld(event: Record<string, unknown>): Uint8Array {
    const json = JSON.stringify(event);
    const jsonBytes = Buffer.byteLength(json);
    const size = Buffer.byteLength(`event: ${String(event.type)}\ndata: `) + jsonBytes + 2;
    // Both the serialization temporary and replacement bytes share the existing ledger.
    charge(jsonBytes + size * 2);
    const raw = new TextEncoder().encode(`event: ${String(event.type)}\ndata: ${json}\n\n`);
    heldBytes -= jsonBytes + size;
    return raw;
  }

  function reencode(event: Record<string, unknown>, original: Uint8Array): Uint8Array {
    charge(original.byteLength);
    const raw = encodeHeld(event);
    heldBytes -= original.byteLength + raw.byteLength;
    return raw;
  }

  function discard(): void {
    held = [];
    heldEvents.clear();
    active.clear();
    calls.length = 0;
    contentBlocks.clear();
    callIndices.clear();
    ids.clear();
    indices.clear();
    heldBytes = 0;
    reasoningBytes = 0;
    suffixBlocks.clear();
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortListener = () => {
        clearTimeout(completionTimer);
        clearInterval(keepaliveTimer);
        discard();
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
          const raw = held[releaseIndex];
          if (raw) controller.enqueue(raw);
          if (raw) delete held[releaseIndex++];
          else {
            if (abortListener) signal.removeEventListener('abort', abortListener);
            if (native) options.onNativeDelivered?.();
            controller.close();
          }
          return;
        }
        while (true) {
          const item = await frames.read();
          if (item.done) {
            if (active.size) {
              for (const pending of active.values()) {
                if (pending.fragments.length) {
                  charge(pending.bytes * 2);
                  parseToolInput(pending.fragments.join(''));
                }
              }
              throw new AnthropicResponseError('Incomplete tool response at EOF', 'unparseable');
            }
            if ((hasTools || native) && !stopped) throw new AnthropicResponseError('Incomplete tool response at EOF', 'unparseable');
            if (suffixBlocks.size) throw new AnthropicResponseError('Incomplete content response at EOF', 'unparseable');
            clearTimeout(completionTimer);
            unique(calls);
            keepaliveTimer = setInterval(() => {
              if (!signal.aborted && controller.desiredSize !== null && controller.desiredSize >= 0) controller.enqueue(encodeEvent({ type: 'ping' }));
            }, Math.max(1, options.holdKeepaliveMs ?? 5000));
            const decisions = await decide(calls, context, { ...options, signal });
            clearInterval(keepaliveTimer);
            const allowed = calls.filter(call => decisions.get(call.id)?.outcome === 'allow');
            const blockedIndices = new Map(calls.filter(call => decisions.get(call.id)?.outcome !== 'allow').map(call => [callIndices.get(call.id)!, call]));
            const output: Uint8Array[] = [];
            const emitted = new Set<number>();
            let lastDelta: Record<string, unknown> | undefined;
            for (const event of heldEvents.values()) if (event.type === 'message_delta') lastDelta = event;
            for (const raw of held) {
              const event = heldEvents.get(raw);
              const index = event?.index;
              const blocked = !native && typeof index === 'number' && typeof event?.type === 'string' && event.type.startsWith('content_block_') ? blockedIndices.get(index) : undefined;
              if (blocked) {
                if (!emitted.has(index as number)) {
                  emitted.add(index as number);
                  output.push(encodeHeld({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
                    encodeHeld({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: blockedText(blocked, decisions.get(blocked.id)!) } }),
                    encodeHeld({ type: 'content_block_stop', index }));
                }
              } else if (event?.type === 'message_delta' && ((native && event === lastDelta) || (!native && calls.length > 0 && allowed.length === 0))) {
                const delta = record(event.delta) ? { ...event.delta } : {};
                if (native) delta.safeguard_results = safeguardResults(calls, decisions);
                else delta.stop_reason = 'end_turn';
                output.push(encodeHeld({ ...event, delta }));
              } else if (native && event?.type === 'message_stop' && !lastDelta) {
                output.push(encodeHeld({ type: 'message_delta', delta: { safeguard_results: safeguardResults(calls, decisions) } }), raw);
              } else output.push(raw);
            }
            held = output;
            heldEvents.clear();
            finished = true;
            const raw = held[releaseIndex];
            if (raw) controller.enqueue(raw);
            if (raw) delete held[releaseIndex++];
            else {
              if (abortListener) signal.removeEventListener('abort', abortListener);
              if (native) options.onNativeDelivered?.();
              controller.close();
            }
            return;
          }
          const frame = item.value;
          if (!frame.complete) throw new AnthropicResponseError('Incomplete SSE frame at EOF', 'unparseable');
          if (frame.data === undefined || frame.data === '') { controller.enqueue(frame.raw); return; }
          let raw = frame.raw;
          let event: unknown;
          try { event = JSON.parse(frame.data); }
          catch {
            if (frame.event?.startsWith('content_block_') || frame.event === 'message_delta' || frame.event === 'message_stop') throw new AnthropicResponseError('Unparseable SSE event', 'unparseable');
            if (hasTools && frame.event !== 'ping' && frame.event !== 'error') { hold(frame.raw); continue; }
            controller.enqueue(frame.raw);
            return;
          }
          if (!record(event)) {
            if (frame.event?.startsWith('content_block_')) throw new AnthropicResponseError('Invalid SSE execution event');
            if (hasTools && frame.event !== 'ping' && frame.event !== 'error') { hold(frame.raw); continue; }
            controller.enqueue(frame.raw);
            return;
          }
          const sensitive = (value: unknown): boolean => typeof value === 'string' && (value.startsWith('content_block_') || value === 'message_start' || value === 'message_delta' || value === 'message_stop');
          if (frame.event && event.type !== undefined && frame.event !== event.type && (sensitive(frame.event) || sensitive(event.type))) throw new AnthropicResponseError('Conflicting execution event identity');
          const type = event.type ?? frame.event;
          if (event.type === undefined && typeof type === 'string') event.type = type;
          if (type === 'message_start' || frame.event === 'message_start') {
            if (!record(event.message) || !Array.isArray(event.message.content) || event.message.content.length !== 0) {
              throw new AnthropicResponseError('Invalid message_start initial content');
            }
            if ('safeguard_results' in event.message) {
              delete event.message.safeguard_results;
              raw = reencode(event, raw);
            }
          }
          if ('safeguard_results' in event || (record(event.delta) && 'safeguard_results' in event.delta)) {
            delete event.safeguard_results;
            if (record(event.delta)) delete event.delta.safeguard_results;
            raw = reencode(event, raw);
          }
          if (type === 'ping' || type === 'error') { controller.enqueue(raw); return; }
          const index = event.index;
          const block = event.content_block;
          if (type === 'content_block_start' && record(block) && block.type === 'tool_use') {
            if (stopped || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || indices.has(index)) throw new AnthropicResponseError('Invalid tool block index');
            if (typeof block.id !== 'string' || ids.has(block.id)) throw new AnthropicResponseError('Duplicate or invalid tool ID');
            ids.add(block.id);
            indices.add(index);
            // Validate and charge retained initial input alongside the raw start frame.
            validateToolBlock(block);
            charge(Buffer.byteLength(JSON.stringify(block)));
            active.set(index, { block, fragments: [], bytes: 0 });
            if (!hasTools) {
              for (const openIndex of contentBlocks.keys()) suffixBlocks.add(openIndex);
              hasTools = true;
              deadline = Date.now() + COMPLETION_TIMEOUT_MS;
              completionTimer = setTimeout(() => cancellation.abort(new AnthropicResponseError('Tool completion deadline exceeded')), COMPLETION_TIMEOUT_MS);
            }
            hold(raw, { type, index });
          } else if (type === 'content_block_delta' && record(event.delta) && event.delta.type === 'input_json_delta') {
            const pending = typeof index === 'number' ? active.get(index) : undefined;
            if (!pending || typeof event.delta.partial_json !== 'string') throw new AnthropicResponseError('Orphan or invalid tool input delta', 'unparseable');
            const fragment = event.delta.partial_json;
            const bytes = Buffer.byteLength(fragment);
            pending.bytes += bytes;
            if (pending.bytes > MAX_TOOL_BYTES) throw new AnthropicResponseError('Tool input exceeds 1 MiB');
            charge(bytes);
            pending.fragments.push(fragment);
            hold(raw, { type, index });
          } else if (type === 'content_block_stop' && typeof index === 'number' && active.has(index)) {
            const pending = active.get(index)!;
            if (pending.fragments.length && Object.keys(pending.block.input as Record<string, unknown>).length) throw new AnthropicResponseError('Conflicting initial and streamed tool input', 'unparseable');
            // Reserve joined JSON and its parsed representation before allocating either.
            if (pending.fragments.length) {
              charge(pending.bytes * 2);
              pending.block.input = parseToolInput(pending.fragments.join(''));
              pending.fragments = [];
              heldBytes -= pending.bytes * 2; // Drop fragment strings and joined temporary; keep parsed input charged.
            }
            calls.push({ id: pending.block.id as string, name: pending.block.name as string, input: pending.block.input, raw: pending.block });
            callIndices.set(pending.block.id as string, index);
            active.delete(index);
            hold(raw, { type, index });
          } else if (typeof index === 'number' && active.has(index)) {
            throw new AnthropicResponseError('Unexpected event inside tool block');
          } else if (type === 'message_stop' || type === 'message_delta') {
            if (active.size || stopped) throw new AnthropicResponseError('Invalid terminal event ordering');
            if (type === 'message_stop') stopped = true;
            if (hasTools || native) {
              // Only terminal payloads need a retained parsed representation for final injection.
              charge(Buffer.byteLength(JSON.stringify(event)));
              hold(raw, event);
            }
            else { controller.enqueue(raw); return; }
          } else {
            if (type === 'content_block_start' && typeof index === 'number' && record(block)) {
              contentBlocks.set(index, block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'signature' || 'signature' in block);
              if (hasTools) suffixBlocks.add(index);
            }
            const reasoning = (typeof index === 'number' && contentBlocks.get(index) === true)
              || (record(event.delta) && (event.delta.type === 'thinking_delta' || event.delta.type === 'redacted_thinking_delta' || event.delta.type === 'signature_delta'));
            if (reasoning && typeof index === 'number' && contentBlocks.has(index)) contentBlocks.set(index, true);
            if (type === 'content_block_stop' && typeof index === 'number') {
              contentBlocks.delete(index);
              suffixBlocks.delete(index);
            }
            // Ordered retention is not compatibility stripping: original thinking/signatures survive.
            // Every later data event stays behind the first tool, including unknown stateful events.
            if (hasTools) hold(raw, undefined, reasoning);
            else { controller.enqueue(raw); return; }
          }
        }
      } catch (error) {
        clearTimeout(completionTimer);
        clearInterval(keepaliveTimer);
        if (abortListener) signal.removeEventListener('abort', abortListener);
        discard();
        cancellation.abort(error);
        void frames.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(completionTimer);
      clearInterval(keepaliveTimer);
      if (abortListener) signal.removeEventListener('abort', abortListener);
      cancellation.abort(reason);
      discard();
      await frames.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}
