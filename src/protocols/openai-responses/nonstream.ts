import type { AdapterOptions, RequestContext } from '../types.js';
import { ResponsesResponseError, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, DECISION_TIMEOUT_MS, bounded, blockedText, decide, execution, callFor, unique, record, blockedMessage, jsonBytes, shadowStream } from './safety.js';
import { JsonRetentionScanner } from '../json-retention.js';
import { ResponseBudget, type ResponseAccounting, type ResponseReservation } from '../response-budget.js';

function stringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === '"') return i + 1;
  }
  return source.length;
}
function space(source: string, start: number): number {
  while ([' ', '\n', '\r', '\t'].includes(source[start] ?? '')) start++;
  return start;
}
function valueEnd(source: string, start: number): number {
  if (source[start] === '"') return stringEnd(source, start);
  if (source[start] === '{' || source[start] === '[') {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '"') i = stringEnd(source, i) - 1;
      else if (source[i] === '{' || source[i] === '[') depth++;
      else if ((source[i] === '}' || source[i] === ']') && --depth === 0) return i + 1;
    }
    return source.length;
  }
  let end = start;
  while (end < source.length && ![',', '}', ']', ' ', '\n', '\r', '\t'].includes(source[end]!)) end++;
  return end;
}
/** Bound decoded string storage plus object, property, array and scalar slots. */
export function parsedBound(source: string, start = 0, end = source.length): number {
  let size = (end - start) * 2;
  for (let i = start; i < end; i++) {
    const char = source[i]!;
    if (char === '"') { size += 128; i = stringEnd(source, i) - 1; }
    else if (char === '{' || char === '[' || char === ':') size += 128;
    else if ('-0123456789tfn'.includes(char)) {
      size += 128;
      while (i + 1 < end && ![',', '}', ']', ' ', '\n', '\r', '\t'].includes(source[i + 1]!)) i++;
    }
  }
  return size;
}
/** Locate a direct JSON property without parsing/copying its payload. Last duplicate wins. */
function propertySpan(source: string, key: string, start = 0): [number, number] | undefined {
  let cursor = space(source, start);
  if (source[cursor++] !== '{') return undefined;
  cursor = space(source, cursor);
  let found: [number, number] | undefined;
  while (source[cursor] === '"') {
    const end = stringEnd(source, cursor);
    const field: unknown = end - cursor <= key.length * 6 + 2 ? JSON.parse(source.slice(cursor, end)) : undefined;
    const value = space(source, space(source, end) + 1);
    const stop = valueEnd(source, value);
    if (field === key) found = [value, stop];
    cursor = space(source, stop);
    if (source[cursor] !== ',') break;
    cursor = space(source, cursor + 1);
  }
  return found;
}
/** Reserve only the parsed representation of actual LAST-typed reasoning items. */
function reasoningParsedBound(source: string): number {
  const output = propertySpan(source, 'output');
  if (!output || source[output[0]] !== '[') return 0;
  let size = 0;
  let cursor = space(source, output[0] + 1);
  while (cursor < output[1] && source[cursor] !== ']') {
    const stop = valueEnd(source, cursor);
    const type = propertySpan(source, 'type', cursor);
    if (type && type[1] - type[0] <= 'reasoning'.length * 6 + 2 && JSON.parse(source.slice(type[0], type[1])) === 'reasoning') size += parsedBound(source, cursor, stop);
    cursor = space(source, stop);
    if (source[cursor] !== ',') break;
    cursor = space(source, cursor + 1);
  }
  return size;
}

