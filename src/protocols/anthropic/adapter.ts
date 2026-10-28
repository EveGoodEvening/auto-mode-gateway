import type { ProtocolAdapter, RequestContext } from '../types.js';
import { extractRequestContext } from '../request-context.js';
import { transformAnthropicStream } from './stream.js';
import { transformAnthropicNonstream } from './nonstream.js';
import { AnthropicResponseError } from './safety.js';

export function extractAnthropicRequest(body: Uint8Array): RequestContext | undefined {
  return extractRequestContext('anthropic-messages', body);
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
