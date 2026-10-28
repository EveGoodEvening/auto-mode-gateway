import type { ToolCall } from '../../protocols/types.js';
import type { Action, ActionContext } from '../types.js';
import { normalizeApplyPatch } from './apply-patch.js';
import { base, command, inputObject, normalizePath, object, string } from './shared.js';
import { normalizeWorkBuddy } from './workbuddy.js';

export function normalizeCodex(call: ToolCall, context: ActionContext): Action {
  const action = base(call, context);
  const input = inputObject(call);
  switch (call.name) {
    case 'exec_command': case 'shell': case 'shell_command':
      return command(action, input.cmd ?? input.command);
    case 'local_shell': case 'local_shell_call': {
      const local = object(input.action);
      const result = command(action, local.command);
      const cwd = string(local.working_directory) ?? string(local.cwd);
      if (cwd !== undefined) result.workdir = normalizePath(cwd, context);
      return result;
    }
    case 'write_stdin': {
      // chars without a trusted session-to-command association cannot establish what runs.
      command(action, input.chars);
      action.execution_unavailable = true;
      return action;
    }
    case 'apply_patch': {
      let patch: unknown = input.patch ?? input.input;
      if (patch === undefined && typeof call.input === 'string') patch = call.input;
      return normalizeApplyPatch(action, patch, context);
    }
    default: return normalizeWorkBuddy(call, context);
  }
}
