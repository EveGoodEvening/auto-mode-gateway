import type { ProtocolAdapter, RequestContext } from '../types.js';
import { extractRequestContext } from '../request-context.js';
import { transformAnthropicStream } from './stream.js';
import { transformAnthropicNonstream } from './nonstream.js';
import { AnthropicResponseError } from './safety.js';
export { createClaudeDeliveryState } from './delivery.js';

/** Keep extracted source context unchanged even when upstream fields are stripped. */
export function prepareAnthropicRequest(body: Uint8Array<ArrayBuffer>, headers: Headers, context: RequestContext,
  upstream: { forward_safeguards: boolean; strip_beta?: boolean }, mode: 'enforce' | 'shadow'):
  { body: Uint8Array<ArrayBuffer>; headers: Headers } {
  if (mode === 'shadow') return { body, headers };
  const preparedHeaders = new Headers(headers);
  if (upstream.strip_beta !== false) {
    const values = preparedHeaders.get('anthropic-beta')?.split(',').map(value => value.trim()).filter(value => value && value !== 'dangerous-tool-use-2026-09-03');
    if (values?.length) preparedHeaders.set('anthropic-beta', values.join(','));
    else preparedHeaders.delete('anthropic-beta');
  }
  if (context.safeguards === undefined || upstream.forward_safeguards) return { body, headers: preparedHeaders };
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as Record<string, unknown>;
  delete value.safeguards;
  const prepared = new TextEncoder().encode(JSON.stringify(value));
  preparedHeaders.delete('content-length');
  return { body: prepared, headers: preparedHeaders };
}

export function extractAnthropicRequest(body: Uint8Array): RequestContext | undefined {
  return extractRequestContext('anthropic-messages', body);
}

/** Anthropic execution delivery is gated independently for each complete tool call. */
export const anthropicAdapter: ProtocolAdapter = {
  extractRequest: extractAnthropicRequest,
  async transformResponse(response, context, options) {
    if (!response.body) return response;
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream') {
      const body = transformAnthropicStream(response.body, context, options);
      const headers = new Headers(response.headers);
      if (options.mode !== 'shadow') headers.delete('content-length');
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    }
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      void response.body.cancel().catch(() => undefined);
      throw new AnthropicResponseError('Unsupported Anthropic response media type');
    }
    return transformAnthropicNonstream(response, context, options);
  },
};
