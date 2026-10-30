import { createHmac, randomBytes } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';

import type { Config } from '../config/schema.js';
import { createAuditLogger } from '../audit/logger.js';
import { createGate } from '../gate/decide.js';
import { normalizeToolCall } from '../gate/normalize/index.js';
import type { GateContext } from '../gate/types.js';
import { resolvePolicy } from '../policy/effective.js';
import { anthropicAdapter, createClaudeDeliveryState, prepareAnthropicRequest } from '../protocols/anthropic/adapter.js';
import { isClassifierRequest, isSuspectedClassifierRequest, prepareClassifierTarget } from '../protocols/anthropic/classifier-fingerprint.js';
import { responsesAdapter } from '../protocols/openai-responses/adapter.js';
import { chatAdapter } from '../protocols/openai-chat/adapter.js';
import type { RequestContext } from '../protocols/types.js';
import { createLogger, clientAddressForLog } from '../util/log.js';
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

/** Authenticated transport with protocol-specific gates on implemented generation endpoints. */
export function createApp(config: Config) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const policy = resolvePolicy(config.policy);
  const audit = createAuditLogger(config, { policy });
  const gate = createGate(config, { policy, audit: audit.append });
  const observations = new Set<Promise<void>>();
  const status = createStatus(config, gate.stats);
  const deliveryState = createClaudeDeliveryState();
  // Process-local HMAC prevents stored correlation keys from exposing credentials.
  const identityKey = randomBytes(32);
  const logger = createLogger(config);

  app.onError(() => {
    logger.error('Request transport failed');
    return errorResponse(500, 'api_error', 'Request transport failed');
  });
  app.use('*', async (context, next) => {
    await next();
    logger.info({
      method: context.req.method,
      status: context.res.status,
      client_address: clientAddressForLog(context.req.raw.headers, context.env?.incoming?.socket.remoteAddress, config.trust_proxy),
    }, 'Request completed');
    const response = context.res;
    if (!response.body) return;
    const reader = response.body.getReader();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (canceled) return;
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch {
          if (canceled) return;
          // Body failures occur after Hono's handler error boundary. Never hand
          // parser diagnostics, causes or attached input to the Node adapter.
          logger.error('Response stream failed');
          const failure = new Error('Response stream failed');
          controller.error(failure);
          // Its initial-read lookahead can otherwise turn rejection into clean
          // EOF; close the actual transport with only this fresh safe error.
          context.env?.outgoing?.destroy(failure);
          try { await reader.cancel(failure); } catch { /* The body already failed. */ }
          finally { reader.releaseLock(); }
        }
      },
      async cancel() {
        canceled = true;
        try { await reader.cancel(new Error('Response stream canceled')); }
        catch {
          logger.error('Response stream cancellation failed');
          throw new Error('Response stream cancellation failed');
        } finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 });
    context.res = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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
    const anthropicGeneration = request.method === 'POST' && resolved.route.protocol === 'anthropic-messages'
      && resolved.pathname === '/v1/messages';
    const responsesGeneration = request.method === 'POST' && resolved.route.protocol === 'openai-responses'
      && resolved.pathname === '/v1/responses';
    const chatGeneration = request.method === 'POST' && resolved.route.protocol === 'openai-chat'
      && resolved.pathname === '/v1/chat/completions';
    const adapter = anthropicGeneration ? anthropicAdapter : responsesGeneration ? responsesAdapter : chatGeneration ? chatAdapter : undefined;
    const generation = adapter !== undefined;
    const extracted = adapter && body ? adapter.extractRequest(body) : undefined;
    const sourceHeaders = new Headers(request.headers);
    const bearer = /^Bearer[\t ]+(\S+)$/i.exec(sourceHeaders.get('authorization') ?? '')?.[1];
    const supplied = [bearer, sourceHeaders.get('x-api-key')].filter((value): value is string => Boolean(value));
    const identityCredential = config.auth.mode === 'vault'
      ? config.auth.client_tokens.find((token) => supplied.includes(token))
      : supplied.sort().join('\0');
    const identity = identityCredential ? createHmac('sha256', identityKey).update(identityCredential).digest('hex') : undefined;
    const session = sourceHeaders.get('x-session-id') ?? sourceHeaders.get('x-claude-code-session-id') ?? undefined;
    const version = /\bclaude-(?:cli|code)\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/i.exec(sourceHeaders.get('user-agent') ?? '')?.[1];
    const scope = { identity, route: resolved.route.prefix, session, version };
    const requestContext: RequestContext = extracted ?? { stream: false };
    requestContext.source = { headers: sourceHeaders, route: resolved.route.prefix, identity, session_id: session, agent_version: version };
    let upstream = resolved.upstream;
    let pathname = resolved.pathname + url.search;
    let headers = buildUpstreamHeaders(request.headers, upstream, config.auth.mode);
    let delivery: 'native' | 'rewrite' = 'rewrite';
    let rerouted = false;
    if (generation && body) {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { /* Preserve invalid request for upstream validation. */ }
      if (anthropicGeneration) {
        deliveryState.observeRequest(scope, isClassifierRequest(parsed));
        delivery = deliveryState.select(requestContext, scope, resolved.route);
      }
      if (anthropicGeneration && isSuspectedClassifierRequest(parsed)) {
        void audit.appendEvent({ event: 'suspected_classifier', route: resolved.route.prefix, protocol: resolved.route.protocol, session_id: session });
      }
      let target;
      try { target = prepareClassifierTarget(parsed, request.headers, config); }
      catch {
        return errorResponse(502, 'api_error', 'Trusted classifier target is unavailable');
      }
      if (target) {
        rerouted = true;
        upstream = { ...resolved.upstream, base_url: target.url.origin, api_key: undefined, extra_headers: undefined };
        pathname = target.url.pathname + target.url.search;
        headers = target.headers;
        body = target.body as Uint8Array<ArrayBuffer>;
      } else if (anthropicGeneration) {
        const prepared = prepareAnthropicRequest(body, headers, requestContext, upstream, config.gate.mode);
        body = prepared.body as Uint8Array<ArrayBuffer>;
        headers = prepared.headers;
      }
    }
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    const response = await forwardUpstream(forwarded, upstream, pathname, config, {
      signal: controller.signal,
      onError: (httpStatus) => logger.error({ status: httpStatus }, 'Upstream transport failed'),
    });
    // A downstream SDK can follow an upstream redirect back into an opaque
    // metadata route. Manual upstream fetch alone does not preserve this gate.
    if (generation && !rerouted && config.gate.mode === 'enforce' && response.status >= 300 && response.status < 400) {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      return errorResponse(502, 'api_error', 'Upstream generation redirects are not supported');
    }
    // Classifier responses are opaque trusted transport, not agent tool generations.
    if (!generation || rerouted || !response.ok) return response;
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'text/event-stream' && mediaType !== 'application/json') {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      return errorResponse(502, 'api_error', 'Unsupported upstream generation content type');
    }
    if (!extracted) requestContext.stream = mediaType === 'text/event-stream';
    const classifierContext = requestContext.classifier_context;
    const client = classifierContext !== null && typeof classifierContext === 'object' && !Array.isArray(classifierContext)
      ? classifierContext as Record<string, unknown> : {};
    const workdir = typeof client.live_cwd === 'string' ? client.live_cwd : undefined;
    const trusted = Array.isArray(client.trusted_directories)
      ? client.trusted_directories.filter((value): value is string => typeof value === 'string') : [];
    const gateContext: GateContext = {
      project_dir: resolved.route.project_dirs?.[0] ?? workdir,
      workdir,
      trusted_directories: trusted,
      lastUserText: requestContext.lastUserText,
      route: resolved.route.prefix,
      protocol: resolved.route.protocol,
      // Audit-only hints: retain both documented sources without interpreting
      // either as identity. The audit sanitizer sees the complete uncropped text;
      // delivery version extraction remains confined to the User-Agent above.
      agent_hint: [sourceHeaders.get('user-agent'), sourceHeaders.get('x-claude-code-request-class')].filter(Boolean).join(' ') || undefined,
      session_id: session,
      delivery: config.gate.mode === 'shadow' ? 'shadow' : delivery === 'native' ? 'safeguard' : 'rewrite',
    };
    return adapter!.transformResponse(response, requestContext, {
      signal: forwarded.signal,
      mode: config.gate.mode,
      delivery,
      holdKeepaliveMs: config.gate.hold_keepalive_ms,
      onNativeDelivered: () => deliveryState.nativeDelivered(scope),
      trackObservation(work) {
        const settled = work.then(() => {}, () => {});
        observations.add(settled);
        void settled.then(() => observations.delete(settled));
      },
      onToolCall: (call, _context, signal) => gate.decide(
        normalizeToolCall(resolved.route.protocol, call, { ...gateContext, request: requestContext }, resolved.route, policy),
        { ...gateContext, signal },
      ),
    });
  });
  return Object.assign(app, {
    async flushAudit() {
      // Call after response disposal: shadow verdicts may enqueue audit later.
      while (observations.size > 0) await Promise.all([...observations]);
      await gate.flushAudit();
      await audit.flush();
    },
  });
}
