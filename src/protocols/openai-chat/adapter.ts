import type { ProtocolAdapter } from '../types.js';
import { extractRequestContext } from '../request-context.js';
import { transformChatStream } from './stream.js';
import { transformChatNonstream } from './nonstream.js';
import { ChatResponseError } from './safety.js';

export const chatAdapter: ProtocolAdapter = {
  extractRequest(body) { return extractRequestContext('openai-chat', body); },
  async transformResponse(response, context, options) {
    if (!response.body) throw new ChatResponseError('Missing Chat response body');
    const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (media === 'text/event-stream') {
      const headers = new Headers(response.headers);
      if (options.mode !== 'shadow') headers.delete('content-length');
      return new Response(transformChatStream(response.body, context, options), { status: response.status, statusText: response.statusText, headers });
    }
    if (media === 'application/json') return transformChatNonstream(response, context, options);
    void response.body.cancel().catch(() => undefined);
    throw new ChatResponseError('Unsupported Chat response media type');
  },
};
