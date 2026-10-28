import { posix } from 'node:path';
import type { Action, ActionContext } from '../gate/types.js';
import { SENSITIVE_PATH_GLOBS } from './constants.js';
import { parseShell } from './shell-parse.js';

export interface SensitivePathResult {
  review: boolean;
  reasons: string[];
  paths: string[];
}

function windows(context: ActionContext, path: string): boolean {
  return context.platform === 'win32' || context.platform === 'windows'
    || [path, context.project_dir, context.workdir, context.userprofile].some((value) => value !== undefined && (/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')));
}

/** Lexical only: never consults the server filesystem or expands its environment.
 * A contained spelling is not proof against symlink/junction traversal on the client.
 */
export function normalizePolicyPath(path: string, context: ActionContext, workdir?: string): string | undefined {
  if (!path || path.includes('\0')) return undefined;
  const win = windows(context, path);
  let value = win ? path.replaceAll('\\', '/') : path;
  const home = win ? context.userprofile ?? context.home_dir : context.home_dir;
  if (/^~(?:\/|$)/.test(value)) {
    if (!home) return undefined;
    value = home.replaceAll('\\', '/') + value.slice(1);
  }
  if (/%USERPROFILE%/i.test(value)) {
    if (!home) return undefined;
    value = value.replace(/%USERPROFILE%/gi, () => home.replaceAll('\\', '/'));
  }
  // Unknown substitutions, drive-relative paths and named-user tildes are not resolvable.
  if (/[$%`]/.test(value) || value.startsWith('~') || /^[a-z]:(?!\/)/i.test(value)) return undefined;
  if (win && value.startsWith('/') && !value.startsWith('//')) return undefined;
  const absolute = value.startsWith('/') || /^[a-z]:\//i.test(value);
  if (!absolute) {
    const base = workdir ?? context.workdir ?? context.project_dir;
    if (!base) return undefined;
    const normalizedBase = normalizePolicyPath(base, { ...context, workdir: undefined, project_dir: undefined });
    if (!normalizedBase) return undefined;
    value = `${normalizedBase}/${value}`;
  }
  // Preserve the UNC share root; node:path.posix would collapse its double slash.
  const unc = value.startsWith('//');
  value = posix.normalize(value);
  if (value.length > 1 && !/^[a-z]:\/$/i.test(value)) value = value.replace(/\/$/, '');
  if (unc) value = `/${value}`;
  return win ? value.toLowerCase() : value;
}

function globPattern(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') {
        index++;
        pattern += '(?:.*/)?';
      } else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return new RegExp(`(?:^|/)${pattern}(?:/|$)`);
}

function matchesSensitive(path: string, globs: readonly string[], win: boolean): boolean {
  return globs.some((glob) => globPattern((win ? glob.toLowerCase() : glob).replaceAll('\\', '/').replace(/^\//, '')).test(path));
}

/** Run before native/shell readonly exemptions. `review:false` is only a lexical
 * non-match, never an authorization or a claim that symlinks were resolved.
 */
export function sensitivePaths(action: Action, context: ActionContext, extra: readonly string[] = []): SensitivePathResult {
  const reasons = new Set<string>();
  const candidates = new Set(action.paths);
  if (action.kind === 'command') {
    const parsed = !action.argv && action.text ? parseShell(action.text) : undefined;
    const segments = action.argv ? [{ argv: action.argv }] : parsed?.segments ?? [];
    if (!action.argv && (!parsed?.valid || parsed.unsafe)) reasons.add('unresolved_shell_paths');
    for (const { argv } of segments) {
      for (const arg of argv.slice(1)) {
        if (arg && !arg.startsWith('-')) candidates.add(arg);
        else if (arg.includes('=')) candidates.add(arg.slice(arg.indexOf('=') + 1));
        else if (/^-[fI]/.test(arg) && arg.length > 2) candidates.add(arg.slice(2));
      }
    }
  }
  if (candidates.size === 0 && (action.kind === 'file_write' || ['read', 'glob', 'grep', 'ls'].includes(action.recognized_exemption ?? ''))) {
    reasons.add('missing_path_context');
  }
  const project = context.project_dir ? normalizePolicyPath(context.project_dir, context) : undefined;
  const paths: string[] = [];
  for (const candidate of candidates) {
    const path = normalizePolicyPath(candidate, context, action.workdir);
    if (!path) {
      reasons.add('unresolved_path');
      continue;
    }
    paths.push(path);
    if (/[*?[\]{}]/.test(path)) reasons.add('unresolved_path_pattern');
    if (matchesSensitive(path, [...SENSITIVE_PATH_GLOBS, ...extra], windows(context, candidate))) reasons.add('sensitive_path');
    if (action.kind === 'file_write' && (!project || (path !== project && !path.startsWith(project.endsWith('/') ? project : `${project}/`)))) {
      reasons.add(project ? 'outside_project_write' : 'missing_project_context');
    }
  }
  return { review: reasons.size > 0, reasons: [...reasons], paths };
}
