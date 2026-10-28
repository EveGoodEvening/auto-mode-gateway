import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { WRITE_CONTENT_MAX_BYTES } from '../../policy/constants.js';
import type { ToolCall } from '../../protocols/types.js';
import type { Action, ActionContext } from '../types.js';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function inputObject(call: ToolCall): Record<string, unknown> {
  if (typeof call.input !== 'string') return object(call.input);
  try { return object(JSON.parse(call.input)); } catch { return {}; }
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function normalizePath(value: string, context: ActionContext): string {
  const home = context.userprofile ?? context.home_dir;
  let path = value;
  if (home) {
    path = path.replace(/^%USERPROFILE%(?=[\\/]|$)/i, () => home);
    path = path.replace(/^~(?=[\\/]|$)/, () => home);
  }
  const windows = context.platform === 'win32' || /^[a-z]:[\\/]/i.test(path) || path.includes('\\');
  if (windows) {
    path = win32.normalize(path).replaceAll('\\', '/');
    return path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
  }
  return posix.normalize(path);
}

export function base(call: ToolCall, context: ActionContext): Action {
  const input = inputObject(call);
  const cwd = string(input.workdir) ?? string(input.cwd) ?? context.workdir ?? context.project_dir;
  return { kind: 'other', tool: call.name, paths: [], content_truncated: false,
    ...(cwd !== undefined ? { workdir: normalizePath(cwd, context) } : {}), raw: call.raw };
}

export function paths(input: Record<string, unknown>, context: ActionContext): string[] {
  const result: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path', 'file', 'filename', 'directory', 'target_path']) {
    const value = string(input[key]);
    if (value !== undefined) result.push(normalizePath(value, context));
  }
  if (Array.isArray(input.paths)) {
    for (const value of input.paths) if (typeof value === 'string') result.push(normalizePath(value, context));
  }
  return [...new Set(result)];
}

export function command(action: Action, value: unknown): Action {
  action.kind = 'command';
  if (typeof value === 'string' && value.trim()) action.text = value;
  else if (Array.isArray(value) && value.length > 0 && value.every((arg) => typeof arg === 'string')) {
    action.argv = value as string[];
    // Preserve argument boundaries; readonly classification may be conservative.
    action.text = action.argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
  } else action.execution_unavailable = true;
  return action;
}

export function content(action: Action, value: string): Action {
  const bytes = Buffer.from(value, 'utf8');
  action.content_digest = createHash('sha256').update(bytes).digest('hex');
  action.content_truncated = bytes.length > WRITE_CONTENT_MAX_BYTES;
  let end = Math.min(bytes.length, WRITE_CONTENT_MAX_BYTES);
  // Never expose an incomplete UTF-8 code point at the excerpt boundary.
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  action.content_excerpt = bytes.subarray(0, end).toString('utf8');
  return action;
}

export function fileWrite(action: Action, input: Record<string, unknown>, context: ActionContext): Action {
  action.kind = 'file_write';
  action.paths = paths(input, context);
  const values: string[] = [];
  for (const key of ['content', 'new_string', 'old_string', 'new_source', 'source']) {
    const value = string(input[key]);
    if (value !== undefined) values.push(value);
  }
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const entry = object(edit);
      for (const key of ['old_string', 'new_string']) {
        const value = string(entry[key]);
        if (value !== undefined) values.push(value);
      }
    }
  }
  if (values.length) content(action, values.length === 1 ? values[0]! : JSON.stringify(values));
  else action.execution_unavailable = true;
  if (!action.paths.length || action.paths.some((path) => !path.trim() || path === '.')) action.execution_unavailable = true;
  return action;
}
