import type { Action, ActionContext } from '../gate/types.js';
import { extractLatestUserText } from '../protocols/request-context.js';
import { DEFAULT_POLICY, type EffectivePolicy } from './effective.js';
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
  if (context.request?.lastUserText !== undefined) return context.request.lastUserText;
  if (context.lastUserText !== undefined) return context.lastUserText;
  return extractLatestUserText(context.request?.messages ?? []);
}

/** Pure projection: raw inputs, model prose, results and justifications are excluded. */
export function buildState(action: Action, context: ActionContext, policy: EffectivePolicy = DEFAULT_POLICY): DecisionState {
  const projected: DecisionState['action'] = { tool: action.tool };
  if (action.kind === 'command') {
    projected.command = action.text ?? action.argv?.join(' ') ?? '';
  } else if (action.kind === 'url') {
    projected.url = action.url ?? action.text ?? '';
  }
  if (action.paths.length) projected.path = [...action.paths];
  if (action.kind === 'file_write') {
    const content = action.content_excerpt ?? '';
    projected.content_excerpt = content;
    projected.content_truncated = action.content_truncated || Buffer.byteLength(content, 'utf8') > policy.write_content_max_bytes;
  }
  const workdir = action.workdir ?? context.workdir;
  if (workdir !== undefined) projected.workdir = workdir;
  const environment: DecisionState['environment'] = {
    platform: context.platform ?? 'unknown',
    project_dir: context.project_dir ?? '',
    trusted_directories: [...(context.trusted_directories ?? [])],
  };
  if (context.git_branch !== undefined) environment.git_branch = context.git_branch;
  const state = redact({
    action: projected,
    environment,
    user_request: userText(context),
  }, undefined, policy);
  // Redact before truncation: cutting a credential first could disclose its prefix.
  state.user_request = state.user_request.slice(0, policy.user_request_max_chars);
  if (state.action.content_excerpt !== undefined) {
    const bytes = Buffer.from(state.action.content_excerpt, 'utf8');
    if (bytes.length > policy.write_content_max_bytes) {
      state.action.content_excerpt = new TextDecoder('utf-8', { fatal: false }).decode(
        bytes.subarray(0, policy.write_content_max_bytes), { stream: true },
      );
      state.action.content_truncated = true;
    }
  }
  return state;
}
