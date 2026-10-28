import { quote } from 'shell-quote';

import type { Action, ActionContext } from '../gate/types.js';
import {
  FIND_UNSAFE_ARGUMENTS, GIT_UNSAFE_ARGUMENTS, READONLY_GIT_SUBCOMMANDS,
  READONLY_POSITIONAL_LIMITS, READONLY_PROGRAMS, READONLY_UNSAFE_ARGUMENTS,
} from './constants.js';
import { sensitivePaths } from './sensitive-paths.js';
import { parseShell, shellProgram } from './shell-parse.js';

export interface ReadonlyPolicy {
  readonly_allow_extra?: readonly string[];
  sensitive_paths_extra?: readonly string[];
}

/** Syntax-only strings are useful for classification; Actions additionally require safe path context. */
export function isReadonlyCommand(input: Action | string, policy: ReadonlyPolicy = {}, context: ActionContext = {}): boolean {
  if (typeof input !== 'string') {
    if (input.kind !== 'command' || input.execution_unavailable) return false;
    if (sensitivePaths(input, context, policy.sensitive_paths_extra).review) return false;
  }
  const text = typeof input === 'string' ? input : input.text ?? (input.argv ? quote(input.argv) : '');
  const parsed = parseShell(text);
  if (!parsed.valid || parsed.unsafe) return false;
  return parsed.segments.every(({ argv }) => {
    const [executable = '', ...args] = argv;
    const program = shellProgram(executable);
    // An arbitrary ./git is not the audited system git just because the basename matches.
    if (executable.includes('/') || executable.includes('\\')) return false;
    if (!READONLY_PROGRAMS.includes(program) && !policy.readonly_allow_extra?.includes(program)) return false;
    const forbidden = READONLY_UNSAFE_ARGUMENTS[program] ?? [];
    if (args.some((arg) => {
      const option = arg.split('=', 1)[0]!;
      return forbidden.some((flag) => option === flag
        || (flag.startsWith('-') && !flag.startsWith('--') && arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag.slice(1)))
        || (flag.startsWith('--') && option.length > 2 && flag.startsWith(option)));
    })) return false;
    const positionalLimit = READONLY_POSITIONAL_LIMITS[program];
    if (positionalLimit !== undefined && args.filter((arg) => !arg.startsWith('-')).length > positionalLimit) return false;
    if (program === 'find' && args.some((arg) => FIND_UNSAFE_ARGUMENTS.includes(arg))) return false;
    if (program === 'git') {
      const commandIndex = args[0] === '--no-pager' ? 1 : 0;
      if (!READONLY_GIT_SUBCOMMANDS.includes(args[commandIndex] ?? '')) return false;
      if (args.some((arg) => {
        const option = arg.split('=', 1)[0]!;
        return GIT_UNSAFE_ARGUMENTS.some((flag) => option === flag
          || (flag.startsWith('-') && !flag.startsWith('--') && arg.startsWith(flag))
          || (flag.startsWith('--') && option.length > 2 && flag.startsWith(option)));
      })) return false;
    }
    return true;
  });
}
