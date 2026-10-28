import type { Action, ActionContext } from '../types.js';
import { content, normalizePath } from './shared.js';

/** Parse only the documented patch envelope; malformed patches are never approvable. */
export function normalizeApplyPatch(action: Action, patch: unknown, context: ActionContext): Action {
  action.kind = 'file_write';
  if (typeof patch !== 'string') { action.execution_unavailable = true; return action; }
  content(action, patch);
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  let malformed = lines[0] !== '*** Begin Patch';
  let ended = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === '*** End Patch') { ended = true; if (lines.slice(index + 1).some((tail) => tail.trim())) malformed = true; break; }
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (match) {
      action.paths.push(normalizePath(match[2]!, context));
      if (match[1] === 'Delete') action.destructive = true;
    } else if (move) action.paths.push(normalizePath(move[1]!, context));
    else if (line.startsWith('*** ') && line !== '*** End of File') malformed = true;
  }
  action.paths = [...new Set(action.paths)];
  if (malformed || !ended || !action.paths.length) action.execution_unavailable = true;
  return action;
}
