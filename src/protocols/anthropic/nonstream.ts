import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { AnthropicResponseError, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, decide, blockedText, safeguardResults, shadowStream, bounded, record, toolCall, unique } from './safety.js';

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

/** UTF-8 JSON sizes without allocating another complete serialized response. */
function stringBytes(value: string, quoted = true, start = 0, end = value.length): number {
  let bytes = quoted ? 2 : 0;
  for (let index = start; index < end; index++) {
    const code = value.charCodeAt(index);
    if (quoted && (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)) bytes += 2;
    else if (quoted && code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else if (quoted && code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return stringBytes(value);
  if (value === null) return 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const item of value) bytes += jsonBytes(item);
    return bytes;
  }
  let bytes = 2;
  let count = 0;
  if (record(value)) for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    bytes += (count++ ? 1 : 0) + stringBytes(key) + 1 + jsonBytes(value[key]);
  }
  return bytes;
}

function stringEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index++;
    else if (source[index] === '"') return index + 1;
  }
  return source.length;
}

function whitespace(source: string, start: number): number {
  while (source[start] === ' ' || source[start] === '\n' || source[start] === '\r' || source[start] === '\t') start++;
  return start;
}

function valueEnd(source: string, start: number): number {
  if (source[start] === '"') return stringEnd(source, start);
  if (source[start] === '{' || source[start] === '[') {
    let depth = 0;
    for (let index = start; index < source.length; index++) {
      if (source[index] === '"') index = stringEnd(source, index) - 1;
      else if (source[index] === '{' || source[index] === '[') depth++;
      else if ((source[index] === '}' || source[index] === ']') && --depth === 0) return index + 1;
    }
    return source.length;
  }
  let end = start;
  while (end < source.length && source[end] !== ',' && source[end] !== '}' && source[end] !== ']' && whitespace(source, end) === end) end++;
  return end;
}

function reasoning(block: unknown): boolean {
  return record(block) && (block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'signature' || 'signature' in block);
}

/** Classify only direct block fields; large payload strings are scanned, never parsed/copied here. */
function reasoningSpan(source: string, start: number, stop: number): boolean {
  if (source[start] !== '{') return false;
  let cursor = whitespace(source, start + 1);
  let type: unknown;
  while (cursor < stop && source[cursor] === '"') {
    const end = stringEnd(source, cursor);
    const key: unknown = end - cursor <= 56 ? JSON.parse(source.slice(cursor, end)) : undefined;
    const valueStart = whitespace(source, whitespace(source, end) + 1);
    const valueStop = valueEnd(source, valueStart);
    if (key === 'signature') return true;
    if (key === 'type') type = source[valueStart] === '"' && valueStop - valueStart <= 104 ? JSON.parse(source.slice(valueStart, valueStop)) : undefined;
    cursor = whitespace(source, valueStop);
    if (source[cursor] !== ',') break;
    cursor = whitespace(source, cursor + 1);
  }
  return type === 'thinking' || type === 'redacted_thinking' || type === 'signature';
}

/** The final root content property wins, including escaped keys and duplicate JSON keys. */
function rawReasoningBytes(source: string): { raw: number; parsed: number } {
  let cursor = whitespace(source, 0);
  let raw = 0;
  let parsed = 0;
  if (source[cursor++] !== '{') return { raw, parsed };
  cursor = whitespace(source, cursor);
  while (cursor < source.length && source[cursor] === '"') {
    const end = stringEnd(source, cursor);
    const isContent = end - cursor <= 44 && JSON.parse(source.slice(cursor, end)) === 'content';
    const start = whitespace(source, whitespace(source, end) + 1);
    const stop = valueEnd(source, start);
    if (isContent) {
      raw = 0;
      parsed = 0;
      if (source[start] === '[') {
        let item = whitespace(source, start + 1);
        // Each span's bound includes numeric expansion but does not allocate its parsed value.
        while (item < stop && source[item] !== ']') {
          const itemEnd = valueEnd(source, item);
          if (reasoningSpan(source, item, itemEnd)) {
            raw += stringBytes(source, false, item, itemEnd);
            parsed += parsedBound(source, item, itemEnd);
          }
          item = whitespace(source, itemEnd);
          if (source[item] !== ',') break;
          item = whitespace(source, item + 1);
        }
      }
    }
    cursor = whitespace(source, stop);
    if (source[cursor] !== ',') break;
    cursor = whitespace(source, cursor + 1);
  }
  return { raw, parsed };
}

/** Canonical strings cannot grow; short numeric spellings can expand during JSON.parse. */
function parsedBound(source: string, start = 0, end = source.length): number {
  let bytes = stringBytes(source, false, start, end);
  for (let index = start; index < end; index++) {
    if (source[index] === '"') { index = stringEnd(source, index) - 1; continue; }
    const code = source.charCodeAt(index);
    if (code !== 45 && (code < 48 || code > 57)) continue;
    const tokenStart = index;
    while (index + 1 < end && '0123456789.eE+-'.includes(source[index + 1]!)) index++;
    const length = index + 1 - tokenStart;
    if (length < 32) bytes += Math.max(0, jsonBytes(Number(source.slice(tokenStart, index + 1))) - length);
  }
  return bytes;
}

