import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import type { Verdict } from '../../gate/types.js';
import { parseSse, classifySseRetention, pingKeepalive, encodeSse, type SseFrame } from '../sse.js';
import { ResponseBudget, type ResponseAccounting, type ResponseReservation } from '../response-budget.js';
import { parsedBound } from '../openai-responses/nonstream.js';
import { ChatResponseError, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, MAX_TOOL_BYTES, COMPLETION_TIMEOUT_MS, IDLE_TIMEOUT_MS, bounded, blockedText, decide, unique, shadowStream, record, callFor, choiceOf, utf8Bytes, jsonBytes, reasoningSize } from './safety.js';

type Aggregate = { id: string; name: string; arguments: string; bytes: number; lease: ResponseReservation; type?: string };
type Held = { frame: SseFrame; value?: Record<string, unknown>; split?: boolean };

export function transformChatStream(source: ReadableStream<Uint8Array>, context: RequestContext, options: AdapterOptions, accounting?: ResponseAccounting): ReadableStream<Uint8Array> {
  if (options.mode === 'shadow') return shadowStream(source, async (observed, budget, signal) => {
    for await (const chunk of transformChatStream(observed, context, { ...options, mode: 'enforce', signal: AbortSignal.any([options.signal, signal]) }, { budget })) void chunk;
  }, options.trackObservation);
  const budget = accounting?.budget ?? new ResponseBudget(MAX_RESPONSE_BYTES, MAX_REASONING_BYTES);
  const retained = new Set<ResponseReservation>();
  const generated = new Map<Uint8Array, ResponseReservation>();
  const owned = new Set<Uint8Array>();
  const tools = new Map<number, Aggregate>();
  const held: Held[] = [];
  const output: Uint8Array[] = [];
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const original = source.getReader();
  let released = false;
  let lastByte = Date.now();
  let deadline = Infinity;
  let timer: NodeJS.Timeout | undefined;
  let terminal = false;
  let done = false;
  let finished = false;
  let stopped = false;
  let outputCursor = 0;
  let readerReleased = false;
  let current: SseFrame | undefined;
  let terminalValue: Record<string, unknown> | undefined;
  const calls: ToolCall[] = [];
  const byIndex = new Map<number, ToolCall>();
  let pendingDecisions: Promise<Map<string, Verdict>> | undefined;
  const keepalive = pingKeepalive(options.holdKeepaliveMs ?? 10_000);
  const releaseOriginal = (): void => { if (!released) { released = true; original.releaseLock(); } };
  const timed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await bounded(original.read(), IDLE_TIMEOUT_MS - (Date.now() - lastByte), signal);
        if (Date.now() - lastByte >= IDLE_TIMEOUT_MS) throw new ChatResponseError('Chat idle deadline exceeded');
        if (item.done) { releaseOriginal(); controller.close(); }
        else { if (item.value.byteLength) lastByte = Date.now(); controller.enqueue(item.value); }
      } catch (error) {
        controller.error(error);
        if (!released) { try { await original.cancel(error); } catch { /* Preserve original failure. */ } finally { releaseOriginal(); } }
      }
    },
    async cancel(reason) { if (!released) { try { await original.cancel(reason); } catch { /* Cancellation is terminal. */ } finally { releaseOriginal(); } } },
  }, { highWaterMark: 0 });
  const reader = parseSse(timed, { budget, potentialReasoning: true, classifyRetention: (raw, partial) => classifySseRetention(raw, 'chat', undefined, budget, partial) }).getReader();
  function reserve(bytes: number, reasoning = 0): ResponseReservation { const lease = budget.reserve(bytes, reasoning); retained.add(lease); return lease; }
  function release(lease: ResponseReservation): void { lease.release(); retained.delete(lease); }
  function releaseBytes(bytes: Uint8Array): void {
    owned.delete(bytes); budget.releaseBytes(bytes);
    const lease = generated.get(bytes);
    if (lease) { retained.delete(lease); generated.delete(bytes); }
  }
  function emit(value: Record<string, unknown>, frame?: SseFrame): void {
    const size = jsonBytes(value);
    const reasoning = reasoningSize(value);
    const headers = utf8Bytes(frame?.event ?? '') + utf8Bytes(frame?.id ?? '') + 32;
    let properties = 0;
    for (const key in value) if (Object.hasOwn(value, key)) properties++;
    const peak = size * 5 + headers * 3 + properties * 128 + 2048;
    const lease = reserve(peak, Math.min(peak, reasoning * 5));
    try {
      const bytes = encodeSse({ data: JSON.stringify(value), ...(frame?.event === undefined ? {} : { event: frame.event }), ...(frame?.id === undefined ? {} : { id: frame.id }) });
      lease.resize(bytes.byteLength, Math.min(bytes.byteLength, reasoning)); budget.registerBytes(bytes, lease); generated.set(bytes, lease); owned.add(bytes); output.push(bytes);
    } catch (error) { release(lease); throw error; }
  }
  function raw(frame: SseFrame): void { owned.add(frame.raw); output.push(frame.raw); }
  function barrier(): void {
    if (deadline !== Infinity) return;
    deadline = Date.now() + COMPLETION_TIMEOUT_MS;
    timer = setTimeout(() => abort.abort(new ChatResponseError('Chat completion deadline exceeded')), COMPLETION_TIMEOUT_MS);
    keepalive.setHeld(true);
  }
  function cleanup(): void {
    clearTimeout(timer); keepalive.close(); current?.release(); current = undefined;
    for (const entry of held) entry.frame.release(); held.length = 0;
    for (const bytes of owned) budget.releaseBytes(bytes); owned.clear(); output.length = 0;
    generated.clear();
    for (const lease of retained) lease.release(); retained.clear(); tools.clear();
    signal.removeEventListener('abort', onAbort);
    outputCursor = 0;
    if (!accounting) budget.close();
  }
  function process(frame: SseFrame): void {
    if (!frame.complete) throw new ChatResponseError('Incomplete Chat SSE frame');
    if (frame.data === undefined || frame.data === '') { raw(frame); frame.releaseSemantic(); return; }
    if (frame.data === '[DONE]') {
      if (!terminal || done) throw new ChatResponseError('Unexpected Chat DONE');
      done = true; held.push({ frame }); frame.releaseSemantic(); return;
    }
    if (done) throw new ChatResponseError('Chat data after DONE');
    if (frame.jsonComplete === false || frame.jsonAmbiguous) throw new ChatResponseError('Invalid Chat SSE JSON');
    const parsedSize = parsedBound(frame.data);
    const parsed = reserve(parsedSize + 256, Math.min(parsedSize, frame.raw.byteLength));
    let value: unknown;
    try { value = JSON.parse(frame.data); } catch { throw new ChatResponseError('Invalid Chat SSE JSON'); }
    const choice = choiceOf(value, true);
    if (!record(value)) throw new ChatResponseError('Invalid Chat chunk');
    parsed.resize(parsed.bytes, Math.min(parsed.bytes, reasoningSize(value) * 2 + (reasoningSize(value) ? 256 : 0)));
    if (!choice) {
      held.push({ frame, value }); frame.releaseSemantic(); return;
    }
    if (terminal) throw new ChatResponseError('Chat choice after finish');
    if (!record(choice.delta)) throw new ChatResponseError('Invalid Chat delta');
    const delta = choice.delta;
    const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    const indices: number[] = [];
    for (const fragment of fragments) {
      barrier();
      if (!record(fragment) || typeof fragment.index !== 'number' || !Number.isSafeInteger(fragment.index) || fragment.index < 0 || indices.includes(fragment.index)) throw new ChatResponseError('Invalid Chat tool index');
      const index = fragment.index; indices.push(index);
      if (Object.keys(fragment).some(key => !['index', 'id', 'type', 'function'].includes(key))) throw new ChatResponseError('Unsupported Chat tool fragment');
      let tool = tools.get(index);
      if (!tool) { tool = { id: '', name: '', arguments: '', bytes: 0, lease: reserve(512) }; tools.set(index, tool); }
      if (fragment.type !== undefined) {
        if (fragment.type !== 'function' || tool.type !== undefined && tool.type !== fragment.type) throw new ChatResponseError('Unsupported Chat tool type');
        tool.type = fragment.type;
      }
      if (fragment.function !== undefined && !record(fragment.function)) throw new ChatResponseError('Invalid Chat function delta');
      const fn = record(fragment.function) ? fragment.function : {};
      if (Object.keys(fn).some(key => !['name', 'arguments'].includes(key))) throw new ChatResponseError('Unsupported Chat function fragment');
      const id = fragment.id === undefined ? '' : fragment.id;
      const name = fn.name === undefined ? '' : fn.name;
      const args = fn.arguments === undefined ? '' : fn.arguments;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof args !== 'string') throw new ChatResponseError('Invalid Chat execution fragment');
      const additional = utf8Bytes(id) + utf8Bytes(name) + utf8Bytes(args);
      if (tool.bytes + additional > MAX_TOOL_BYTES) throw new ChatResponseError('Chat tool exceeds 1 MiB');
      const next = reserve((tool.id.length + id.length + tool.name.length + name.length + tool.arguments.length + args.length) * 2 + 512);
      tool.id += id; tool.name += name; tool.arguments += args; tool.bytes += additional; release(tool.lease); tool.lease = next;
    }
    const finish = choice.finish_reason;
    if (finish != null) {
      if (tools.size && finish !== 'tool_calls' || !tools.size && finish === 'tool_calls') throw new ChatResponseError('Incomplete Chat execution finish');
      terminal = true; terminalValue = value;
      for (const [index, tool] of tools) {
        reserve(parsedBound(tool.arguments) + 512);
        const call = callFor({ id: tool.id, type: tool.type, function: { name: tool.name, arguments: tool.arguments } });
        calls.push(call); byIndex.set(index, call);
      }
      unique(calls);
      pendingDecisions = decide(calls, context, { ...options, signal });
      void pendingDecisions.catch(() => undefined);
    }
    if (fragments.length || finish != null) {
      const safeDelta = { ...delta }; delete safeDelta.tool_calls;
      const split = Object.keys(safeDelta).length > 0;
      if (split) emit({ ...value, choices: [{ ...choice, delta: safeDelta, finish_reason: null }], usage: undefined }, frame);
      held.push({ frame, value, split });
    } else if (tools.size) {
      if (Object.keys(delta).length > 0 && value.usage == null) {
        raw(frame); release(parsed);
      } else if (Object.keys(delta).length > 0) {
        emit({ ...value, choices: [{ ...choice, delta }], usage: undefined }, frame);
        held.push({ frame, value, split: true });
      } else held.push({ frame, value });
    } else { raw(frame); release(parsed); }
    frame.releaseSemantic();
  }
  async function finish(): Promise<void> {
    if (!terminal || !done) throw new ChatResponseError('Incomplete Chat turn');
    clearTimeout(timer);
    if (!pendingDecisions) throw new ChatResponseError('Missing Chat terminal decisions');
    const decisions = await pendingDecisions;
    const denied = new Set<number>();
    for (const [index, call] of byIndex) if (decisions.get(call.id)?.outcome !== 'allow') denied.add(index);
    let explained = false;
    for (const entry of held) {
      if (!entry.value) { raw(entry.frame); continue; }
      const value = entry.value;
      const choice = choiceOf(value, true);
      if (!choice) { raw(entry.frame); continue; }
      if (!record(choice.delta)) throw new ChatResponseError('Invalid retained Chat delta');
      if (choice.finish_reason != null && denied.size && !explained) {
        if (!terminalValue) throw new ChatResponseError('Missing Chat terminal metadata');
        for (const [index, call] of byIndex) if (denied.has(index)) {
          const verdict = decisions.get(call.id);
          if (!verdict) throw new ChatResponseError('Missing Chat decision');
          const explanation = reserve(32_768);
          emit({ ...terminalValue, choices: [{ ...choice, delta: { content: blockedText(call, verdict) }, finish_reason: null }], usage: undefined });
          release(explanation);
        }
        explained = true;
      }
      const delta = choice.delta;
      const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      const allowed = fragments.filter(fragment => record(fragment) && !denied.has(Number(fragment.index)));
      const changed = !!entry.split || allowed.length !== fragments.length || denied.size === tools.size && tools.size > 0 && choice.finish_reason === 'tool_calls';
      if (!changed) { raw(entry.frame); continue; }
      const nextDelta: Record<string, unknown> = entry.split ? {} : { ...delta };
      if (allowed.length) Object.assign(nextDelta, { tool_calls: allowed });
      else if ('tool_calls' in nextDelta) delete nextDelta.tool_calls;
      const nextFinish = choice.finish_reason === 'tool_calls' && denied.size === tools.size ? 'stop' : choice.finish_reason;
      if (Object.keys(nextDelta).length || nextFinish != null || value.usage != null) emit({ ...value, choices: [{ ...choice, delta: nextDelta, finish_reason: nextFinish }] }, entry.frame);
      entry.frame.release();
    }
    finished = true; keepalive.setHeld(false);
  }
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  function onAbort(): void {
    if (stopped) return;
    stopped = true; cleanup(); controllerRef?.error(signal.reason ?? new ChatResponseError('Chat cancelled'));
    void reader.cancel(signal.reason).catch(() => undefined).finally(unlock);
  }
  function unlock(): void { if (!readerReleased) { readerReleased = true; reader.releaseLock(); } }
  const transformed = new ReadableStream<Uint8Array>({
    start(controller) { controllerRef = controller; signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); },
    async pull(controller) {
      try {
        while (!stopped) {
          if (signal.aborted) throw signal.reason;
          const bytes = output[outputCursor];
          if (bytes) {
            delete output[outputCursor++];
            if (outputCursor === output.length) { output.length = 0; outputCursor = 0; }
            controller.enqueue(bytes); return;
          }
          if (finished) { stopped = true; cleanup(); unlock(); controller.close(); return; }
          const item = await bounded(reader.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByte), deadline - Date.now()), signal);
          if (item.done) { await finish(); continue; }
          current = item.value; process(item.value); current = undefined;
        }
      } catch (error) { if (!stopped) { stopped = true; cleanup(); abort.abort(error); controller.error(error); await reader.cancel(error).catch(() => undefined); unlock(); } }
    },
    async cancel(reason) { stopped = true; cleanup(); abort.abort(reason); await reader.cancel(reason).catch(() => undefined); unlock(); },
  }, { highWaterMark: 0 });
  return keepalive.wrap(transformed, { delivered: releaseBytes, discarded: releaseBytes });
}
