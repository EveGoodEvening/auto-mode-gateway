import { DEFAULT_POLICY, type EffectivePolicy } from '../../policy/effective.js';
import type { Action, ActionContext } from '../types.js';
import { content, normalizePath } from './shared.js';

/** Validate the supported patch syntax, without executing or resolving any patch hunks. */
export function normalizeApplyPatch(action: Action, patch: unknown, context: ActionContext, policy: EffectivePolicy = DEFAULT_POLICY): Action {
  action.kind = 'file_write';
  if (typeof patch !== 'string') { action.execution_unavailable = true; return action; }
  content(action, patch, policy);
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  let malformed = lines[0] !== '*** Begin Patch';
  let ended = false;
  let operation: 'Add' | 'Update' | 'Delete' | undefined;
  let moved = false;
  let hunk = false;
  let hunkLines = 0;
  let endOfFile = false;
  const finishOperation = () => {
    if (operation === 'Update' && (!hunk || hunkLines === 0)) malformed = true;
  };
  const addPath = (value: string) => {
    const path = normalizePath(value, context);
    if (!value.trim() || path === '.') malformed = true;
    action.paths.push(path);
  };
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === '*** End Patch') {
      finishOperation();
      ended = true;
      if (lines.slice(index + 1).some((tail) => tail.trim())) malformed = true;
      break;
    }
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      finishOperation();
      operation = header[1] as 'Add' | 'Update' | 'Delete';
      moved = false;
      hunk = false;
      hunkLines = 0;
      endOfFile = false;
      addPath(header[2]!);
      if (operation === 'Delete') action.destructive = true;
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      if (operation !== 'Update' || moved || hunk) malformed = true;
      moved = true;
      addPath(move[1]!);
      continue;
    }
    if (operation === 'Add') {
      if (!line.startsWith('+')) malformed = true;
    } else if (operation === 'Update') {
      const updateLine = line.trimEnd();
      if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
        if (hunk && hunkLines === 0) malformed = true;
        hunk = true;
        hunkLines = 0;
        endOfFile = false;
      } else if (endOfFile && updateLine === '') {
        continue;
      } else if (updateLine === '*** End of File') {
        if (!hunk || hunkLines === 0 || endOfFile) malformed = true;
        endOfFile = true;
      } else if (!endOfFile && (line === '' || /^[ +-]/.test(line))) {
        hunk = true;
        hunkLines++;
      } else malformed = true;
    } else malformed = true;
  }
  action.paths = [...new Set(action.paths)];
  if (malformed || !ended || !action.paths.length) action.execution_unavailable = true;
  return action;
}
