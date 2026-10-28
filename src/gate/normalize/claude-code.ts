import type { ToolCall } from '../../protocols/types.js';
import type { Action, ActionContext } from '../types.js';
import { base, command, fileWrite, inputObject, normalizePath, paths, string } from './shared.js';
import { normalizeWorkBuddy } from './workbuddy.js';

export function normalizeClaudeCode(call: ToolCall, context: ActionContext): Action {
  const action = base(call, context);
  const input = inputObject(call);
  switch (call.name) {
    case 'Bash': return command(action, input.command);
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return fileWrite(action, input, context);
    case 'WebFetch': case 'WebSearch': {
      action.kind = 'url';
      const value = string(input.url) ?? string(input.query);
      if (value !== undefined && value.trim()) action.url = value;
      else action.execution_unavailable = true;
      return action;
    }
    case 'Read': case 'Glob': case 'Grep': case 'LS': {
      action.recognized_exemption = call.name.toLowerCase() as 'read' | 'glob' | 'grep' | 'ls';
      action.paths = paths(input, context);
      if (call.name === 'Glob' && typeof input.pattern === 'string') action.paths.push(normalizePath(input.pattern, context));
      if (call.name === 'Grep' && typeof input.glob === 'string') action.paths.push(normalizePath(input.glob, context));
      return action;
    }
    case 'TodoWrite': action.recognized_exemption = 'todo'; return action;
    case 'Task': action.recognized_exemption = 'task'; return action;
    default:
      if (call.name.startsWith('mcp__')) { action.kind = 'mcp'; action.paths = paths(input, context); return action; }
      return normalizeWorkBuddy(call, context);
  }
}
