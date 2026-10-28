import type { ProtocolAdapter, RequestContext } from '../types.js';
import { transformAnthropicStream } from './stream.js';
import { transformAnthropicNonstream } from './nonstream.js';
import { AnthropicResponseError, record } from './safety.js';

export function extractAnthropicRequest(body: Uint8Array): RequestContext | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return undefined; }
  if (!record(value)) return undefined;
  const context: RequestContext = {
    stream: value.stream === true,
    system: value.system,
    safeguards: value.safeguards,
  };
  if (typeof value.model === 'string') context.model = value.model;
  if (Array.isArray(value.tools)) context.tools = value.tools;
  if (Array.isArray(value.messages)) {
    context.messages = value.messages;
    for (let index = value.messages.length - 1; index >= 0; index--) {
      const message: unknown = value.messages[index];
      if (!record(message) || message.role !== 'user') continue;
      if (typeof message.content === 'string' && message.content.length) {
        context.lastUserText = message.content;
        break;
      }
      if (Array.isArray(message.content)) {
        const text = message.content.filter((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string')
          .map((block: Record<string, unknown>) => block.text as string).join('\n');
        if (text.length) { context.lastUserText = text; break; }
      }
    }
  }
  if (Array.isArray(value.safeguards)) {
    const safeguard: unknown = value.safeguards.find((entry: unknown) => record(entry) && entry.type === 'dangerous_tool_use');
    if (record(safeguard)) context.classifier_context = safeguard.classifier_context;
  }
  return context;
}

/** C05 deliberately requires its caller to supply the disposable-fixture allow callback. */
export const anthropicAdapter: ProtocolAdapter = {
  extractRequest: extractAnthropicRequest,
  async transformResponse(response, context, options) {
    if (!response.body) return response;
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream') {
      const body = transformAnthropicStream(response.body, context, options);
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body.cancel().catch(() => undefined);
      throw new AnthropicResponseError('Unsupported Anthropic response media type');
    }
    return transformAnthropicNonstream(response, context, options);
  },
};
