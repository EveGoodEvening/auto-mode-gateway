import type { ProtocolAdapter } from '../types.js';
import { extractRequestContext } from '../request-context.js';
import { transformResponsesStream } from './stream.js';
import { transformResponsesNonstream } from './nonstream.js';
import { ResponsesResponseError } from './safety.js';

export const responsesAdapter: ProtocolAdapter = {
  extractRequest(body) { return extractRequestContext('openai-responses', body); },
  async transformResponse(response, context, options) {
    if (!response.body) return response;
    const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (media === 'text/event-stream') {
      const headers = new Headers(response.headers);
      if (options.mode !== 'shadow') headers.delete('content-length');
      return new Response(transformResponsesStream(response.body, context, options), { status: response.status, statusText: response.statusText, headers });
    }
    if (media === 'application/json') return transformResponsesNonstream(response, context, options);
    void response.body.cancel().catch(() => undefined);
    throw new ResponsesResponseError('Unsupported Responses response media type');
  },
};
