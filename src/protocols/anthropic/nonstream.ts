import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { AnthropicResponseError, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, decide, blockedText, safeguardResults, shadowStream, bounded, record, toolCall, unique } from './safety.js';
import { ResponseBudget, type ResponseAccounting, type ResponseReservation } from '../response-budget.js';
import { JsonRetentionScanner } from '../json-retention.js';

export function extractAnthropicToolCalls(value: unknown): ToolCall[] {
  if (!record(value)) return [];
  if (!Array.isArray(value.content)) {
    if (value.type === 'message') throw new AnthropicResponseError('Invalid message content', 'unparseable');
    return [];
  }
  if (value.type !== 'message') {
    if (value.content.some((block: unknown) => record(block) && block.type === 'tool_use')) throw new AnthropicResponseError('Invalid execution message identity');
    return [];
  }
  const calls: ToolCall[] = [];
  for (const block of value.content) {
    if (record(block) && block.type === 'tool_use') calls.push(toolCall(block));
  }
  unique(calls);
  return calls;
}

/** JSON text size in UTF-8 bytes or UTF-16 code units, without serializing it. */
function stringSize(value: string, utf16: boolean): number {
  let size = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) size += 2;
    else if (code < 32) size += 6;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { size += utf16 ? 2 : 4; index++; }
    else if (code >= 0xd800 && code <= 0xdfff) size += 6;
    else if (utf16 || code < 128) size++;
    else size += code < 2048 ? 2 : 3;
  }
  return size;
}

function jsonSize(value: unknown, utf16: boolean): number {
  if (typeof value === 'string') return stringSize(value, utf16);
  if (value === null) return 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (Array.isArray(value)) {
    let size = 2 + Math.max(0, value.length - 1);
    for (const item of value) size += jsonSize(item, utf16);
    return size;
  }
  let size = 2;
  let count = 0;
  if (record(value)) for (const key in value) {
    if (Object.hasOwn(value, key)) size += (count++ ? 1 : 0) + stringSize(key, utf16) + 1 + jsonSize(value[key], utf16);
  }
  return size;
}

export function jsonBytes(value: unknown): number { return jsonSize(value, false); }
export function jsonCharacters(value: unknown): number { return jsonSize(value, true); }

function stringEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index++;
    else if (source[index] === '"') return index + 1;
  }
  return source.length;
}
function reasoning(block: unknown): boolean {
  return record(block) && (block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'signature' || 'signature' in block);
}


/** Bound decoded strings and lexical structure before parsing, without copying payloads. */
export function parsedBound(source: string, start = 0, end = source.length): number {
  let bytes = (end - start) * 2;
  for (let index = start; index < end; index++) {
    const char = source[index]!;
    if (char === '"') { bytes += 128; index = stringEnd(source, index) - 1; }
    else if (char === '{' || char === '[' || char === ':') bytes += 128;
    else if (char !== '}' && char !== ']' && char !== ',' && char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') {
      bytes += 128;
      while (index + 1 < end && !',]} \n\r\t'.includes(source[index + 1]!)) index++;
    }
  }
  return bytes;
}

function parsedValueBound(value: unknown): number {
  if (typeof value === 'string') return value.length * 2 + 128;
  if (Array.isArray(value)) { let bytes = 128; for (const item of value) bytes += parsedValueBound(item); return bytes; }
  if (record(value)) {
    let bytes = 128;
    for (const key in value) if (Object.hasOwn(value, key)) bytes += key.length * 2 + 256 + parsedValueBound(value[key]);
    return bytes;
  }
  return 128;
}

