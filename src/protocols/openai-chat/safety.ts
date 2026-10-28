import type { ToolCall } from '../types.js';
import { record, MAX_TOOL_BYTES } from '../anthropic/safety.js';
import { jsonBytes, utf8Bytes } from '../openai-responses/safety.js';
export { record, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, bounded, blockedText, decide, unique, shadowStream } from '../anthropic/safety.js';
export { jsonBytes, utf8Bytes } from '../openai-responses/safety.js';

export class ChatResponseError extends Error {
  readonly blocked = true;
  constructor(message: string) { super(message); this.name = 'ChatResponseError'; }
}

export function choiceOf(value: unknown, stream: boolean): Record<string, unknown> | undefined {
  if (!record(value) || !Array.isArray(value.choices)) throw new ChatResponseError('Invalid Chat choices');
  if (value.error != null || value.function_call != null || value.tool_calls != null) throw new ChatResponseError('Unsupported Chat execution shape');
  if (stream && value.choices.length === 0) {
    if (!record(value.usage) && value.usage !== null) throw new ChatResponseError('Invalid Chat usage chunk');
    return undefined;
  }
  if (value.choices.length !== 1) throw new ChatResponseError('Unsupported Chat multiple choices');
  const choice: unknown = value.choices[0];
  if (!record(choice) || choice.index !== 0 || choice.function_call != null || choice.tool_calls != null) throw new ChatResponseError('Invalid Chat choice');
  const body = stream ? choice.delta : choice.message;
  if (!record(body) || body.function_call != null || body.audio != null || body.refusal != null && typeof body.refusal !== 'string') throw new ChatResponseError('Unsupported Chat generation');
  if (body.content != null && typeof body.content !== 'string') throw new ChatResponseError('Unsupported Chat content');
  if (body.reasoning_content != null && typeof body.reasoning_content !== 'string') throw new ChatResponseError('Invalid Chat reasoning');
  if (Object.keys(body).some(key => !['role', 'content', 'reasoning_content', 'tool_calls', 'refusal', 'annotations'].includes(key))) throw new ChatResponseError('Unsupported Chat message field');
  if (body.role != null && body.role !== 'assistant') throw new ChatResponseError('Invalid Chat role');
  if (body.tool_calls !== undefined && !Array.isArray(body.tool_calls)) throw new ChatResponseError('Invalid Chat tool calls');
  if (choice.finish_reason != null && !['stop', 'tool_calls', 'length', 'content_filter'].includes(String(choice.finish_reason))) throw new ChatResponseError('Unsupported Chat finish reason');
  return choice;
}

export function callFor(value: unknown): ToolCall {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.type !== 'function' || !record(value.function)) throw new ChatResponseError('Invalid Chat tool identity');
  const fn = value.function;
  if (typeof fn.name !== 'string' || !fn.name || typeof fn.arguments !== 'string' || utf8Bytes(fn.arguments) > MAX_TOOL_BYTES) throw new ChatResponseError('Invalid Chat tool parameters');
  let input: unknown;
  try { input = JSON.parse(fn.arguments); } catch { throw new ChatResponseError('Incomplete Chat tool parameters'); }
  if (!record(input) || jsonBytes(input) > MAX_TOOL_BYTES) throw new ChatResponseError('Invalid Chat tool input');
  if (Object.keys(value).some(key => !['id', 'type', 'function', 'index'].includes(key)) || Object.keys(fn).some(key => !['name', 'arguments'].includes(key))) throw new ChatResponseError('Unsupported Chat tool shape');
  return { id: value.id, name: fn.name, input, raw: value };
}

export function reasoningSize(value: unknown): number {
  if (!record(value)) return 0;
  if (!Array.isArray(value.choices)) return 0;
  let size = 0;
  for (const choice of value.choices) if (record(choice)) {
    const body = record(choice.delta) ? choice.delta : choice.message;
    if (record(body) && typeof body.reasoning_content === 'string') size += jsonBytes(body.reasoning_content);
  }
  return size;
}
