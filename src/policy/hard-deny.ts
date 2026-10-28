import { posix } from 'node:path';
import { quote } from 'shell-quote';

import type { Action, ActionContext } from '../gate/types.js';
import {
  DOWNLOAD_PROGRAMS, FILE_WRITE_PROGRAMS, HARD_DENY_COMMANDS, HARD_DENY_PATTERNS, HARD_DENY_TARGET_PATTERNS, INPLACE_WRITE_PROGRAMS, SHELL_INTERPRETERS,
} from './constants.js';
import { parseShell, shellProgram } from './shell-parse.js';

export interface HardDenyPolicy {
  hard_deny_extra?: readonly string[];
}

function normalizedTarget(value: string): string {
  return posix.normalize(value.replaceAll('\\', '/'));
}

function rootOrHome(value: string, context: ActionContext): boolean {
  const target = normalizedTarget(value);
  return HARD_DENY_TARGET_PATTERNS.root.test(target)
    || HARD_DENY_TARGET_PATTERNS.home.test(target)
    || (context.home_dir !== undefined && target === normalizedTarget(context.home_dir));
}

/** A reason means unconditional block, independent of model/provider failure policy. */
export function hardDeny(action: Action, policy: HardDenyPolicy = {}, context: ActionContext = {}): string | undefined {
  if (action.kind === 'file_write' && action.content_truncated) return 'content-truncated';
  if (action.execution_unavailable) return 'execution-unavailable';
  if (action.kind === 'file_write' && action.paths.some((path) => HARD_DENY_TARGET_PATTERNS.authorized_keys.test(normalizedTarget(path)))) {
    return 'authorized-keys-write';
  }
  if (action.kind !== 'command') return undefined;
  const text = action.text ?? (action.argv ? quote(action.argv) : '');
  for (const { id, pattern } of HARD_DENY_PATTERNS) {
    if (new RegExp(pattern.source, pattern.flags).test(text)) return id;
  }
  for (const pattern of policy.hard_deny_extra ?? []) {
    try {
      if (new RegExp(pattern, 'iu').test(text)) return 'configured-hard-deny';
    } catch {
      // Invalid policy cannot silently disable deterministic protection.
      return 'invalid-hard-deny-pattern';
    }
  }
  const pending = [text];
  while (pending.length > 0) {
    const parsed = parseShell(pending.pop()!);
    for (let index = 0; index < parsed.segments.length; index += 1) {
      const segment = parsed.segments[index]!;
      // Prefix wrappers may place the real executable after options and assignments.
      const commandIndex = segment.argv.findIndex((token) => {
        const name = shellProgram(token);
        return HARD_DENY_COMMANDS.includes(name) || FILE_WRITE_PROGRAMS.includes(name) || INPLACE_WRITE_PROGRAMS.includes(name)
          || DOWNLOAD_PROGRAMS.includes(name) || SHELL_INTERPRETERS.includes(name)
          || name === 'mkfs' || name.startsWith('mkfs.');
      });
      const [executable = '', ...args] = segment.argv.slice(Math.max(0, commandIndex));
      const program = shellProgram(executable);
      if (SHELL_INTERPRETERS.includes(program)) {
        const flag = args.findIndex((arg) => /^-[^-]*c/u.test(arg));
        if (flag >= 0 && args[flag + 1]) pending.push(args[flag + 1]!);
      }
      if (program === 'mkfs' || program.startsWith('mkfs.')) return 'filesystem-format';
      if (program === 'dd' && args.some((arg) => arg.startsWith('of=') && HARD_DENY_TARGET_PATTERNS.device.test(normalizedTarget(arg.slice(3))))) {
        return 'device-overwrite';
      }
      if (program === 'rm') {
        const flags = args.filter((arg) => arg.startsWith('-'));
        const recursive = flags.some((arg) => arg === '--recursive' || /^-[^-]*[rR]/u.test(arg));
        const force = flags.some((arg) => arg === '--force' || /^-[^-]*f/u.test(arg));
        if (recursive && force && args.some((arg) => !arg.startsWith('-') && rootOrHome(arg, context))) return 'root-home-delete';
      }
      if (program === 'chmod' && args.some((arg) => arg === '--recursive' || /^-[^-]*R/u.test(arg))
        && args.some((arg) => /^(?:0?777|a\+rwx|ugo\+rwx)$/u.test(arg))
        && args.some((arg) => HARD_DENY_TARGET_PATTERNS.root.test(normalizedTarget(arg)))) return 'root-world-writable';
      if (DOWNLOAD_PROGRAMS.includes(program) && (segment.operator === '|' || segment.operator === '|&')) {
        // Inspect the entire connected pipeline, including intervening decoders/filters.
        for (let next = index + 1; next < parsed.segments.length; next += 1) {
          const target = parsed.segments[next]!;
          if (target.argv.some((token) => SHELL_INTERPRETERS.includes(shellProgram(token)))) return 'download-execution';
          if (target.operator !== '|' && target.operator !== '|&') break;
        }
      }
      const keyTarget = args.some((arg) => HARD_DENY_TARGET_PATTERNS.authorized_keys.test(normalizedTarget(arg)));
      if (keyTarget && (parsed.reasons.includes('redirection') || FILE_WRITE_PROGRAMS.includes(program)
        || (INPLACE_WRITE_PROGRAMS.includes(program) && args.some((arg) => /^-[^-]*i/u.test(arg))))) {
        return 'authorized-keys-write';
      }
    }
  }
  return undefined;
}
