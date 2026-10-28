import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import pino from 'pino';

import type { Config } from '../config/schema.js';
import { authenticate, buildUpstreamHeaders } from './auth.js';
import { errorResponse } from './errors.js';
import { resolveRoute } from './router.js';
import { createStatus } from './status.js';
import { forwardUpstream } from './upstream.js';

class BodyTooLarge extends Error {}

// Consume incrementally with a strict bound, before contacting the upstream.
// This also rejects chunked bodies without trusting Content-Length, and leaves
// opaque/non-JSON bytes untouched. Payload size and its final copy are bounded.
async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await request.body?.cancel().catch(() => {});
    throw new BodyTooLarge();
  }
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Authenticated transparent transport only; no tool-use gate is installed yet. */
export function createApp(config: Config): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const status = createStatus(config);
  const logger = pino({ level: config.log_level }, process.stderr);

  app.onError(() => {
    logger.error('Request transport failed');
    return errorResponse(500, 'api_error', 'Request transport failed');
  });
  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.get('/_amp/status', (context) => status.response(
    context.req.raw.headers,
    context.env?.incoming?.socket.remoteAddress,
  ));
  app.all('*', async (context) => {
    const request = context.req.raw;
    if (!authenticate(request.headers, config.auth)) {
      return errorResponse(401, 'authentication_error', 'Invalid client credentials');
    }
    const url = new URL(request.url);
    const resolved = resolveRoute(config, url.pathname);
    if (!resolved) return errorResponse(404, 'not_found_error', 'No matching upstream route');

    const controller = new AbortController();
    const outgoing = context.env?.outgoing;
    const disconnect = () => {
      if (!outgoing?.writableFinished) controller.abort();
    };
    const finished = () => outgoing?.off('close', disconnect);
    outgoing?.once('close', disconnect);
    outgoing?.once('finish', finished);
    let body: Uint8Array<ArrayBuffer> | undefined;
    try {
      body = await boundedBody(request, config.limits.request_body_bytes);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        return errorResponse(413, 'request_too_large', 'Request body exceeds the configured limit');
      }
      throw error;
    }
    const headers = buildUpstreamHeaders(request.headers, resolved.upstream, config.auth.mode);
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    return forwardUpstream(
      forwarded, resolved.upstream, resolved.pathname + url.search, config,
      {
        signal: controller.signal,
        onError: (httpStatus) => logger.error({ status: httpStatus }, 'Upstream transport failed'),
      },
    );
  });
  return app;
}
