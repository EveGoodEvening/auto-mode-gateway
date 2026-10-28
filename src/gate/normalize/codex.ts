import { DEFAULT_POLICY, type EffectivePolicy } from '../../policy/effective.js';
import type { ToolCall } from '../../protocols/types.js';
import type { Action, ActionContext } from '../types.js';
import { normalizeApplyPatch } from './apply-patch.js';
import { base, command, inputObject, normalizePath, object, paths, string } from './shared.js';
import { normalizeWorkBuddy } from './workbuddy.js';

export function normalizeCodex(call: ToolCall, context: ActionContext, policy: EffectivePolicy = DEFAULT_POLICY): Action {
  const action = base(call, context);
  const input = inputObject(call);
  const raw = object(call.raw);
  const opaque = raw.encrypted_function_args;
  if ((raw.type === 'tool_search_call' && raw.execution === 'client')
    || (opaque !== undefined && opaque !== null && (!Array.isArray(opaque) || opaque.length > 0))) {
    action.kind = 'command';
    action.execution_unavailable = true;
    return action;
  }
  if (raw.namespace !== undefined && raw.namespace !== null && raw.namespace !== '' && raw.namespace !== 'functions') {
    action.kind = 'mcp';
    action.execution_unavailable = true;
    return action;
  }
  switch (call.name) {
    case 'exec': case 'wait': case 'request_permissions':
      // Native JS, opaque continuation and permission grants need trusted context.
      action.kind = 'command';
      action.execution_unavailable = true;
      return action;
    case 'exec_command': case 'shell': case 'shell_command': {
      const result = command(action, input.cmd ?? input.command);
      // An alternate shell or remote environment can execute different code than cmd.
      // No trusted executable/environment association is available at this boundary.
      if ((input.shell !== undefined && input.shell !== null) || (input.environment_id !== undefined && input.environment_id !== null)) result.execution_unavailable = true;
      return result;
    }
    case 'local_shell': case 'local_shell_call': {
      const local = object(input.action);
      const result = command(action, local.command);
      const cwd = string(local.working_directory) ?? string(local.cwd);
      if (cwd !== undefined) result.workdir = normalizePath(cwd, context);
      if ((local.env !== undefined && local.env !== null && (typeof local.env !== 'object' || Array.isArray(local.env) || Object.keys(local.env).length > 0))
        || (local.user !== undefined && local.user !== null && local.user !== '')) result.execution_unavailable = true;
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
      return normalizeApplyPatch(action, patch, context, policy);
    }
    default:
      if (call.name.startsWith('mcp__')) { action.kind = 'mcp'; action.paths = paths(input, context); action.execution_unavailable = true; return action; }
      return normalizeWorkBuddy(call, context, undefined, policy);
  }
}
