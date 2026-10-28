import type { RequestContext, RequestProtocol } from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stop at the latest user message even when it has no user-authored text. */
export function extractLatestUserText(messages: readonly unknown[], textTypes: readonly string[] = ['text', 'input_text']): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!record(message) || message.role !== 'user'
      || (message.type !== undefined && message.type !== 'message')) continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content.flatMap((block: unknown) => {
      if (!record(block) || typeof block.type !== 'string' || !textTypes.includes(block.type)
        || typeof block.text !== 'string') return [];
      return [block.text];
    }).join('\n');
  }
  return '';
}

/** Pure metadata projection of original request bytes, shared by protocol adapters. */
export function extractRequestContext(protocol: RequestProtocol, body: Uint8Array): RequestContext | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return undefined; }
  if (!record(value)) return undefined;
  const context: RequestContext = { stream: value.stream === true, lastUserText: '' };
  if (typeof value.model === 'string') context.model = value.model;
  if (Array.isArray(value.tools)) context.tools = value.tools;
  if (protocol === 'openai-responses') {
    context.system = value.instructions;
    if (typeof value.input === 'string') context.lastUserText = value.input;
    else if (Array.isArray(value.input)) {
      context.messages = value.input;
      context.lastUserText = extractLatestUserText(value.input, ['input_text']);
    }
  } else {
    if (Array.isArray(value.messages)) {
      context.messages = value.messages;
      context.lastUserText = extractLatestUserText(value.messages, ['text']);
    }
    if (protocol === 'anthropic-messages') {
      context.system = value.system;
      context.safeguards = value.safeguards;
      if (Array.isArray(value.safeguards)) {
        const safeguard = value.safeguards.find((entry: unknown) => record(entry) && entry.type === 'dangerous_tool_use');
        if (record(safeguard)) context.classifier_context = safeguard.classifier_context;
      }
    }
  }
  return context;
}
