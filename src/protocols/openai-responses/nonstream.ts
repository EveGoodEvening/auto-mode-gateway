import type { AdapterOptions, RequestContext } from '../types.js';
import { ResponsesResponseError, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, DECISION_TIMEOUT_MS, bounded, blockedText, decide, execution, callFor, unique, record, blockedMessage, jsonBytes, utf8Bytes, shadowStream } from './safety.js';

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
/** Reserve numeric canonicalization expansion before JSON.parse, without copying payload strings. */
export function parsedBound(source: string, start = 0, end = source.length): number {
  let size = utf8Bytes(source, start, end);
  for (let i = start; i < end; i++) {
    if (source[i] === '"') { i = stringEnd(source, i) - 1; continue; }
    if (!'-0123456789'.includes(source[i]!)) continue;
    const start = i;
    while (i + 1 < end && '0123456789.eE+-'.includes(source[i + 1]!)) i++;
    if (i + 1 - start < 32) size += Math.max(0, jsonBytes(Number(source.slice(start, i + 1))) - (i + 1 - start));
  }
  return size;
}
/** Locate a direct JSON property without parsing/copying its payload. Last duplicate wins. */
export function propertySpan(source: string, key: string, start = 0): [number, number] | undefined {
  let cursor = space(source, start);
  if (source[cursor++] !== '{') return undefined;
  cursor = space(source, cursor);
  let found: [number, number] | undefined;
  while (source[cursor] === '"') {
    const end = stringEnd(source, cursor);
    const field: unknown = end - cursor <= 64 ? JSON.parse(source.slice(cursor, end)) : undefined;
    const value = space(source, space(source, end) + 1);
    const stop = valueEnd(source, value);
    if (field === key) found = [value, stop];
    cursor = space(source, stop);
    if (source[cursor] !== ',') break;
    cursor = space(source, cursor + 1);
  }
  return found;
}
/** Direct output reasoning spans reserve raw, decoded and parsed representations. */
export function reasoningBound(source: string, start = 0): number {
  const output = propertySpan(source, 'output', start);
  if (!output || source[output[0]] !== '[') return 0;
  let size = 0;
  let cursor = space(source, output[0] + 1);
  while (cursor < output[1] && source[cursor] !== ']') {
    const stop = valueEnd(source, cursor);
    const type = propertySpan(source, 'type', cursor);
    if (type && type[1] - type[0] <= 64 && JSON.parse(source.slice(type[0], type[1])) === 'reasoning') size += utf8Bytes(source, cursor, stop) * 2 + parsedBound(source, cursor, stop);
    cursor = space(source, stop);
    if (source[cursor] !== ',') break;
    cursor = space(source, cursor + 1);
  }
  return size;
}

export async function transformResponsesNonstream(response: Response, context: RequestContext, options: AdapterOptions): Promise<Response> {
  if (!response.body) return response;
  if (options.mode === 'shadow') {
    return new Response(shadowStream(response.body, async bytes => {
      await transformResponsesNonstream(new Response(bytes, { headers: { 'content-type': 'application/json' } }), context, { ...options, mode: 'enforce' });
    }, options.trackObservation), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let retained = 0;
  const reserve = (amount: number): void => {
    if (retained + amount > MAX_RESPONSE_BYTES) throw new ResponsesResponseError('Response exceeds 8 MiB');
    retained += amount;
  };
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let lastByte = Date.now();
  try {
    while (true) {
      const item = await bounded(reader.read(), Math.min(deadline - Date.now(), IDLE_TIMEOUT_MS - (Date.now() - lastByte)), options.signal);
      if (Date.now() >= deadline || Date.now() - lastByte >= IDLE_TIMEOUT_MS) throw new ResponsesResponseError('Response collection deadline exceeded');
      if (item.done) break;
      if (item.value.byteLength) lastByte = Date.now();
      reserve(item.value.byteLength);
      size += item.value.byteLength;
      chunks.push(item.value);
    }
    reserve(size);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    retained -= size;
    reserve(size);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const reasoning = reasoningBound(source);
    if (reasoning > MAX_REASONING_BYTES) throw new ResponsesResponseError('Reasoning exceeds 4 MiB');
    reserve(parsedBound(source));
    const value: unknown = JSON.parse(source);
    if (!record(value) || !Array.isArray(value.output)) throw new ResponsesResponseError('Invalid Responses output');
    // Parsing each function's encoded arguments creates another retained representation.
    for (const item of value.output) if (execution(item) && item.type === 'function_call' && typeof item.arguments === 'string') reserve(parsedBound(item.arguments));
    const calls = value.output.filter(execution).map(callFor);
    unique(calls);
    const callsByItem = new Map(calls.map(call => [call.raw, call]));
    const seenItemIds = new Set<string>();
    for (const item of value.output) if (record(item) && item.id != null) {
      if (typeof item.id !== 'string' || !item.id || seenItemIds.has(item.id)) throw new ResponsesResponseError('Invalid or duplicate output item identity');
      seenItemIds.add(item.id);
    }
    if (calls.length && value.status !== 'completed' && value.status !== 'incomplete') throw new ResponsesResponseError('Incomplete Responses execution');
    const outputReasoning = value.output.filter((item: unknown) => record(item) && item.type === 'reasoning').reduce<number>((sum, item: unknown) => sum + jsonBytes(item), 0);
    if (reasoning + outputReasoning * 2 > MAX_REASONING_BYTES) throw new ResponsesResponseError('Reasoning exceeds 4 MiB');
    const deliveryReservation = jsonBytes(value) * 2;
    reserve(deliveryReservation);
    const decisionStarted = Date.now();
    const decisions = await decide(calls, context, options);
    if (Date.now() - decisionStarted >= DECISION_TIMEOUT_MS) throw new ResponsesResponseError('Decision deadline exceeded');
    if (options.signal.aborted) throw new ResponsesResponseError('Response cancelled');
    let number = 0;
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
      const replacement = blockedMessage(id, blockedText(call, verdict));
      reserve(jsonBytes(replacement));
      value.output[index] = replacement;
    }
    const rewrittenBytes = jsonBytes(value) * 2;
    if (rewrittenBytes > deliveryReservation) reserve(rewrittenBytes - deliveryReservation);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(value), { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