export async function transformResponsesNonstream(response: Response, context: RequestContext, options: AdapterOptions, accounting?: ResponseAccounting): Promise<Response> {
  if (!response.body) return response;
  if (options.mode === 'shadow') {
    return new Response(shadowStream(response.body, async (source, budget, signal) => {
      const observed = await transformResponsesNonstream(new Response(source, { headers: { 'content-type': 'application/json' } }), context, { ...options, mode: 'enforce', signal: AbortSignal.any([options.signal, signal]) }, { budget });
      await observed.body?.cancel();
    }, options.trackObservation), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const budget = accounting?.budget ?? new ResponseBudget(MAX_RESPONSE_BYTES, MAX_REASONING_BYTES);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let rawLeases: ResponseReservation[] = [];
  const leases: ResponseReservation[] = [];
  let scanner: JsonRetentionScanner | undefined;
  let size = 0;
  let reasoning: number;
  let chargedReasoning = 0;
  let reasoningCursor = 0;
  let bytes: Uint8Array | undefined;
  let incoming: Uint8Array | undefined;
  let incomingLease: ResponseReservation | undefined;
  let source: string;
  let value: unknown;
  let handedOff = false;
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let lastByte = Date.now();
  try {
    scanner = new JsonRetentionScanner('responses', 'response', budget);
    const chunkMetadata = budget.reserve(0);
    leases.push(chunkMetadata);
    while (true) {
      let item = await bounded(reader.read(), Math.min(deadline - Date.now(), IDLE_TIMEOUT_MS - (Date.now() - lastByte)), options.signal);
      incoming = item.done ? undefined : item.value;
      if (incoming) {
        incomingLease = budget.claimBytes(incoming);
        if (incoming.byteLength === 0) { incoming = undefined; incomingLease.release(); incomingLease = undefined; continue; }
        chunkMetadata.resize(chunkMetadata.bytes + 32);
        rawLeases.push(incomingLease);
        incomingLease = undefined;
      }
      if (Date.now() >= deadline || Date.now() - lastByte >= IDLE_TIMEOUT_MS) throw new ResponsesResponseError('Response collection deadline exceeded');
      if (item.done) break;
      if (!incoming) continue;
      lastByte = Date.now();
      scanner.feed(incoming);
      const retention = scanner.snapshot();
      reasoning = retention.reasoningBytes + retention.pendingBytes;
      const adopted = rawLeases.at(-1);
      if (!adopted) throw new ResponsesResponseError('Missing raw response allocation');
      // Classification is complete for these bytes. Normalize inherited shadow
      // credit before restoring the dense-prefix cursor; no allocation or await
      // occurs between this reclassification and the cursor updates below.
      if (adopted.reasoning) adopted.resize(adopted.bytes, 0);
      // Adjust the charged prefix in either direction without rescanning all
      // earlier chunks on each read (including single-byte upstream chunks).
      while (chargedReasoning < reasoning) {
        const raw = rawLeases[reasoningCursor]!;
        const amount = Math.min(raw.bytes - raw.reasoning, reasoning - chargedReasoning);
        raw.resize(raw.bytes, raw.reasoning + amount);
        chargedReasoning += amount;
        if (raw.reasoning === raw.bytes) reasoningCursor++;
      }
      while (chargedReasoning > reasoning) {
        if (reasoningCursor === rawLeases.length || rawLeases[reasoningCursor]!.reasoning === 0) reasoningCursor--;
        const raw = rawLeases[reasoningCursor]!;
        const amount = Math.min(raw.reasoning, chargedReasoning - reasoning);
        raw.resize(raw.bytes, raw.reasoning - amount);
        chargedReasoning -= amount;
      }
      size += incoming.byteLength;
      chunks.push(incoming);
      incoming = undefined;
      item = { done: true, value: undefined };
    }
    const retention = scanner.finish();
    if (!retention.complete || retention.ambiguous) throw new ResponsesResponseError('Invalid Responses JSON');
    reasoning = retention.reasoningBytes;
    scanner = undefined;
    if (chunks.length === 1) bytes = chunks[0]!;
    else {
      const contiguous = budget.reserve(size, reasoning);
      leases.push(contiguous);
      bytes = new Uint8Array(size);
      budget.registerBytes(bytes, contiguous);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      chunks.length = 0;
      for (const lease of rawLeases) lease.release();
      rawLeases = [contiguous];
    }
    chunks.length = 0;
    chunkMetadata.release();
    const decoded = budget.reserve(size * 2, reasoning * 2);
    leases.push(decoded);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const sizing = budget.reserve(2048, 2048);
    leases.push(sizing);
    const parsedSize = parsedBound(source);
    const parsedReasoning = reasoningParsedBound(source);
    sizing.release();
    const parsed = budget.reserve(parsedSize, parsedReasoning);
    leases.push(parsed);
    value = JSON.parse(source);
    source = '';
    decoded.release();
    if (!record(value) || !Array.isArray(value.output)) throw new ResponsesResponseError('Invalid Responses output');
    // callFor performs the real parse, so reserve each argument representation first.
    let executionCount = 0;
    for (const item of value.output) if (execution(item)) {
      executionCount++;
      if (item.type === 'function_call' && typeof item.arguments === 'string') leases.push(budget.reserve(parsedBound(item.arguments)));
    }
    leases.push(budget.reserve(value.output.length * 64 + executionCount * 256));
    const calls = value.output.filter(execution).map(callFor);
    unique(calls);
    const callsByItem = new Map(calls.map(call => [call.raw, call]));
    const seenItemIds = new Set<string>();
    for (const item of value.output) if (record(item) && item.id != null) {
      if (typeof item.id !== 'string' || !item.id || seenItemIds.has(item.id)) throw new ResponsesResponseError('Invalid or duplicate output item identity');
      seenItemIds.add(item.id);
    }
    if (calls.length && value.status !== 'completed' && value.status !== 'incomplete') throw new ResponsesResponseError('Incomplete Responses execution');
    const decisionStarted = Date.now();
    const decisions = await decide(calls, context, options);
    if (Date.now() - decisionStarted >= DECISION_TIMEOUT_MS) throw new ResponsesResponseError('Decision deadline exceeded');
    if (options.signal.aborted) throw new ResponsesResponseError('Response cancelled');
    let number = 0;
    let rewritten = false;
    const ids = new Set(value.output.filter(record).map(item => item.id));
    for (let index = 0; index < value.output.length; index++) {
      const item: unknown = value.output[index];
      if (!execution(item)) continue;
      const call = callsByItem.get(item)!;
      const verdict = decisions.get(call.id)!;
      if (verdict.outcome === 'allow') continue;
      let id: string;
      do { id = `msg_amp_${number++}`; } while (ids.has(id));
      ids.add(id);
      // explanation is capped at 4096 UTF-16 units; include its intermediates,
      // the 256-unit tool name, escaping expansion and replacement structure.
      const replacementLease = budget.reserve(6 * (4096 + 256 + 256) * 3);
      leases.push(replacementLease);
      const replacement = blockedMessage(id, blockedText(call, verdict));
      replacementLease.resize(jsonBytes(replacement) * 2 + 4096);
      value.output[index] = replacement;
      rewritten = true;
    }
    const headers = new Headers(response.headers);
    if (rewritten) {
      bytes = undefined;
      for (const lease of rawLeases) lease.release();
      rawLeases = [];
      const outputSize = jsonBytes(value);
      const outputReasoning = value.output.reduce<number>((sum, item: unknown) => sum + (record(item) && item.type === 'reasoning' ? jsonBytes(item) : 0), 0);
      const serialized = budget.reserve(outputSize * 2, outputReasoning * 2);
      leases.push(serialized);
      source = JSON.stringify(value);
      const encoded = budget.reserve(outputSize, outputReasoning);
      leases.push(encoded);
      bytes = new TextEncoder().encode(source);
      budget.registerBytes(bytes, encoded);
      source = '';
      serialized.release();
      rawLeases = [encoded];
      headers.delete('content-length');
    }
    // Drop semantic references before releasing their ownership. Only the byte
    // allocation crosses the response boundary, without a Response(string) copy.
    value = undefined;
    calls.length = 0;
    callsByItem.clear();
    decisions.clear();
    seenItemIds.clear();
    ids.clear();
    for (const lease of leases) if (!rawLeases.includes(lease)) lease.release();
    let output: Uint8Array | undefined = bytes;
    bytes = undefined;
    let outputLeases = rawLeases;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = output;
        output = undefined;
        if (chunk) controller.enqueue(chunk);
        for (const lease of outputLeases) lease.release();
        outputLeases = [];
        controller.close();
      },
      cancel() {
        output = undefined;
        for (const lease of outputLeases) lease.release();
        outputLeases = [];
      },
    });
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers });
    handedOff = true;
    rawLeases = [];
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    scanner?.finish();
    chunks.length = 0;
    incomingLease?.release();
    for (const lease of rawLeases) lease.release();
    if (!handedOff) for (const lease of leases) lease.release();
  }
}