export async function transformAnthropicNonstream(response: Response, context: RequestContext, options: AdapterOptions): Promise<Response> {
  if (!response.body) return response;
  if (options.mode === 'shadow') {
    const body = shadowStream(response.body, async bytes => {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return; }
      await decide(extractAnthropicToolCalls(value), context, options);
    }, options.trackObservation);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let retainedBytes = 0;
  function reserve(bytes: number): void {
    if (retainedBytes + bytes > MAX_RESPONSE_BYTES) throw new AnthropicResponseError('Nonstream response exceeds 8 MiB');
    retainedBytes += bytes;
  }
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let lastByteAt = Date.now();
  try {
    while (true) {
      const item = await bounded(reader.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByteAt), deadline - Date.now()), options.signal);
      if (item.done) break;
      if (item.value.byteLength) lastByteAt = Date.now();
      size += item.value.byteLength;
      reserve(item.value.byteLength);
      chunks.push(item.value);
    }
    reserve(size); // Consolidation temporarily retains both the incoming chunks and the output buffer.
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    retainedBytes -= size;
    reserve(size); // Decoded source is temporary but still shares the aggregate ceiling.
    let json: string;
    try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new AnthropicResponseError('Unparseable nonstream response', 'unparseable'); }
    let reasoningReservation: { raw: number; parsed: number };
    try { reasoningReservation = rawReasoningBytes(json); }
    catch { throw new AnthropicResponseError('Unparseable nonstream response', 'unparseable'); }
    // Raw bytes, the decoded source and the soon-to-be parsed blocks coexist at this peak.
    let reasoningBytes = reasoningReservation.raw * 2 + reasoningReservation.parsed;
    if (reasoningBytes > MAX_REASONING_BYTES) throw new AnthropicResponseError('Nonstream reasoning exceeds 4 MiB');
    const parsedReservation = parsedBound(json);
    reserve(parsedReservation); // Reserve before JSON.parse allocates the retained representation.
    let value: unknown;
    try { value = JSON.parse(json); }
    catch { throw new AnthropicResponseError('Unparseable nonstream response', 'unparseable'); }
    const parsedBytes = jsonBytes(value);
    retainedBytes -= parsedReservation - parsedBytes;
    let validationBytes = 0;
    reasoningBytes = reasoningReservation.raw * 2;
    if (record(value) && Array.isArray(value.content)) {
      // Keep the decoded reasoning reservation until the complete source is discarded below.
      for (const block of value.content) {
        if (reasoning(block)) reasoningBytes += jsonBytes(block);
        if (record(block) && block.type === 'tool_use') {
          const inputBytes = jsonBytes(block.input);
          if (inputBytes > MAX_TOOL_BYTES) throw new AnthropicResponseError('Tool input exceeds 1 MiB');
          validationBytes = Math.max(validationBytes, inputBytes * 2);
        }
      }
      if (reasoningBytes > MAX_REASONING_BYTES) throw new AnthropicResponseError('Nonstream reasoning exceeds 4 MiB');
    }
    json = ''; // No complete decoded source remains retained during approval or output encoding.
    retainedBytes -= size;
    reasoningBytes -= reasoningReservation.raw;
    // Existing tool validation serializes one shared parsed input at a time; it does not copy that input.
    reserve(validationBytes);
    const calls = extractAnthropicToolCalls(value);
    retainedBytes -= validationBytes;
    const callById = new Map(calls.map(call => [call.id, call]));
    const decisions = await decide(calls, context, options);
    let changed = false;
    if (record(value)) {
      if ('safeguard_results' in value) { delete value.safeguard_results; changed = true; }
      if (record(value.delta) && 'safeguard_results' in value.delta) { delete value.delta.safeguard_results; changed = true; }
      if (value.type === 'message' && options.delivery === 'native' && context.safeguards !== undefined) {
        let resultReservation = 256;
        for (const call of calls) resultReservation += stringBytes(call.id) + 128 + (decisions.get(call.id)?.outcome === 'allow' ? 0 : 32 * 1024);
        reserve(resultReservation);
        const results = safeguardResults(calls, decisions);
        retainedBytes -= resultReservation - jsonBytes(results) - 32;
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
          retainedBytes -= replacementReservation - jsonBytes(replacement);
          return replacement;
        });
        if (calls.length && !allowed) { value.stop_reason = 'end_turn'; changed = true; }
      }
    }
    const headers = new Headers(response.headers);
    if (changed) headers.delete('content-length');
    let output = bytes;
    if (changed) {
      let outputReasoningBytes = 0;
      if (record(value) && Array.isArray(value.content)) {
        for (const block of value.content) if (reasoning(block)) outputReasoningBytes += jsonBytes(block);
      }
      if (reasoningBytes + outputReasoningBytes * 2 > MAX_REASONING_BYTES) throw new AnthropicResponseError('Nonstream reasoning exceeds 4 MiB');
      const outputBytes = jsonBytes(value);
      // The original raw response and parsed/tool representations are still retained here.
      // Reserve BOTH serialized JSON and its encoded replacement before allocating either.
      reserve(outputBytes * 2);
      output = new TextEncoder().encode(JSON.stringify(value));
      retainedBytes -= outputBytes;
    }
    const native = record(value) && value.type === 'message' && options.delivery === 'native' && context.safeguards !== undefined;
    if (native && options.onNativeDelivered) {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(output); }
          else { if (!options.signal.aborted) options.onNativeDelivered?.(); controller.close(); }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    }
    return new Response(output, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
