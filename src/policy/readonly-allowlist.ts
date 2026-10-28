import { quote } from 'shell-quote';

import type { Action, ActionContext } from '../gate/types.js';
import { DEFAULT_POLICY, type EffectivePolicy } from './effective.js';
import { sensitivePaths } from './sensitive-paths.js';
import { parseShell, shellProgram } from './shell-parse.js';

/** Syntax-only strings are useful for classification; Actions additionally require safe path context. */
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
    if (!policy.readonly_programs.includes(program)) return false;
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
      const noPager = args[0] === '--no-pager';
      const commandIndex = noPager ? 1 : 0;
      const subcommand = args[commandIndex] ?? '';
      if (!policy.readonly_git_subcommands.includes(subcommand)) return false;
      // Pager configuration can launch a process; status does not paginate by default.
      if (subcommand !== 'status' && !noPager) return false;
      if (['diff', 'log', 'show'].includes(subcommand)) {
        const end = args.indexOf('--', commandIndex + 1);
        const options = args.slice(commandIndex + 1, end < 0 ? undefined : end);
        // Repository attributes/config may enable helpers even without an enabling flag.
        if (!options.includes('--no-ext-diff') || !options.includes('--no-textconv')) return false;
      }
      if (subcommand === 'blame') {
        const end = args.indexOf('--', commandIndex + 1);
        if (!args.slice(commandIndex + 1, end < 0 ? undefined : end).includes('--no-textconv')) return false;
      }
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
