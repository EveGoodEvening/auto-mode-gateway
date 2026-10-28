import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { JsonRetentionScanner } from '../json-retention.js';
import { ResponseBudget, type ResponseAccounting, type ResponseReservation } from '../response-budget.js';
import { parsedBound } from '../openai-responses/nonstream.js';
import { ChatResponseError, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, COMPLETION_TIMEOUT_MS, IDLE_TIMEOUT_MS, bounded, blockedText, decide, unique, shadowStream, record, callFor, choiceOf, jsonBytes, reasoningSize } from './safety.js';

export async function transformChatNonstream(response: Response, context: RequestContext, options: AdapterOptions, accounting?: ResponseAccounting): Promise<Response> {
  if (!response.body) throw new ChatResponseError('Missing Chat body');
  if (options.mode === 'shadow') return new Response(shadowStream(response.body, async (source, budget, signal) => {
    const observed = await transformChatNonstream(new Response(source, { headers: { 'content-type': 'application/json' } }), context, { ...options, mode: 'enforce', signal: AbortSignal.any([options.signal, signal]) }, { budget });
    await observed.body?.cancel();
  }, options.trackObservation), { status: response.status, statusText: response.statusText, headers: response.headers });
  const budget = accounting?.budget ?? new ResponseBudget(MAX_RESPONSE_BYTES, MAX_REASONING_BYTES);
  const leases: ResponseReservation[] = [];
  const chunks: Uint8Array[] = [];
  const raws: ResponseReservation[] = [];
  const reader = response.body.getReader();
  let scanner: JsonRetentionScanner | undefined;
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let total = 0;
  let complete = false;
  let lastByte = Date.now();
  let charged = 0;
  let cursor = 0;
  try {
    const metadata = budget.reserve(0); leases.push(metadata);
    scanner = new JsonRetentionScanner('chat', 'response', budget);
    while (true) {
      const item = await bounded(reader.read(), Math.min(deadline - Date.now(), IDLE_TIMEOUT_MS - (Date.now() - lastByte)), options.signal);
      if (Date.now() >= deadline || Date.now() - lastByte >= IDLE_TIMEOUT_MS) throw new ChatResponseError('Chat collection deadline exceeded');
      if (item.done) break;
      const raw = budget.claimBytes(item.value); raws.push(raw);
      if (raw.reasoning) raw.resize(raw.bytes, 0);
      metadata.resize(metadata.bytes + 32);
      if (item.value.byteLength) lastByte = Date.now();
      scanner.feed(item.value);
      const state = scanner.snapshot();
      const reasoning = state.reasoningBytes + state.pendingBytes;
      while (charged < reasoning) {
        const lease = raws[cursor];
        if (!lease) throw new ChatResponseError('Missing Chat input allocation');
        const amount = Math.min(lease.bytes - lease.reasoning, reasoning - charged);
        lease.resize(lease.bytes, lease.reasoning + amount); charged += amount;
        if (lease.reasoning === lease.bytes) cursor++;
      }
      while (charged > reasoning) {
        if (cursor === raws.length || raws[cursor]?.reasoning === 0) cursor--;
        const lease = raws[cursor];
        if (!lease) throw new ChatResponseError('Missing Chat reasoning allocation');
        const amount = Math.min(lease.reasoning, charged - reasoning);
        lease.resize(lease.bytes, lease.reasoning - amount); charged -= amount;
      }
      total += item.value.byteLength; chunks.push(item.value);
    }
    const state = scanner.finish();
    if (!state.complete || state.ambiguous) throw new ChatResponseError('Invalid Chat JSON');
    const contiguous = budget.reserve(total, state.reasoningBytes); leases.push(contiguous);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    for (const raw of raws) raw.release();
    const decoded = budget.reserve(total * 2, state.reasoningBytes * 2); leases.push(decoded);
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsedSize = parsedBound(text);
    const parsed = budget.reserve(parsedSize, Math.min(parsedSize, state.reasoningBytes * 2 + (state.reasoningBytes ? 256 : 0))); leases.push(parsed);
    const value: unknown = JSON.parse(text); text = ''; decoded.release();
    const choice = choiceOf(value, false);
    if (!record(value) || !choice || !record(choice.message)) throw new ChatResponseError('Invalid Chat message');
    const message = choice.message;
    const tools = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const calls: ToolCall[] = [];
    for (const tool of tools) {
      if (record(tool) && record(tool.function) && typeof tool.function.arguments === 'string') leases.push(budget.reserve(parsedBound(tool.function.arguments)));
      leases.push(budget.reserve(512)); calls.push(callFor(tool));
    }
    unique(calls);
    if (calls.length && choice.finish_reason !== 'tool_calls') throw new ChatResponseError('Incomplete Chat execution');
    if (!calls.length && choice.finish_reason === 'tool_calls') throw new ChatResponseError('Missing Chat execution');
    if (choice.finish_reason == null) throw new ChatResponseError('Missing Chat finish reason');
    const decisions = await decide(calls, context, options);
    const denied = calls.filter(call => decisions.get(call.id)?.outcome !== 'allow');
    let output = bytes;
    if (denied.length) {
      const rewritten = budget.reserve(jsonBytes(value) * 5 + denied.length * 96_000 + 1024, reasoningSize(value) * 5); leases.push(rewritten);
      const remaining = tools.filter(tool => !denied.some(call => call.raw === tool));
      message.tool_calls = remaining;
      const explanations = denied.map(call => {
        const verdict = decisions.get(call.id);
        if (!verdict) throw new ChatResponseError('Missing Chat decision');
        return blockedText(call, verdict);
      }).join('\n');
      message.content = `${typeof message.content === 'string' ? message.content : ''}${explanations}`;
      if (remaining.length === 0) { delete message.tool_calls; choice.finish_reason = 'stop'; }
      output = new TextEncoder().encode(JSON.stringify(value));
      rewritten.resize(output.byteLength, Math.min(output.byteLength, reasoningSize(value)));
    }
    const headers = new Headers(response.headers);
    if (denied.length) headers.delete('content-length');
    leases.push(budget.reserve(output.byteLength, Math.min(output.byteLength, reasoningSize(value))));
    const result = new Response(output, { status: response.status, statusText: response.statusText, headers });
    complete = true;
    return result;
  } catch (error) {
    try { await reader.cancel(error); } catch { /* Preserve the protocol failure. */ }
    throw error;
  } finally {
    scanner?.finish(); reader.releaseLock();
    for (const lease of raws) lease.release();
    for (const lease of leases) lease.release();
    if (!accounting) budget.close();
    if (!complete) chunks.length = 0;
  }
}
