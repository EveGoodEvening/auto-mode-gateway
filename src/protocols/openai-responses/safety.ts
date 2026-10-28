import type { ToolCall } from '../types.js';
export { MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, IDLE_TIMEOUT_MS, COMPLETION_TIMEOUT_MS, DECISION_TIMEOUT_MS, bounded, blockedText, decide, shadowStream, record, unique, encodeEvent } from '../anthropic/safety.js';
import { record, MAX_TOOL_BYTES } from '../anthropic/safety.js';
const EXECUTION_FIELDS = ['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'input', 'action', 'encrypted_function_args'] as const;

export class ResponsesResponseError extends Error {
  readonly blocked = true;
  constructor(message: string) { super(message); this.name = 'ResponsesResponseError'; }
}
export function execution(item: unknown): item is Record<string, unknown> {
  return record(item) && (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call' || (item.type === 'tool_search_call' && item.execution !== 'server'));
}
export function utf8Bytes(value: string, start = 0, end = value.length): number {
  let size = 0;
  for (let i = start; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < end && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
    else size += 3;
  }
  return size;
}
export function jsonBytes(value: unknown): number {
  if (typeof value === 'string') {
    let size = 2;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) size += 2;
      else if (c < 32 || (c >= 0xd800 && c <= 0xdfff && !(c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff))) size += 6;
      else if (c < 128) size++;
      else if (c < 2048) size += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { size += 4; i++; }
      else size += 3;
    }
    return size;
  }
  if (value === null) return 4;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (let index = 0; index < value.length; index++) bytes += jsonBytes(value[index]);
    return bytes;
  }
  let size = 2;
  let count = 0;
  if (record(value)) for (const key in value) if (Object.hasOwn(value, key)) size += (count++ ? 1 : 0) + jsonBytes(key) + 1 + jsonBytes(value[key]);
  return size;
}
export function callFor(item: Record<string, unknown>): ToolCall {
  if (item.type === 'tool_search_call') throw new ResponsesResponseError('Unsupported client tool-search execution');
  const id = item.type === 'local_shell_call' && item.call_id == null ? item.id : item.call_id;
  if (typeof id !== 'string' || !id) throw new ResponsesResponseError('Invalid execution call identity');
  if (item.id != null && (typeof item.id !== 'string' || !item.id)) throw new ResponsesResponseError('Invalid execution item identity');
  if (item.status != null && item.status !== 'completed') throw new ResponsesResponseError('Incomplete execution item');
  if (item.namespace != null && typeof item.namespace !== 'string') throw new ResponsesResponseError('Invalid execution namespace');
  let name: string;
  let input: unknown;
  if (item.type === 'local_shell_call') {
    if (item.status !== 'completed') throw new ResponsesResponseError('Incomplete local shell item');
    name = 'local_shell';
    if (!record(item.action) || item.action.type !== 'exec' || !Array.isArray(item.action.command) || !item.action.command.every(part => typeof part === 'string')) throw new ResponsesResponseError('Invalid local shell action');
    input = { action: item.action };
  } else {
    if (typeof item.name !== 'string' || !item.name) throw new ResponsesResponseError('Invalid execution tool name');
    name = item.name;
    const value = item.type === 'custom_tool_call' ? item.input : item.arguments;
    if (typeof value !== 'string' || utf8Bytes(value) > MAX_TOOL_BYTES) throw new ResponsesResponseError('Invalid execution parameters');
    if (item.type === 'custom_tool_call') input = value;
    else {
      try { input = JSON.parse(value); } catch { throw new ResponsesResponseError('Unparseable execution parameters'); }
    }
  }
  if (item.type !== 'custom_tool_call' && jsonBytes(input) > MAX_TOOL_BYTES) throw new ResponsesResponseError('Execution input exceeds 1 MiB');
  return { id, name, input, raw: item };
}
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!same(a[index], b[index])) return false;
    return true;
  }
  if (!record(a) || !record(b)) return false;
  let before = 0;
  let after = 0;
  for (const key in a) if (Object.hasOwn(a, key)) { before++; if (!Object.hasOwn(b, key) || !same(a[key], b[key])) return false; }
  for (const key in b) if (Object.hasOwn(b, key)) after++;
  return before === after;
}
export function sameExecution(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return EXECUTION_FIELDS.every(key => {
    let before = a[key];
    let after = b[key];
    if (key === 'namespace') {
      if (before == null || before === '' || before === 'functions') before = 'functions';
      if (after == null || after === '' || after === 'functions') after = 'functions';
    } else if (key === 'id' || key === 'call_id' || key === 'encrypted_function_args') {
      before ??= undefined;
      after ??= undefined;
    }
    return same(before, after);
  });
}
export function blockedMessage(id: string, text: string): Record<string, unknown> {
  return { type: 'message', id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
}
