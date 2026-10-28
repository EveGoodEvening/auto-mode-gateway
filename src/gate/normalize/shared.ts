import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { DEFAULT_POLICY, type EffectivePolicy } from '../../policy/effective.js';
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

/** Recognizable path presence remains execution evidence even when its value is unusable. */
export function pathInput(input: Record<string, unknown>, context: ActionContext): { paths: string[]; present: boolean; unavailable: boolean } {
  const result: string[] = [];
  let present = false;
  let unavailable = false;
  const append = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) { unavailable = true; return; }
    const path = normalizePath(value, context);
    if (path === '.') unavailable = true;
    result.push(path);
  };
  for (const key of ['file_path', 'notebook_path', 'path', 'file', 'filename', 'directory', 'target_path']) {
    if (!Object.hasOwn(input, key)) continue;
    present = true;
    append(input[key]);
  }
  if (Object.hasOwn(input, 'paths')) {
    present = true;
    if (!Array.isArray(input.paths) || !input.paths.length) unavailable = true;
    else for (const value of input.paths) append(value);
  }
  return { paths: [...new Set(result)], present, unavailable };
}

export function paths(input: Record<string, unknown>, context: ActionContext): string[] {
  return pathInput(input, context).paths;
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

export function content(action: Action, value: string, policy: EffectivePolicy = DEFAULT_POLICY): Action {
  const bytes = Buffer.from(value, 'utf8');
  action.content_digest = createHash('sha256').update(bytes).digest('hex');
  action.content_truncated = bytes.length > policy.write_content_max_bytes;
  let end = Math.min(bytes.length, policy.write_content_max_bytes);
  // Never expose an incomplete UTF-8 code point at the excerpt boundary.
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  action.content_excerpt = bytes.subarray(0, end).toString('utf8');
  return action;
}

export function fileWrite(action: Action, input: Record<string, unknown>, context: ActionContext, policy: EffectivePolicy = DEFAULT_POLICY): Action {
  action.kind = 'file_write';
  const evidence = pathInput(input, context);
  action.paths = evidence.paths;
  if (evidence.unavailable) action.execution_unavailable = true;
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
  if (values.length) content(action, values.length === 1 ? values[0]! : JSON.stringify(values), policy);
  else action.execution_unavailable = true;
  if (!action.paths.length || action.paths.some((path) => !path.trim() || path === '.')) action.execution_unavailable = true;
  return action;
}
