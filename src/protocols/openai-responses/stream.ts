import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import type { Verdict } from '../../gate/types.js';
import { parseSse, pingKeepalive, type SseFrame } from '../sse.js';
import { ResponsesResponseError, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, MAX_TOOL_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, DECISION_TIMEOUT_MS, bounded, blockedText, execution, callFor, unique, record, blockedMessage, same, sameExecution, utf8Bytes, jsonBytes, encodeEvent, shadowStream } from './safety.js';
import { parsedBound, reasoningBound, propertySpan } from './nonstream.js';

type Item = { initial?: Record<string, unknown>; final?: Record<string, unknown>; parameters: string; parameterBytes: number; parameterId?: string; delta: boolean; parametersDone?: string; call?: ToolCall; decision?: Promise<Verdict> };
type Queued = { frame: SseFrame; value?: Record<string, unknown> };

export function transformResponsesStream(source: ReadableStream<Uint8Array>, context: RequestContext, options: AdapterOptions): ReadableStream<Uint8Array> {
  if (options.signal.aborted) {
    const reason: unknown = options.signal.reason ?? new ResponsesResponseError('Response cancelled');
    void source.cancel(reason).catch(() => undefined);
    return new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason); } });
  }
  if (options.mode === 'shadow') return shadowStream(source, async bytes => {
    const observed = transformResponsesStream(new Response(bytes).body!, context, { ...options, mode: 'enforce' });
    for await (const chunk of observed) void chunk;
  }, options.trackObservation);
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let lastByte = Date.now();
  const original = source.getReader();
  const timed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await bounded(original.read(), IDLE_TIMEOUT_MS - (Date.now() - lastByte), signal);
        if (Date.now() - lastByte >= IDLE_TIMEOUT_MS) throw new ResponsesResponseError('Upstream idle deadline exceeded');
        if (item.done) { original.releaseLock(); controller.close(); }
        else { if (item.value.byteLength) lastByte = Date.now(); controller.enqueue(item.value); }
      } catch (error) { controller.error(error); await original.cancel(error).catch(() => undefined); }
    },
    async cancel(reason) { await original.cancel(reason).catch(() => undefined); },
  }, { highWaterMark: 0 });
  const reader = parseSse(timed).getReader();
  const items = new Map<number, Item>();
  const lifecycle = new Map<number, { type: unknown; id: unknown; done: boolean }>();
  const queue: Queued[] = [];
  const output: Uint8Array[] = [];
  let outputCursor = 0;
  let held = false;
  let terminal = false;
  let terminalEvent: Record<string, unknown> | undefined;
  let finished = false;
  let stopped = false;
  let retained = 0;
  let reasoningRetained = 0;
  let completionDeadline = Infinity;
  let decisionDeadline = Infinity;
  let decisionTimer: NodeJS.Timeout | undefined;
  let completionTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let decisionChain: Promise<unknown> = Promise.resolve();
  let sequence = -1;
  let generated = 0;
  const keepalive = pingKeepalive(options.holdKeepaliveMs ?? 10_000);
  function discard(): void {
    queue.length = 0;
    output.length = 0;
    outputCursor = 0;
    items.clear();
    lifecycle.clear();
    terminalEvent = undefined;
    clearTimeout(completionTimer);
    clearTimeout(decisionTimer);
    keepalive.close();
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
  function reserve(bytes: number): void {
    if (retained + bytes > MAX_RESPONSE_BYTES) throw new ResponsesResponseError('Response exceeds 8 MiB');
    retained += bytes;
  }
  function barrier(): void {
    if (!held) {
      held = true;
      completionDeadline = Date.now() + COMPLETION_TIMEOUT_MS;
      completionTimer = setTimeout(() => abort.abort(new ResponsesResponseError('Completion deadline exceeded')), COMPLETION_TIMEOUT_MS);
      keepalive.setHeld(true);
    }
  }
  function emit(value: Record<string, unknown>, raw?: SseFrame, immediate = false): void {
    // An immediate control event can overtake held data; released events are renumbered if needed.
    if (raw && (value.sequence_number === undefined || (typeof value.sequence_number === 'number' && Number.isSafeInteger(value.sequence_number) && value.sequence_number > sequence))) {
      if (typeof value.sequence_number === 'number') sequence = value.sequence_number;
      output.push(raw.raw);
      return;
    }
    if (!Number.isSafeInteger(sequence + 1)) throw new ResponsesResponseError('Outgoing sequence number overflow');
    const next: Record<string, unknown> = { ...value, sequence_number: ++sequence };
    // JSON serialization, formatted SSE text and encoded bytes can coexist at the peak.
    const bytes = jsonBytes(next) * 3 + utf8Bytes(String(next.type)) * 2 + 32;
    if (immediate || !held) {
      if (retained + bytes > MAX_RESPONSE_BYTES) throw new ResponsesResponseError('Response exceeds 8 MiB');
    } else {
      reserve(bytes);
      const item = record(next.item) ? next.item : undefined;
      const subset = String(next.type).includes('reasoning') || item?.type === 'reasoning' || (record(next.part) && next.part.type === 'reasoning_text') || (typeof next.output_index === 'number' && lifecycle.get(next.output_index)?.type === 'reasoning') ? bytes
        : record(next.response) && Array.isArray(next.response.output) ? next.response.output.filter((entry: unknown) => record(entry) && entry.type === 'reasoning').reduce<number>((sum, entry: unknown) => sum + jsonBytes(entry) * 3, 0) : 0;
      if (reasoningRetained + subset > MAX_REASONING_BYTES) throw new ResponsesResponseError('Reasoning exceeds 4 MiB');
      reasoningRetained += subset;
    }
    output.push(encodeEvent(next));
  }
  function indexOf(value: Record<string, unknown>): number {
    if (typeof value.output_index !== 'number' || !Number.isSafeInteger(value.output_index) || value.output_index < 0) throw new ResponsesResponseError('Invalid output index');
    return value.output_index;
  }
  function identity(initial: Record<string, unknown>, final: Record<string, unknown>): void {
    for (const key of ['type', 'id', 'call_id', 'name', 'action', 'encrypted_function_args']) if (initial[key] != null && !same(initial[key], final[key])) throw new ResponsesResponseError('Contradictory execution identity');
    if (!sameExecution({ namespace: initial.namespace }, { namespace: final.namespace })) throw new ResponsesResponseError('Contradictory execution namespace');
    for (const key of ['arguments', 'input']) {
      const before = initial[key];
      const after = final[key];
      if (before !== undefined && (typeof before !== 'string' || typeof after !== 'string' || !after.startsWith(before))) throw new ResponsesResponseError('Contradictory execution parameters');
    }
  }
  function complete(index: number, final: Record<string, unknown>): void {
    barrier();
    const item: Item = items.get(index) ?? { parameters: '', parameterBytes: 0, delta: false };
    if (item.final) throw new ResponsesResponseError('Repeated execution completion');
    if (item.initial) identity(item.initial, final);
    if (item.parameterId !== undefined && item.parameterId !== final.id) throw new ResponsesResponseError('Contradictory parameter item identity');
    const field = final.type === 'custom_tool_call' ? 'input' : 'arguments';
    if (final.type !== 'local_shell_call') {
      if (item.delta && item.parameters !== final[field]) throw new ResponsesResponseError('Contradictory execution deltas');
      if (item.parametersDone !== undefined && item.parametersDone !== final[field]) throw new ResponsesResponseError('Contradictory completed parameters');
    }
    // The parsed function input is distinct from the retained wire arguments string.
    if (final.type === 'function_call' && typeof final.arguments === 'string') reserve(parsedBound(final.arguments));
    item.call = callFor(final);
    item.final = final;
    items.set(index, item);
    if (decisionDeadline === Infinity) {
      decisionDeadline = Date.now() + DECISION_TIMEOUT_MS;
      decisionTimer = setTimeout(() => abort.abort(new ResponsesResponseError('Decision deadline exceeded')), DECISION_TIMEOUT_MS);
    }
    item.decision = decisionChain.then(async () => {
      if (signal.aborted) throw new ResponsesResponseError('Response cancelled');
      return bounded(Promise.resolve().then(() => options.onToolCall(item.call!, context, signal)), decisionDeadline - Date.now(), signal);
    });
    // Observe failure immediately; propagate it before any held output is released.
    decisionChain = item.decision.catch(() => undefined);
    void item.decision.catch(() => undefined);
  }
  function blockChain(index: number, message: Record<string, unknown>, phase: 'start' | 'done'): void {
    const id = message.id;
    if (phase === 'start') {
      emit({ type: 'response.output_item.added', output_index: index, item: { ...message, status: 'in_progress', content: [] } });
      emit({ type: 'response.content_part.added', item_id: id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      return;
    }
    if (!Array.isArray(message.content) || !record(message.content[0])) throw new ResponsesResponseError('Invalid blocked message');
    const content = message.content[0];
    const text = content.text;
    emit({ type: 'response.output_text.delta', item_id: id, output_index: index, content_index: 0, delta: text });
    emit({ type: 'response.output_text.done', item_id: id, output_index: index, content_index: 0, text });
    emit({ type: 'response.content_part.done', item_id: id, output_index: index, content_index: 0, part: content });
    emit({ type: 'response.output_item.done', output_index: index, item: message });
  }
  async function finish(value: Record<string, unknown>): Promise<void> {
    if (!record(value.response) || !Array.isArray(value.response.output)) throw new ResponsesResponseError('Invalid terminal Responses snapshot');
    const finalOutput = value.response.output;
    const calls: ToolCall[] = [];
    const itemIds = new Set<unknown>();
    for (const [index, item] of items) {
      if (!item.final || !item.call) throw new ResponsesResponseError('Incomplete execution item');
      if (!sameExecution(item.final, record(finalOutput[index]) ? finalOutput[index] : {})) throw new ResponsesResponseError('Contradictory terminal execution snapshot');
      calls.push(item.call);
    }
    for (let index = 0; index < finalOutput.length; index++) {
      const item: unknown = finalOutput[index];
      if (record(item) && item.id != null) {
        if (typeof item.id !== 'string' || !item.id || itemIds.has(item.id)) throw new ResponsesResponseError('Duplicate or invalid output item identity');
        itemIds.add(item.id);
      }
      if (execution(item) && !items.get(index)?.final) throw new ResponsesResponseError('Untracked terminal execution snapshot');
      if (execution(item) && item.status != null && item.status !== 'completed') throw new ResponsesResponseError('Incomplete terminal execution item');
    }
    unique(calls);
    for (const [index, state] of lifecycle) {
      const item: unknown = finalOutput[index];
      if (!state.done || !record(item) || item.type !== state.type || (state.id != null && item.id !== state.id)) throw new ResponsesResponseError('Contradictory terminal output lifecycle');
    }
    const replacements = new Map<number, Record<string, unknown>>();
    for (const [index, item] of items) {
      const verdict = await bounded(item.decision!, decisionDeadline - Date.now(), signal);
      if (verdict.outcome !== 'allow') {
        let id: string;
        do { id = `msg_amp_${generated++}`; } while (itemIds.has(id));
        itemIds.add(id);
        const message = blockedMessage(id, blockedText(item.call!, verdict));
        reserve(jsonBytes(message));
        replacements.set(index, message);
      }
    }
    if (signal.aborted) throw new ResponsesResponseError('Response cancelled');
    if (Date.now() >= decisionDeadline) throw new ResponsesResponseError('Decision deadline exceeded');
    const started = new Set<number>();
    for (const entry of queue) {
      const event = entry.value;
      if (!event) { output.push(entry.frame.raw); continue; }
      if (typeof event.output_index === 'number' && replacements.has(event.output_index)) {
        const index = event.output_index;
        const message = replacements.get(index)!;
        // Client dispatch/history follows done arrival, so never move completion to the added slot.
        if (event.type === 'response.output_item.added') {
          blockChain(index, message, 'start');
          started.add(index);
        } else if (event.type === 'response.output_item.done') {
          if (!started.has(index)) { blockChain(index, message, 'start'); started.add(index); }
          blockChain(index, message, 'done');
        }
        continue;
      }
      if (event === value) {
        const rewritten = { ...event, response: { ...value.response, output: finalOutput.map((item: unknown, index: number) => replacements.get(index) ?? item) } };
        reserve(jsonBytes(rewritten));
        const subset = finalOutput.filter((item: unknown) => record(item) && item.type === 'reasoning').reduce<number>((sum, item: unknown) => sum + jsonBytes(item), 0);
        if (reasoningRetained + subset > MAX_REASONING_BYTES) throw new ResponsesResponseError('Reasoning exceeds 4 MiB');
        reasoningRetained += subset;
        emit(rewritten);
      } else emit(event, entry.frame);
    }
    queue.length = 0;
    terminal = true;
    clearTimeout(decisionTimer);
    keepalive.setHeld(false);
  }
  function process(frame: SseFrame): void {
    if (!frame.complete) throw new ResponsesResponseError('Incomplete SSE frame');
    if (!frame.data || frame.data === '[DONE]') {
      if (frame.data === '[DONE]' && !terminal) throw new ResponsesResponseError('Incomplete Responses turn');
      // Comments bypass the barrier; a client terminator must follow the withheld terminal.
      if (frame.data === '[DONE]' && held) { reserve(frame.raw.byteLength * 2 + utf8Bytes(frame.data)); queue.push({ frame }); }
      else output.push(frame.raw);
      return;
    }
    const typeSpan = propertySpan(frame.data, 'type');
    const rawType: unknown = typeSpan && typeSpan[1] - typeSpan[0] <= 256 ? JSON.parse(frame.data.slice(typeSpan[0], typeSpan[1])) : undefined;
    const itemSpan = propertySpan(frame.data, 'item');
    const itemTypeSpan = itemSpan ? propertySpan(frame.data, 'type', itemSpan[0]) : undefined;
    const rawItemType: unknown = itemTypeSpan && itemTypeSpan[1] - itemTypeSpan[0] <= 96 ? JSON.parse(frame.data.slice(itemTypeSpan[0], itemTypeSpan[1])) : undefined;
    const responseSpan = propertySpan(frame.data, 'response');
    const control = (rawType === 'error' || rawType === 'ping') && !itemSpan && !responseSpan && ['output', 'output_index', 'item_id', 'content_index', 'delta', 'part', 'arguments', 'input'].every(key => !propertySpan(frame.data!, key));
    if (terminal && !control) throw new ResponsesResponseError('Event after terminal Responses snapshot');
    const willHold = held || ((rawType === 'response.output_item.added' || rawType === 'response.output_item.done') && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(rawItemType)));
    const temporary = frame.raw.byteLength + parsedBound(frame.data);
    const bytes = frame.raw.byteLength + temporary;
    const indexSpan = propertySpan(frame.data, 'output_index');
    const rawIndex: unknown = indexSpan && indexSpan[1] - indexSpan[0] <= 32 ? JSON.parse(frame.data.slice(indexSpan[0], indexSpan[1])) : undefined;
    const partSpan = propertySpan(frame.data, 'part');
    const partTypeSpan = partSpan ? propertySpan(frame.data, 'type', partSpan[0]) : undefined;
    const rawPartType: unknown = partTypeSpan && partTypeSpan[1] - partTypeSpan[0] <= 96 ? JSON.parse(frame.data.slice(partTypeSpan[0], partTypeSpan[1])) : undefined;
    const fullReasoning = (typeof rawType === 'string' && rawType.includes('reasoning')) || rawItemType === 'reasoning' || rawPartType === 'reasoning_text' || (typeof rawIndex === 'number' && lifecycle.get(rawIndex)?.type === 'reasoning');
    const subset = fullReasoning ? bytes : responseSpan ? reasoningBound(frame.data, responseSpan[0]) : 0;
    if (retained + bytes > MAX_RESPONSE_BYTES) throw new ResponsesResponseError('Response exceeds 8 MiB');
    if (willHold && !control) {
      // Reserve raw, decoded and parsed data (including reasoning) BEFORE JSON.parse.
      reserve(bytes);
      if (reasoningRetained + subset > MAX_REASONING_BYTES) throw new ResponsesResponseError('Reasoning exceeds 4 MiB');
      reasoningRetained += subset;
    }
    const value: unknown = JSON.parse(frame.data);
    if (!record(value) || typeof value.type !== 'string') throw new ResponsesResponseError('Invalid Responses event');
    const type = value.type;
    if (frame.event && frame.event !== type) {
      const sensitive = (name: string): boolean => name.startsWith('response.output_item.') || name.startsWith('response.function_call_arguments.') || name.startsWith('response.custom_tool_call_input.') || name === 'response.completed' || name === 'response.incomplete';
      if (sensitive(frame.event) || sensitive(type)) throw new ResponsesResponseError('Conflicting execution event identity');
    }
    const isTerminal = type === 'response.completed' || type === 'response.incomplete';
    if (record(value.response) && !isTerminal && Array.isArray(value.response.output) && value.response.output.some(execution)) throw new ResponsesResponseError('Untracked initial execution snapshot');
    if (Array.isArray(value.output) && value.output.some(execution)) throw new ResponsesResponseError('Untracked execution snapshot');
    if (isTerminal) {
      if (!record(value.response) || !Array.isArray(value.response.output)) throw new ResponsesResponseError('Invalid terminal Responses snapshot');
      if (value.response.status != null && value.response.status !== type.slice('response.'.length)) throw new ResponsesResponseError('Contradictory terminal response status');
      if (!held && value.response.output.some(execution)) throw new ResponsesResponseError('Untracked terminal execution snapshot');
    }
    if (record(value.item) && value.item.type === 'tool_search_call' && value.item.execution !== 'server') throw new ResponsesResponseError('Unsupported client tool-search execution');
    const isItem = type === 'response.output_item.added' || type === 'response.output_item.done';
    if (isItem) {
      const index = indexOf(value);
      if (!record(value.item) || typeof value.item.type !== 'string') throw new ResponsesResponseError('Invalid output item');
      const previous = lifecycle.get(index);
      if (type === 'response.output_item.added') {
        if (previous) throw new ResponsesResponseError('Repeated output item');
        reserve(jsonBytes({ type: value.item.type, id: value.item.id }));
        lifecycle.set(index, { type: value.item.type, id: value.item.id, done: false });
      } else {
        if (previous && (previous.done || previous.type !== value.item.type || (previous.id != null && previous.id !== value.item.id))) throw new ResponsesResponseError('Contradictory completed output item');
        if (!previous) reserve(jsonBytes({ type: value.item.type, id: value.item.id }));
        lifecycle.set(index, { type: value.item.type, id: value.item.id, done: true });
      }
      if (execution(value.item)) {
        barrier();
        if (type === 'response.output_item.added') {
          const parameters = value.item.type === 'custom_tool_call' ? value.item.input : value.item.type === 'function_call' ? value.item.arguments : '';
          if (parameters !== undefined && typeof parameters !== 'string') throw new ResponsesResponseError('Invalid initial execution parameters');
          const initial = typeof parameters === 'string' ? parameters : '';
          const parameterBytes = utf8Bytes(initial);
          if (parameterBytes > MAX_TOOL_BYTES) throw new ResponsesResponseError('Execution parameters exceed 1 MiB');
          items.set(index, { initial: value.item, parameters: initial, parameterBytes, delta: false });
        } else complete(index, value.item);
      } else if (items.has(index)) throw new ResponsesResponseError('Contradictory execution item type');
    } else if (execution(value.item)) throw new ResponsesResponseError('Untracked execution item');
    else if (type.startsWith('response.function_call_arguments.') || type.startsWith('response.custom_tool_call_input.')) {
      const index = indexOf(value);
      const item = items.get(index);
      const expected = type.startsWith('response.custom_tool_call_input.') ? 'custom_tool_call' : 'function_call';
      if (!item || item.final || item.initial?.type !== expected) throw new ResponsesResponseError('Untracked execution parameters');
      if (value.item_id != null) {
        if (typeof value.item_id !== 'string' || (item.initial.id != null && value.item_id !== item.initial.id) || (item.parameterId !== undefined && value.item_id !== item.parameterId)) throw new ResponsesResponseError('Contradictory parameter item identity');
        item.parameterId = value.item_id;
      }
      if (type.endsWith('.delta')) {
        if (typeof value.delta !== 'string') throw new ResponsesResponseError('Invalid execution delta');
        const deltaBytes = utf8Bytes(value.delta);
        if (item.parameterBytes + deltaBytes > MAX_TOOL_BYTES) throw new ResponsesResponseError('Execution parameters exceed 1 MiB');
        reserve(deltaBytes + (item.delta ? 0 : item.parameterBytes));
        item.parameters += value.delta;
        item.parameterBytes += deltaBytes;
        item.delta = true;
      } else if (type.endsWith('.done')) {
        const parameters = expected === 'custom_tool_call' ? value.input : value.arguments;
        if (typeof parameters !== 'string' || utf8Bytes(parameters) > MAX_TOOL_BYTES || (item.delta && item.parameters !== parameters) || item.parametersDone !== undefined) throw new ResponsesResponseError('Contradictory completed parameters');
        item.parametersDone = parameters;
      } else throw new ResponsesResponseError('Unsupported execution parameter event');
    }
    if (type === 'response.failed') throw new ResponsesResponseError('Upstream Responses failure');
    if (held && !control) queue.push({ frame, value });
    else emit(value, frame, control);
    if (isTerminal) {
      terminal = true;
      terminalEvent = value;
    }
  }
  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      abortListener = () => {
        if (stopped) return;
        stopped = true;
        discard();
        const reason: unknown = signal.reason ?? new ResponsesResponseError('Response cancelled');
        controller.error(reason);
        void reader.cancel(reason).catch(() => undefined);
      };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    },
    async pull(controller) {
      try {
        while (!stopped) {
          if (signal.aborted) throw signal.reason ?? new ResponsesResponseError('Response cancelled');
          if (outputCursor < output.length) {
            const bytes = output[outputCursor]!;
            delete output[outputCursor++];
            if (outputCursor === output.length) { output.length = 0; outputCursor = 0; }
            controller.enqueue(bytes);
            return;
          }
          if (finished) { stopped = true; discard(); reader.releaseLock(); controller.close(); return; }
          const item = await bounded(reader.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByte), completionDeadline - Date.now()), signal);
          if (held && Date.now() >= completionDeadline) throw new ResponsesResponseError('Completion deadline exceeded');
          if (item.done) {
            if (!terminal) throw new ResponsesResponseError('Incomplete Responses turn');
            clearTimeout(completionTimer);
            // Match the existing raw-SSE guard lifecycle: malformed trailers cannot follow released execution.
            if (held && terminalEvent) await finish(terminalEvent);
            finished = true;
            continue;
          }
          process(item.value);
        }
      } catch (error) {
        if (!stopped) { stopped = true; discard(); abort.abort(error); controller.error(error); await reader.cancel(error).catch(() => undefined); }
      }
    },
    async cancel(reason) { stopped = true; discard(); abort.abort(reason); await reader.cancel(reason).catch(() => undefined); },
  }, { highWaterMark: 0 });
  return keepalive.wrap(transformed);
}
