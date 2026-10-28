import { DEFAULT_POLICY, type EffectivePolicy } from '../../policy/effective.js';
import type { ToolCall } from '../../protocols/types.js';
import type { Action, ActionContext, NormalizationRoute, Protocol } from '../types.js';
import { normalizeClaudeCode } from './claude-code.js';
import { normalizeCodex } from './codex.js';
import { normalizeWorkBuddy } from './workbuddy.js';

export function normalizeToolCall(
  protocol: Protocol,
  call: ToolCall,
  context: ActionContext,
  route?: NormalizationRoute,
  policy: EffectivePolicy = DEFAULT_POLICY,
): Action {
  switch (protocol) {
    case 'anthropic-messages': return normalizeClaudeCode(call, context, policy);
    case 'openai-responses': return normalizeCodex(call, context, policy);
    case 'openai-chat': return normalizeWorkBuddy(call, context, route, policy);
  }
}
