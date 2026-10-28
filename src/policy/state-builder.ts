import type { Action, ActionContext } from '../gate/types.js';
import { USER_REQUEST_MAX_CHARS, WRITE_CONTENT_MAX_BYTES } from './constants.js';
import { redact } from './redact.js';

export interface DecisionState {
  action: {
    tool: string;
    command?: string;
    path?: string[];
    content_excerpt?: string;
    content_truncated?: boolean;
    url?: string;
    workdir?: string;
  };
  environment: {
    platform: string;
    project_dir: string;
    trusted_directories: string[];
    git_branch?: string;
  };
  user_request: string;
}

/** Only user-authored text blocks; never stringify mixed content or tool results. */
function userText(context: ActionContext): string {
  // Request adapters own protocol extraction. This neutral field also supports future
  // Responses input_text and Chat content without retaining their entire requests.
  if (context.request?.lastUserText !== undefined) return context.request.lastUserText;
  if (context.lastUserText !== undefined) return context.lastUserText;
  const messages = context.request?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || !('role' in message)
      || message.role !== 'user' || !('content' in message)) continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content.flatMap((block: unknown) => {
      if (!block || typeof block !== 'object' || !('type' in block)
        || (block.type !== 'text' && block.type !== 'input_text')
        || !('text' in block) || typeof block.text !== 'string') return [];
      return [block.text];
    }).join('\n');
  }
  return '';
}

/** Pure projection: raw inputs, model prose, results and justifications are excluded. */
export function buildState(action: Action, context: ActionContext): DecisionState {
  const projected: DecisionState['action'] = { tool: action.tool };
  if (action.kind === 'command') {
    projected.command = action.text ?? action.argv?.join(' ') ?? '';
  } else if (action.kind === 'url') {
    projected.url = action.url ?? action.text ?? '';
  }
  if (action.paths.length) projected.path = [...action.paths];
  if (action.kind === 'file_write') {
    const content = action.content_excerpt ?? '';
    const bytes = Buffer.from(content, 'utf8');
    // Normalization already enforces this bound. Retain it at the export boundary
    // too, so callers cannot accidentally send unseen content as a complete write.
    projected.content_excerpt = bytes.length > WRITE_CONTENT_MAX_BYTES
      ? new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, WRITE_CONTENT_MAX_BYTES), { stream: true })
      : content;
    projected.content_truncated = action.content_truncated || bytes.length > WRITE_CONTENT_MAX_BYTES;
  }
  const workdir = action.workdir ?? context.workdir;
  if (workdir !== undefined) projected.workdir = workdir;
  const environment: DecisionState['environment'] = {
    platform: context.platform ?? 'unknown',
    project_dir: context.project_dir ?? '',
    trusted_directories: [...(context.trusted_directories ?? [])],
  };
  if (context.git_branch !== undefined) environment.git_branch = context.git_branch;
  return redact({
    action: projected,
    environment,
    user_request: redact(userText(context)).slice(0, USER_REQUEST_MAX_CHARS),
  });
}