export async function transformAnthropicNonstream(response: Response, context: RequestContext, options: AdapterOptions, accounting?: ResponseAccounting): Promise<Response> {
  if (!response.body) return response;
  if (options.mode === 'shadow') {
    const body = shadowStream(response.body, async (source, budget, signal) => {
      const observed = await transformAnthropicNonstream(new Response(source), context, { ...options, mode: 'enforce', signal: AbortSignal.any([options.signal, signal]), onNativeDelivered: undefined }, { budget });
      await observed.body?.cancel();
    }, options.trackObservation);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const budget = accounting?.budget ?? new ResponseBudget(MAX_RESPONSE_BYTES, MAX_REASONING_BYTES);
  const leases: ResponseReservation[] = [];
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const scanner = new JsonRetentionScanner('anthropic', 'response', budget);
  let size = 0;
  let retainedBytes = 0;
  let retainedReasoning = 0;
  let outputTransferred = false;
  let rawLease: ResponseReservation | undefined;
  let incoming: Uint8Array | undefined;
  const retained = budget.reserve(0);
  const chunkMetadata = budget.reserve(0);
  function reserve(bytes: number, reasoning = 0): void {
    retained.resize(retainedBytes + bytes, retainedReasoning + reasoning);
    retainedBytes += bytes;
    retainedReasoning += reasoning;
  }
  function release(bytes: number, reasoning = 0): void {
    retained.resize(retainedBytes - bytes, retainedReasoning - reasoning);
    retainedBytes -= bytes;
    retainedReasoning -= reasoning;
  }
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let lastByteAt = Date.now();
  try {
    while (true) {
      const item = await bounded(reader.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByteAt), deadline - Date.now()), options.signal);
      if (item.done) break;
      if (!item.value.byteLength) { budget.releaseBytes(item.value); continue; }
      incoming = item.value;
      const lease = budget.claimBytes(incoming);
      chunkMetadata.resize((chunks.length + 1) * 128);
      if (item.value.byteLength) lastByteAt = Date.now();
      incoming = undefined;
      leases.push(lease);
      scanner.feed(item.value);
      const classification = scanner.snapshot();
      let pending = classification.ambiguous ? size + item.value.byteLength : classification.reasoningBytes + classification.pendingBytes;
      for (const allocation of leases) allocation.resize(allocation.bytes, 0);
      for (const allocation of leases) { const amount = Math.min(allocation.bytes, pending); allocation.resize(allocation.bytes, amount); pending -= amount; }
      size += item.value.byteLength;
      chunks.push(item.value);
    }
    const classification = scanner.finish();
    const rawReasoningBytes = classification.ambiguous ? size : classification.reasoningBytes + classification.pendingBytes;
    let remainingReasoning = rawReasoningBytes;
    for (const lease of leases) lease.resize(lease.bytes, 0);
    for (const lease of leases) { const amount = Math.min(lease.bytes, remainingReasoning); lease.resize(lease.bytes, amount); remainingReasoning -= amount; }
    let bytes: Uint8Array | undefined;
    if (chunks.length === 1) {
      bytes = chunks.pop()!;
      rawLease = leases.pop()!;
    } else {
      rawLease = budget.reserve(size, rawReasoningBytes);
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      chunks.length = 0;
      for (const lease of leases) lease.release();
      leases.length = 0;
    }
    chunkMetadata.resize(0);
    reserve(size * 2, rawReasoningBytes * 2);
    let json: string;
    try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new AnthropicResponseError('Unparseable nonstream response', 'unparseable'); }
    const parsedReservation = parsedBound(json);
    const reasoningReservation = { raw: rawReasoningBytes, parsed: rawReasoningBytes ? Math.min(parsedReservation, rawReasoningBytes * 2 + parsedReservation - json.length * 2) : 0 };
    let reasoningBytes = reasoningReservation.raw * 3 + reasoningReservation.parsed;
    reserve(parsedReservation, reasoningReservation.parsed);
    let value: unknown;
    try { value = JSON.parse(json); }
    catch { throw new AnthropicResponseError('Unparseable nonstream response', 'unparseable'); }
    let validationBytes = 0;
    reasoningBytes = reasoningReservation.raw * 3;
    if (record(value) && Array.isArray(value.content)) {
      // Keep the decoded reasoning reservation until the complete source is discarded below.
      for (const block of value.content) {
        if (reasoning(block)) reasoningBytes += parsedValueBound(block);
        if (record(block) && block.type === 'tool_use') {
          const inputBytes = jsonBytes(block.input);
          if (inputBytes > MAX_TOOL_BYTES) throw new AnthropicResponseError('Tool input exceeds 1 MiB');
          validationBytes = Math.max(validationBytes, jsonCharacters(block.input) * 2 + inputBytes);
        }
      }
      if (reasoningBytes > MAX_REASONING_BYTES) throw new AnthropicResponseError('Nonstream reasoning exceeds 4 MiB');
    }
    const parsedReasoning = reasoningBytes - reasoningReservation.raw * 3;
    retained.resize(retainedBytes, retainedReasoning - reasoningReservation.parsed + parsedReasoning);
    retainedReasoning += parsedReasoning - reasoningReservation.parsed;
    json = '';
    release(size * 2, reasoningReservation.raw * 2);
    reasoningBytes -= reasoningReservation.raw * 2;
    // Existing tool validation serializes one shared parsed input at a time; it does not copy that input.
    reserve(validationBytes);
    const calls = extractAnthropicToolCalls(value);
    release(validationBytes);
    const callById = new Map(calls.map(call => [call.id, call]));
    const decisions = await decide(calls, context, options);
    let changed = false;
    if (record(value)) {
      if ('safeguard_results' in value) { delete value.safeguard_results; changed = true; }
      if (record(value.delta) && 'safeguard_results' in value.delta) { delete value.delta.safeguard_results; changed = true; }
      if (value.type === 'message' && options.delivery === 'native' && context.safeguards !== undefined) {
        let resultReservation = 2048;
        for (const call of calls) resultReservation += call.id.length * 2 + 2048 + (decisions.get(call.id)?.outcome === 'allow' ? 0 : 32 * 1024);
        reserve(resultReservation);
        const results = safeguardResults(calls, decisions);
        release(resultReservation - parsedValueBound(results) - 128);
        value.safeguard_results = results;
        changed = true;
      } else if (Array.isArray(value.content)) {
        let allowed = 0;
        value.content = value.content.map((block: unknown) => {
          if (!record(block) || block.type !== 'tool_use') return block;
          const verdict = decisions.get(block.id as string)!;
          if (verdict.outcome === 'allow') { allowed += 1; return block; }
          changed = true;
          // Explanation/name lengths are bounded; reserve their worst escaped JSON form before construction.
          const replacementReservation = 32 * 1024;
          reserve(replacementReservation);
          const replacement = { type: 'text', text: blockedText(callById.get(block.id as string)!, verdict) };
          release(replacementReservation - parsedValueBound(replacement));
          return replacement;
        });
        if (calls.length && !allowed) { value.stop_reason = 'end_turn'; changed = true; }
      }
    }
    const headers = new Headers(response.headers);
    if (changed) headers.delete('content-length');
    let output: Uint8Array | undefined = bytes;
    let outputReasoning = rawReasoningBytes;
    if (changed) {
      let outputReasoningBytes = 0;
      let outputReasoningUnits = 0;
      if (record(value) && Array.isArray(value.content)) {
        for (const block of value.content) if (reasoning(block)) { outputReasoningBytes += jsonBytes(block); outputReasoningUnits += jsonCharacters(block); }
      }
      const serializedReasoning = outputReasoningUnits * 2;
      if (reasoningBytes + serializedReasoning + outputReasoningBytes > MAX_REASONING_BYTES) throw new AnthropicResponseError('Nonstream reasoning exceeds 4 MiB');
      const outputBytes = jsonBytes(value);
      const serializedBytes = jsonCharacters(value) * 2;
      // The original raw response and parsed/tool representations are still retained here.
      // Reserve BOTH serialized JSON and its encoded replacement before allocating either.
      reserve(serializedBytes + outputBytes, serializedReasoning + outputReasoningBytes);
      output = new TextEncoder().encode(JSON.stringify(value));
      release(serializedBytes, serializedReasoning);
      outputReasoning = outputReasoningBytes;
    }
    const native = record(value) && value.type === 'message' && options.delivery === 'native' && context.safeguards !== undefined;
    let outputLease: ResponseReservation;
    if (changed) {
      release(output.byteLength, outputReasoning);
      outputLease = budget.reserve(output.byteLength, outputReasoning);
    } else {
      outputLease = rawLease!;
      rawLease = undefined;
    }
    budget.registerBytes(output, outputLease);
    let pending: Uint8Array | undefined = output;
    outputTransferred = true;
    bytes = undefined;
    rawLease?.release();
    rawLease = undefined;
    output = undefined;
    value = undefined;
    calls.length = 0;
    callById.clear();
    const cleanup = (): void => {
      pending = undefined;
      outputLease.release();
      if (!accounting) budget.close();
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pending) {
          const chunk = pending;
          pending = undefined;
          controller.enqueue(chunk);
          outputLease.release();
        } else {
          cleanup();
          if (native && !options.signal.aborted) options.onNativeDelivered?.();
          controller.close();
        }
      },
      cancel() { cleanup(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    scanner.finish();
    if (incoming) budget.releaseBytes(incoming);
    chunks.length = 0;
    chunkMetadata.release();
    for (const lease of leases) lease.release();
    retained.release();
    rawLease?.release();
    if (!accounting && !outputTransferred) budget.close();
    reader.releaseLock();
  }
}
