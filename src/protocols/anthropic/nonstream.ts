import type { AdapterOptions, RequestContext, ToolCall } from '../types.js';
import { AnthropicResponseError, MAX_RESPONSE_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, approve, bounded, record, toolCall, unique } from './safety.js';

export function extractAnthropicToolCalls(value: unknown): ToolCall[] {
  if (!record(value) || value.type !== 'message') return [];
  if (!Array.isArray(value.content)) return [];
  const calls: ToolCall[] = [];
  for (const block of value.content) {
    if (record(block) && block.type === 'tool_use') calls.push(toolCall(block));
  }
  unique(calls);
  return calls;
}

export async function transformAnthropicNonstream(response: Response, context: RequestContext, options: AdapterOptions): Promise<Response> {
  if (!response.body) return response;
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
    await approve(extractAnthropicToolCalls(value), context, options);
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
