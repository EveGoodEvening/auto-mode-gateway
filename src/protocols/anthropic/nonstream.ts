import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { AnthropicResponseError, MAX_RESPONSE_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, decide, blockedText, safeguardResults, shadowStream, bounded, record, toolCall, unique } from './safety.js';

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
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let lastByteAt = Date.now();
  try {
    while (true) {
      const item = await bounded(reader.read(), Math.min(IDLE_TIMEOUT_MS - (Date.now() - lastByteAt), deadline - Date.now()), options.signal);
      if (item.done) break;
      if (item.value.byteLength) lastByteAt = Date.now();
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AnthropicResponseError('Nonstream response exceeds 8 MiB');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AnthropicResponseError('Unparseable nonstream response', 'unparseable'); }
    const calls = extractAnthropicToolCalls(value);
    const callById = new Map(calls.map(call => [call.id, call]));
    const decisions = await decide(calls, context, options);
    let changed = false;
    if (record(value)) {
      if ('safeguard_results' in value) { delete value.safeguard_results; changed = true; }
      if (record(value.delta) && 'safeguard_results' in value.delta) { delete value.delta.safeguard_results; changed = true; }
      if (value.type === 'message' && options.delivery === 'native' && context.safeguards !== undefined) {
        value.safeguard_results = safeguardResults(calls, decisions);
        changed = true;
      } else if (Array.isArray(value.content)) {
        let allowed = 0;
        value.content = value.content.map((block: unknown) => {
          if (!record(block) || block.type !== 'tool_use') return block;
          const verdict = decisions.get(block.id as string)!;
          if (verdict.outcome === 'allow') { allowed += 1; return block; }
          changed = true;
          return { type: 'text', text: blockedText(callById.get(block.id as string)!, verdict) };
        });
        if (calls.length && !allowed) { value.stop_reason = 'end_turn'; changed = true; }
      }
    }
    const headers = new Headers(response.headers);
    if (changed) headers.delete('content-length');
    const output = changed ? new TextEncoder().encode(JSON.stringify(value)) : bytes;
    if (output.byteLength > MAX_RESPONSE_BYTES) throw new AnthropicResponseError('Nonstream response exceeds 8 MiB');
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
