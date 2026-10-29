import { quote } from 'shell-quote';

import type { Action, ActionContext } from '../gate/types.js';
import { READONLY_PROGRAMS } from './constants.js';
import { DEFAULT_POLICY, type EffectivePolicy } from './effective.js';
import { sensitivePaths } from './sensitive-paths.js';
import { parseShell, shellProgram } from './shell-parse.js';

const GIT_METADATA_FLAGS: Readonly<Record<string, true>> = {
  '--show-prefix': true,
  '--show-toplevel': true,
  '--is-inside-work-tree': true,
  '--is-bare-repository': true,
};

/** Metadata-only classification; Actions additionally require safe lexical path context. */
export function isReadonlyCommand(input: Action | string, policy: EffectivePolicy = DEFAULT_POLICY, context: ActionContext = {}): boolean {
  if (typeof input !== 'string') {
    if (input.kind !== 'command' || input.execution_unavailable) return false;
    if (sensitivePaths(input, context, policy).review) return false;
  }
  const text = typeof input === 'string' ? input : input.text ?? (input.argv ? quote(input.argv) : '');
  const parsed = parseShell(text, policy);
  if (!parsed.valid || parsed.unsafe) return false;
  return parsed.segments.every(({ argv }) => {
    const [executable = '', ...args] = argv;
    const program = shellProgram(executable);
    // An arbitrary ./git is not the audited system git just because the basename matches.
    if (executable.includes('/') || executable.includes('\\')) return false;
    // Effective overrides may narrow the audited metadata subset, never approve content reads.
    if (!READONLY_PROGRAMS.includes(program) || !policy.readonly_programs.includes(program)) return false;
    if ((program === 'du' || program === 'find') && args.some((arg) => {
      const option = arg.split('=', 1)[0]!;
      return (option.length > 2 && '--files0-from'.startsWith(option))
        || (program === 'find' && option.length > 2 && '-files0-from'.startsWith(option));
    })) return false;
    const forbidden = policy.readonly_unsafe_arguments[program] ?? [];
    if (args.some((arg) => {
      const option = arg.split('=', 1)[0]!;
      return forbidden.some((flag) => option === flag
        || (flag.startsWith('-') && !flag.startsWith('--') && arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag.slice(1)))
        || (flag.startsWith('--') && option.length > 2 && flag.startsWith(option)));
    })) return false;
    const positionalLimit = policy.readonly_positional_limits[program];
    if (positionalLimit !== undefined && args.filter((arg) => !arg.startsWith('-')).length > positionalLimit) return false;
    if (program === 'find' && args.some((arg) => policy.find_unsafe_arguments.includes(arg))) return false;
    if (program === 'git') {
      // Only metadata queries with no index, worktree-content or object access
      // have an audited helper-free path. Disabling diff/textconv is insufficient:
      // fsmonitor, filters and lazy object fetching are independent execution paths.
      if (args[0] !== '--no-pager') return false;
      const subcommand = args[1] ?? '';
      if (!policy.readonly_git_subcommands.includes(subcommand)) return false;
      if (subcommand !== 'rev-parse' || args.length < 3) return false;
      if (!args.slice(2).every((arg) => Object.hasOwn(GIT_METADATA_FLAGS, arg))) return false;
      if (args.some((arg) => {
        const option = arg.split('=', 1)[0]!;
        return policy.git_unsafe_arguments.some((flag) => option === flag
          || (flag.startsWith('-') && !flag.startsWith('--') && arg.startsWith(flag))
          || (flag.startsWith('--') && option.length > 2 && flag.startsWith(option)));
      })) return false;
    }
    return true;
  });
}
