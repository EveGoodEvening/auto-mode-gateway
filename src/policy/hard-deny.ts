import { posix } from 'node:path';
import { quote } from 'shell-quote';

import type { Action, ActionContext } from '../gate/types.js';
import { DEFAULT_POLICY, type EffectivePolicy } from './effective.js';
import { parseShell, shellCommand, shellProgram } from './shell-parse.js';

function normalizedTarget(value: string): string {
  return posix.normalize(value.replaceAll('\\', '/'));
}

function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const result = pattern.test(text);
  pattern.lastIndex = 0;
  return result;
}

function rootOrHome(value: string, context: ActionContext, policy: EffectivePolicy): boolean {
  const target = normalizedTarget(value);
  return matches(policy.hard_deny_target_patterns.root, target)
    || matches(policy.hard_deny_target_patterns.home, target)
    || (context.home_dir !== undefined && target === normalizedTarget(context.home_dir));
}

/** A reason means unconditional block, independent of model/provider failure policy. */
export function hardDeny(action: Action, policy: EffectivePolicy = DEFAULT_POLICY, context: ActionContext = {}): string | undefined {
  if (action.kind === 'file_write' && action.content_truncated) return 'content-truncated';
  if (action.execution_unavailable) return 'execution-unavailable';
  if (action.kind === 'file_write' && action.paths.some((path) => matches(policy.hard_deny_target_patterns.authorized_keys, normalizedTarget(path)))) {
    return 'authorized-keys-write';
  }
  if (action.kind !== 'command') return undefined;
  const text = action.text ?? (action.argv ? quote(action.argv) : '');
  for (const { id, pattern } of policy.hard_deny_patterns) {
    if (matches(pattern, text)) return id;
  }
  const pending = [text];
  while (pending.length > 0) {
    const parsed = parseShell(pending.pop()!, policy);
    for (let index = 0; index < parsed.segments.length; index += 1) {
      const segment = parsed.segments[index]!;
      const resolved = shellCommand(segment.argv);
      if (resolved === undefined) return 'unresolved-execution-wrapper';
      const [executable = '', ...args] = resolved;
      const program = shellProgram(executable);
      if (policy.shell_interpreters.includes(program)) {
        const flag = args.findIndex((arg) => /^-[^-]*c/u.test(arg));
        if (flag >= 0 && args[flag + 1]) pending.push(args[flag + 1]!);
      }
      if (policy.hard_deny_commands.includes(program) && (program === 'mkfs' || program.startsWith('mkfs.'))) return 'filesystem-format';
      if (policy.hard_deny_commands.includes(program) && program === 'dd' && args.some((arg) => arg.startsWith('of=') && matches(policy.hard_deny_target_patterns.device, normalizedTarget(arg.slice(3))))) {
        return 'device-overwrite';
      }
      if (policy.hard_deny_commands.includes(program) && program === 'rm') {
        const flags = args.filter((arg) => arg.startsWith('-'));
        const recursive = flags.some((arg) => arg === '--recursive' || /^-[^-]*[rR]/u.test(arg));
        const force = flags.some((arg) => arg === '--force' || /^-[^-]*f/u.test(arg));
        if (recursive && force && args.some((arg) => !arg.startsWith('-') && rootOrHome(arg, context, policy))) return 'root-home-delete';
      }
      if (policy.hard_deny_commands.includes(program) && program === 'chmod' && args.some((arg) => arg === '--recursive' || /^-[^-]*R/u.test(arg))
        && args.some((arg) => /^(?:0?777|a\+rwx|ugo\+rwx)$/u.test(arg))
        && args.some((arg) => matches(policy.hard_deny_target_patterns.root, normalizedTarget(arg)))) return 'root-world-writable';
      if (policy.download_programs.includes(program) && (segment.operator === '|' || segment.operator === '|&')) {
        // Inspect the entire connected pipeline, including intervening decoders/filters.
        for (let next = index + 1; next < parsed.segments.length; next += 1) {
          const target = parsed.segments[next]!;
          const resolvedTarget = shellCommand(target.argv);
          if (resolvedTarget === undefined) return 'unresolved-execution-wrapper';
          if (policy.shell_interpreters.includes(shellProgram(resolvedTarget[0] ?? ''))) return 'download-execution';
          if (target.operator !== '|' && target.operator !== '|&') break;
        }
      }
      const keyTarget = args.some((arg) => matches(policy.hard_deny_target_patterns.authorized_keys, normalizedTarget(arg)));
      if (keyTarget && (parsed.reasons.includes('redirection') || policy.file_write_programs.includes(program)
        || (policy.inplace_write_programs.includes(program) && args.some((arg) => /^-[^-]*i/u.test(arg))))) {
        return 'authorized-keys-write';
      }
    }
  }
  return undefined;
}
