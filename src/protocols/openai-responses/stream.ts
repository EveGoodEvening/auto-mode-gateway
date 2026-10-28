import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import type { Verdict } from '../../gate/types.js';
import { classifySseRetention, parseSse, pingKeepalive, type SseFrame } from '../sse.js';
import { ResponsesResponseError, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, MAX_TOOL_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, DECISION_TIMEOUT_MS, bounded, blockedText, execution, callFor, record, blockedMessage, same, sameExecution, utf8Bytes, jsonBytes, encodeEvent, shadowStream } from './safety.js';
import { parsedBound } from './nonstream.js';
import { ResponseBudget, type ResponseAccounting, type ResponseReservation } from '../response-budget.js';

type Item = { initial?: Record<string, unknown>; final?: Record<string, unknown>; parameters: string; parameterBytes: number; parameterId?: string; parameterReservation?: ResponseReservation; delta: boolean; parametersDone?: string; call?: ToolCall; decision?: Promise<Verdict> };
type Queued = { frame?: SseFrame; value?: Record<string, unknown> };

export function transformResponsesStream(source: ReadableStream<Uint8Array>, context: RequestContext, options: AdapterOptions, accounting?: ResponseAccounting): ReadableStream<Uint8Array> {
  if (options.signal.aborted) {
    const reason: unknown = options.signal.reason ?? new ResponsesResponseError('Response cancelled');
    void source.cancel(reason).catch(() => undefined);
    return new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason); } });
  }
  if (options.mode === 'shadow') return shadowStream(source, async (observedSource, budget, observationSignal) => {
    const observed = transformResponsesStream(observedSource, context, { ...options, signal: AbortSignal.any([options.signal, observationSignal]), mode: 'enforce' }, { budget });
    for await (const chunk of observed) void chunk;
  }, options.trackObservation);
  const budget = accounting?.budget ?? new ResponseBudget(MAX_RESPONSE_BYTES, MAX_REASONING_BYTES);
  const workspace = budget.reserve(8192);
  const ownedRaw = new Set<Uint8Array>();
  const retained = new Set<ResponseReservation>();
  const items = new Map<number, Item>();
  const lifecycle = new Map<number, { type: unknown; id: unknown; done: boolean }>();
  const queue: Queued[] = [];
  const output: Uint8Array[] = [];
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let outputCursor = 0;
  let held = false;
  let terminal = false;
  let terminalEvent: Record<string, unknown> | undefined;
  let terminalState: { output: unknown[]; ids: Set<unknown> } | undefined;
  let finished = false;
  let stopped = false;
  let currentFrame: SseFrame | undefined;
  let completionDeadline = Infinity;
  let decisionDeadline = Infinity;
  let decisionTimer: NodeJS.Timeout | undefined;
  let completionTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let decisionChain: Promise<unknown> = Promise.resolve();
  let sequence = -1;
  let generated = 0;
  let lastByte = Date.now();
  let originalReleased = false;
  const original = source.getReader();
  const releaseOriginal = (): void => { if (!originalReleased) { originalReleased = true; original.releaseLock(); } };
  const timed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await bounded(original.read(), IDLE_TIMEOUT_MS - (Date.now() - lastByte), signal);
        if (Date.now() - lastByte >= IDLE_TIMEOUT_MS) throw new ResponsesResponseError('Upstream idle deadline exceeded');
        if (item.done) { releaseOriginal(); controller.close(); }
        else { if (item.value.byteLength) lastByte = Date.now(); controller.enqueue(item.value); }
      } catch (error) {
        controller.error(error);
        if (!originalReleased) { try { await original.cancel(error); } catch { /* Preserve the original failure. */ } finally { releaseOriginal(); } }
      }
    },
    async cancel(reason) { if (!originalReleased) { try { await original.cancel(reason); } catch { /* Cancellation is terminal. */ } finally { releaseOriginal(); } } },
  }, { highWaterMark: 0 });
  const reader = parseSse(timed, {
    budget, potentialReasoning: true,
    classifyRetention: (raw, partial) => classifySseRetention(raw, 'responses', index => lifecycle.has(index) ? lifecycle.get(index)!.type === 'reasoning' : undefined, budget, partial),
  }).getReader();
  const keepalive = pingKeepalive(options.holdKeepaliveMs ?? 10_000);

  function reserve(bytes: number, reasoning = 0): ResponseReservation {
    const allocation = budget.reserve(bytes + 128, reasoning);
    retained.add(allocation);
    return allocation;
  }
  function release(allocation: ResponseReservation | undefined): void { if (allocation) { allocation.release(); retained.delete(allocation); } }
  function releaseRaw(bytes: Uint8Array): void { ownedRaw.delete(bytes); budget.releaseBytes(bytes); }
  function releaseRetained(): void {
    items.clear(); lifecycle.clear(); terminalEvent = undefined; terminalState = undefined;
    for (const allocation of retained) allocation.release();
    retained.clear();
  }
  function discard(): void {
    currentFrame?.release(); currentFrame = undefined;
    for (const entry of queue) { entry.frame?.release(); entry.frame = undefined; entry.value = undefined; }
    queue.length = 0;
    output.length = 0; outputCursor = 0;
    releaseRetained();
    for (const bytes of ownedRaw) budget.releaseBytes(bytes);
    ownedRaw.clear();
    clearTimeout(completionTimer); clearTimeout(decisionTimer);
    keepalive.close();
    if (abortListener) signal.removeEventListener('abort', abortListener);
    workspace.release();
    if (!accounting) budget.close();
  }
  function barrier(): void {
    if (!held) {
      held = true; completionDeadline = Date.now() + COMPLETION_TIMEOUT_MS;
      completionTimer = setTimeout(() => abort.abort(new ResponsesResponseError('Completion deadline exceeded')), COMPLETION_TIMEOUT_MS);
      keepalive.setHeld(true);
    }
  }
  function reasoningJson(value: Record<string, unknown>): { whole: boolean; bytes: number } {
    const text = value.type === 'response.output_text.delta' || value.type === 'response.output_text.done'
      || ((value.type === 'response.content_part.added' || value.type === 'response.content_part.done') && record(value.part) && value.part.type === 'output_text');
    const whole = String(value.type).includes('reasoning') || (record(value.item) && value.item.type === 'reasoning')
      || (record(value.part) && value.part.type === 'reasoning_text')
      || (typeof value.output_index === 'number' && (lifecycle.get(value.output_index)?.type === 'reasoning' || (!lifecycle.has(value.output_index) && !text)));
    let bytes = 0;
    if (record(value.response) && Array.isArray(value.response.output)) for (const item of value.response.output) {
      if (record(item) && item.type === 'reasoning') bytes += jsonBytes(item);
    }
    return { whole, bytes };
  }
  /** Original frames are supplied only when their semantic payload is unchanged. */
  function emit(value: Record<string, unknown>, raw?: SseFrame): void {
    if (raw && (value.sequence_number === undefined || (typeof value.sequence_number === 'number' && Number.isSafeInteger(value.sequence_number) && value.sequence_number > sequence))) {
      if (typeof value.sequence_number === 'number') sequence = value.sequence_number;
      output.push(raw.raw);
      return;
    }
    if (!Number.isSafeInteger(sequence + 1)) throw new ResponsesResponseError('Outgoing sequence number overflow');
    let properties = 0;
    for (const key in value) if (Object.hasOwn(value, key)) properties++;
    const json = jsonBytes(value) + 64;
    const header = utf8Bytes(String(value.type)) + 16;
    const peak = json * 5 + header * 3 + properties * 128 + 1024;
    const reasoning = reasoningJson(value);
    const allocation = budget.reserve(peak, reasoning.whole ? peak : Math.min(peak, reasoning.bytes * 5 + (reasoning.bytes ? properties * 128 + 1024 : 0)));
    try {
      const next: Record<string, unknown> = { ...value, sequence_number: ++sequence };
      const bytes = encodeEvent(next);
      allocation.resize(bytes.byteLength + 256, reasoning.whole ? bytes.byteLength : Math.min(bytes.byteLength, reasoning.bytes));
      budget.registerBytes(bytes, allocation);
      ownedRaw.add(bytes);
      output.push(bytes);
    } catch (error) { allocation.release(); throw error; }
    if (raw) { raw.release(); ownedRaw.delete(raw.raw); }
  }
  function indexOf(value: Record<string, unknown>): number {
    if (typeof value.output_index !== 'number' || !Number.isSafeInteger(value.output_index) || value.output_index < 0) throw new ResponsesResponseError('Invalid output index');
    return value.output_index;
  }
  function identity(initial: Record<string, unknown>, final: Record<string, unknown>): void {
    for (const key of ['type', 'id', 'call_id', 'name', 'action', 'encrypted_function_args']) if (initial[key] != null && !same(initial[key], final[key])) throw new ResponsesResponseError('Contradictory execution identity');
    if (!sameExecution({ namespace: initial.namespace }, { namespace: final.namespace })) throw new ResponsesResponseError('Contradictory execution namespace');
    for (const key of ['arguments', 'input']) {
      const before = initial[key]; const after = final[key];
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
    if (final.type !== 'local_shell_call' && ((item.delta && item.parameters !== final[field]) || (item.parametersDone !== undefined && item.parametersDone !== final[field]))) throw new ResponsesResponseError('Contradictory completed parameters');
    item.parameters = ''; release(item.parameterReservation); delete item.parameterReservation;
    if (final.type === 'function_call' && typeof final.arguments === 'string') reserve(parsedBound(final.arguments));
    reserve(512);
    item.call = callFor(final); item.final = final; items.set(index, item);
    if (decisionDeadline === Infinity) {
      decisionDeadline = Date.now() + DECISION_TIMEOUT_MS;
      decisionTimer = setTimeout(() => abort.abort(new ResponsesResponseError('Decision deadline exceeded')), DECISION_TIMEOUT_MS);
    }
    item.decision = decisionChain.then(async () => {
      if (signal.aborted) throw new ResponsesResponseError('Response cancelled');
      return bounded(Promise.resolve().then(() => options.onToolCall(item.call!, context, signal)), decisionDeadline - Date.now(), signal);
    });
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
    const content = message.content[0]; const text = content.text;
    emit({ type: 'response.output_text.delta', item_id: id, output_index: index, content_index: 0, delta: text });
    emit({ type: 'response.output_text.done', item_id: id, output_index: index, content_index: 0, text });
    emit({ type: 'response.content_part.done', item_id: id, output_index: index, content_index: 0, part: content });
    emit({ type: 'response.output_item.done', output_index: index, item: message });
  }
  function validateTerminal(value: Record<string, unknown>): { output: unknown[]; ids: Set<unknown> } {
    if (!record(value.response) || !Array.isArray(value.response.output)) throw new ResponsesResponseError('Invalid terminal Responses snapshot');
    const finalOutput = value.response.output;
    reserve((items.size + lifecycle.size + finalOutput.length) * 256 + 2048);
    const ids = new Set<unknown>(); const callIds = new Set<string>();
    for (const [index, item] of items) {
      if (!item.final || !item.call) throw new ResponsesResponseError('Incomplete execution item');
      if (!sameExecution(item.final, record(finalOutput[index]) ? finalOutput[index] : {})) throw new ResponsesResponseError('Contradictory terminal execution snapshot');
      if (callIds.has(item.call.id)) throw new ResponsesResponseError('Duplicate tool ID');
      callIds.add(item.call.id);
    }
    for (let index = 0; index < finalOutput.length; index++) {
      const item: unknown = finalOutput[index];
      if (record(item) && item.id != null) {
        if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new ResponsesResponseError('Duplicate or invalid output item identity');
        ids.add(item.id);
      }
      if (execution(item) && !items.get(index)?.final) throw new ResponsesResponseError('Untracked terminal execution snapshot');
      if (execution(item) && item.status != null && item.status !== 'completed') throw new ResponsesResponseError('Incomplete terminal execution item');
    }
    for (const [index, state] of lifecycle) {
      const item: unknown = finalOutput[index];
      if (!state.done || !record(item) || item.type !== state.type || (state.id != null && item.id !== state.id)) throw new ResponsesResponseError('Contradictory terminal output lifecycle');
    }
    return { output: finalOutput, ids };
  }
  async function finish(value: Record<string, unknown>): Promise<void> {
    if (!terminalState || !record(value.response)) throw new ResponsesResponseError('Missing validated terminal snapshot');
    const finalOutput = terminalState.output; const ids = terminalState.ids;
    reserve(items.size * 512 + 1024);
    const replacements = new Map<number, Record<string, unknown>>();
    for (const [index, item] of items) {
      const verdict = await bounded(item.decision!, decisionDeadline - Date.now(), signal);
      if (verdict.outcome !== 'allow') {
        reserve(32_768);
        let id: string; do { id = `msg_amp_${generated++}`; } while (ids.has(id));
        ids.add(id);
        replacements.set(index, blockedMessage(id, blockedText(item.call!, verdict)));
      }
    }
    if (signal.aborted) throw new ResponsesResponseError('Response cancelled');
    if (Date.now() >= decisionDeadline) throw new ResponsesResponseError('Decision deadline exceeded');
    const started = new Set<number>();
    for (const entry of queue) {
      const frame = entry.frame!; const event = entry.value;
      if (!event) output.push(frame.raw);
      else if (typeof event.output_index === 'number' && replacements.has(event.output_index)) {
        const index = event.output_index; const message = replacements.get(index)!;
        if (event.type === 'response.output_item.added') { blockChain(index, message, 'start'); started.add(index); }
        else if (event.type === 'response.output_item.done') {
          if (!started.has(index)) { blockChain(index, message, 'start'); started.add(index); }
          blockChain(index, message, 'done');
        }
        frame.release(); ownedRaw.delete(frame.raw);
      } else if (event === value && replacements.size) {
        reserve(finalOutput.length * 32 + 2048);
        const rewritten = { ...event, response: { ...value.response, output: finalOutput.map((item: unknown, index: number) => replacements.get(index) ?? item) } };
        emit(rewritten);
        frame.release();
        ownedRaw.delete(frame.raw);
      } else emit(event, frame);
      entry.frame = undefined; entry.value = undefined;
    }
    queue.length = 0;
    releaseRetained();
    clearTimeout(decisionTimer);
    keepalive.setHeld(false);
  }
  function process(frame: SseFrame): void {
    if (!frame.complete) throw new ResponsesResponseError('Incomplete SSE frame');
    if (!frame.data || frame.data === '[DONE]') {
      if (frame.data === '[DONE]' && !terminal) throw new ResponsesResponseError('Incomplete Responses turn');
      if (frame.data === '[DONE]' && held) { reserve(128); queue.push({ frame }); }
      else output.push(frame.raw);
      frame.releaseSemantic(); return;
    }
    if (frame.jsonComplete !== true || frame.jsonAmbiguous !== false) throw new ResponsesResponseError('Unclassifiable Responses event');
    // The parsed representation inherits the parser's validated-context classification.
    const rawReasoning = budget.claimBytes(frame.raw).reasoning;
    const parsedBytes = parsedBound(frame.data);
    const overhead = Math.max(0, parsedBytes - frame.data.length * 2);
    const parsed = reserve(parsedBytes, rawReasoning ? Math.min(parsedBytes, rawReasoning * 2 + overhead) : 0);
    let saved = false;
    try {
      const value: unknown = JSON.parse(frame.data);
      if (!record(value) || typeof value.type !== 'string') throw new ResponsesResponseError('Invalid Responses event');
      const type = value.type;
      if (frame.event && frame.event !== type) {
        const sensitive = (name: string): boolean => name.startsWith('response.output_item.') || name.startsWith('response.function_call_arguments.') || name.startsWith('response.custom_tool_call_input.') || name === 'response.completed' || name === 'response.incomplete';
        if (sensitive(frame.event) || sensitive(type)) throw new ResponsesResponseError('Conflicting execution event identity');
      }
      frame.releaseSemantic();
      const control = (type === 'error' || type === 'ping') && !['item', 'response', 'output', 'output_index', 'item_id', 'content_index', 'delta', 'part', 'arguments', 'input'].some(key => Object.hasOwn(value, key));
      if (terminal && !control) throw new ResponsesResponseError('Event after terminal Responses snapshot');
      const isTerminal = type === 'response.completed' || type === 'response.incomplete';
      if (record(value.response) && !isTerminal && Array.isArray(value.response.output) && value.response.output.some(execution)) throw new ResponsesResponseError('Untracked initial execution snapshot');
      if (Array.isArray(value.output) && value.output.some(execution)) throw new ResponsesResponseError('Untracked execution snapshot');
      if (isTerminal) {
        if (!record(value.response) || !Array.isArray(value.response.output)) throw new ResponsesResponseError('Invalid terminal Responses snapshot');
        if (value.response.status != null && value.response.status !== type.slice('response.'.length)) throw new ResponsesResponseError('Contradictory terminal response status');
        const validated = validateTerminal(value);
        terminalState = held ? validated : undefined;
      }
      if (record(value.item) && value.item.type === 'tool_search_call' && value.item.execution !== 'server') throw new ResponsesResponseError('Unsupported client tool-search execution');
      const isItem = type === 'response.output_item.added' || type === 'response.output_item.done';
      if (isItem) {
        const index = indexOf(value);
        if (!record(value.item) || typeof value.item.type !== 'string') throw new ResponsesResponseError('Invalid output item');
        const previous = lifecycle.get(index);
        if (type === 'response.output_item.added') {
          if (previous) throw new ResponsesResponseError('Repeated output item');
          reserve(512 + value.item.type.length * 2 + (typeof value.item.id === 'string' ? value.item.id.length * 2 : 0));
          lifecycle.set(index, { type: value.item.type, id: value.item.id, done: false });
        } else {
          if (previous && (previous.done || previous.type !== value.item.type || (previous.id != null && previous.id !== value.item.id))) throw new ResponsesResponseError('Contradictory completed output item');
          if (!previous) reserve(512 + value.item.type.length * 2 + (typeof value.item.id === 'string' ? value.item.id.length * 2 : 0));
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
            reserve(512);
            items.set(index, { initial: value.item, parameters: initial, parameterBytes, delta: false });
          } else complete(index, value.item);
        } else if (items.has(index)) throw new ResponsesResponseError('Contradictory execution item type');
      } else if (execution(value.item)) throw new ResponsesResponseError('Untracked execution item');
      else if (type.startsWith('response.function_call_arguments.') || type.startsWith('response.custom_tool_call_input.')) {
        const index = indexOf(value); const item = items.get(index);
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
          const next = reserve((item.parameters.length + value.delta.length) * 2 + 128);
          item.parameters += value.delta; release(item.parameterReservation); item.parameterReservation = next;
          item.parameterBytes += deltaBytes; item.delta = true;
        } else if (type.endsWith('.done')) {
          const parameters = expected === 'custom_tool_call' ? value.input : value.arguments;
          if (typeof parameters !== 'string' || utf8Bytes(parameters) > MAX_TOOL_BYTES || (item.delta && item.parameters !== parameters) || item.parametersDone !== undefined) throw new ResponsesResponseError('Contradictory completed parameters');
          item.parametersDone = parameters;
        } else throw new ResponsesResponseError('Unsupported execution parameter event');
      }
      if (type === 'response.failed') throw new ResponsesResponseError('Upstream Responses failure');
      if (held && !control) { reserve(128); queue.push({ frame, value }); saved = true; }
      else emit(value, frame);
      if (isTerminal) { terminal = true; terminalEvent = held ? value : undefined; }
    } finally { frame.releaseSemantic(); if (!saved) release(parsed); }
  }
  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      abortListener = () => {
        if (stopped) return;
        stopped = true; discard();
        const reason: unknown = signal.reason ?? new ResponsesResponseError('Response cancelled');
        controller.error(reason); void reader.cancel(reason).catch(() => undefined);
      };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    },
    async pull(controller) {
      try {
        while (!stopped) {
          if (signal.aborted) throw signal.reason ?? new ResponsesResponseError('Response cancelled');
          if (outputCursor < output.length) {
            const bytes = output[outputCursor]!; delete output[outputCursor++];
            if (outputCursor === output.length) { output.length = 0; outputCursor = 0; }
            controller.enqueue(bytes); return;
          }
          if (finished) { stopped = true; discard(); reader.releaseLock(); controller.close(); return; }
          const item = await bounded(reader.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByte), completionDeadline - Date.now()), signal);
          if (held && Date.now() >= completionDeadline) throw new ResponsesResponseError('Completion deadline exceeded');
          if (item.done) {
            if (!terminal) throw new ResponsesResponseError('Incomplete Responses turn');
            clearTimeout(completionTimer);
            if (held && terminalEvent) await finish(terminalEvent);
            finished = true; continue;
          }
          currentFrame = item.value; ownedRaw.add(item.value.raw);
          process(item.value); currentFrame = undefined;
        }
      } catch (error) {
        if (!stopped) { stopped = true; discard(); abort.abort(error); controller.error(error); await reader.cancel(error).catch(() => undefined); }
      }
    },
    async cancel(reason) { stopped = true; discard(); abort.abort(reason); await reader.cancel(reason).catch(() => undefined); },
  }, { highWaterMark: 0 });
  return keepalive.wrap(transformed, { delivered: releaseRaw, discarded: releaseRaw });
}
