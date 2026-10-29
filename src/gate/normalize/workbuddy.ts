import { DEFAULT_POLICY, type EffectivePolicy } from '../../policy/effective.js';
import type { ToolCall } from '../../protocols/types.js';
import type { Action, ActionContext, NormalizationRoute } from '../types.js';
import { base, command, fileWrite, inputObject, normalizePath, object, pathInput, string } from './shared.js';

const commandKeys = ['command', 'cmd', 'script', 'chars'] as const;
const executionName = /shell|bash|command|terminal|exec|run/i;
const contentReadName = /^(?:read|grep|read[_-]file|file[_-]read)$/i;
const contentReadDescription = /\bread file contents?\b|\bread the contents of a file\b/i;

export function normalizeWorkBuddy(call: ToolCall, context: ActionContext, route?: NormalizationRoute, policy: EffectivePolicy = DEFAULT_POLICY): Action {
  const effective = { ...context };
  if (!effective.project_dir && route?.project_dirs?.length === 1) effective.project_dir = route.project_dirs[0];
  const action = base(call, effective);
  const input = inputObject(call);
  const mapping = route?.tool_map?.[call.name];
  const kind = typeof mapping === 'string' ? mapping : mapping?.kind;
  const arg = typeof mapping === 'object' ? mapping.arg : undefined;
  const selected = arg !== undefined ? input[arg] : undefined;
  const commandKey = commandKeys.find((key) => Object.hasOwn(input, key));
  const pathEvidence = pathInput(input, effective);
  const visiblePaths = pathEvidence.paths;
  action.paths = visiblePaths;
  if (pathEvidence.unavailable) action.execution_unavailable = true;
  const raw = object(call.raw);
  const descriptions = [string(raw.description) ?? ''];
  for (const definition of context.request?.tools ?? []) {
    const tool = object(definition);
    const fn = object(tool.function);
    if (tool.name === call.name || fn.name === call.name) {
      descriptions.push(string(tool.description) ?? string(fn.description) ?? '');
    }
  }
  const executionHint = executionName.test(call.name) || descriptions.some((description) => executionName.test(description));

  // Explicit mappings win over heuristics, but cannot erase visible execution evidence.
  if (kind === 'command') return command(action, arg !== undefined ? selected : (commandKey ? input[commandKey] : undefined));
  if (kind === 'file_write') {
    if (arg !== undefined && typeof selected !== 'string') action.execution_unavailable = true;
    return fileWrite(action, arg !== undefined ? { ...input, content: selected } : input, effective, policy);
  }
  if (kind === 'url') {
    action.kind = 'url';
    const url = arg !== undefined ? string(selected) : string(input.url) ?? string(input.query);
    if (url?.trim()) action.url = url;
    else action.execution_unavailable = true;
    return action;
  }
  if (kind === 'mcp') { action.kind = 'mcp'; action.paths = visiblePaths; return action; }
  if (commandKey !== undefined) return command(action, input[commandKey]);
  if (pathEvidence.present && ['content', 'new_string', 'new_source', 'edits'].some((key) => Object.hasOwn(input, key))) {
    return fileWrite(action, input, effective, policy);
  }
  if (!executionHint && (contentReadName.test(call.name) || descriptions.some((description) => contentReadDescription.test(description)))) {
    action.recognized_exemption = /^grep$/i.test(call.name) ? 'grep' : 'read';
    if (action.recognized_exemption === 'grep' && typeof input.glob === 'string') action.paths.push(normalizePath(input.glob, effective));
    return action;
  }
  // A mapped argument of an 'other' tool is still visible when it is named command/path.
  if (pathEvidence.present) {
    action.kind = 'file_write';
    action.paths = visiblePaths;
    return action;
  }
  // An execution-shaped tool without assessable arguments is not generic other.
  if (executionHint) return command(action, selected);
  return action;
}
