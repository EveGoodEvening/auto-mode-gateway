import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { forwardUpstream } from '../../src/server/upstream.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
    return promise;
  }));
});

async function mock(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock listener');
  return `http://127.0.0.1:${address.port}`;
}

function configuration(base_url: string, limits = {}) {
  return configSchema.parse({
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }],
    upstreams: { relay: { base_url } },
    decision: { chain: ['mock'], providers: { mock: { kind: 'systemone', base_url: 'http://127.0.0.1', api_key: 'disposable', model: 'mock' } } },
    limits,
  });
}

async function requestBytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// These tests contact only disposable, loopback-bound HTTP mocks. The transport
// is deliberately unprotected until later gate integration.
describe('forwardUpstream', () => {
  it('forwards unknown binary request/error bytes without JSON parsing or rewriting', async () => {
    const bytes = new Uint8Array([0, 255, 32, 123, 13, 10, 128]);
    const error = Buffer.from('  upstream failure\r\nnot-json\u0000');
    const observed = Promise.withResolvers<{ body: Buffer; url: string | undefined; headers: IncomingMessage['headers'] }>();
    const base = await mock((request, response) => {
      void requestBytes(request).then((body) => {
        observed.resolve({ body, url: request.url, headers: request.headers });
        response.writeHead(429, {
          'content-type': 'application/octet-stream', 'retry-after': '7', 'x-ratelimit-remaining': '0',
          connection: 'close, x-response-hop', 'x-response-hop': 'discard',
          'set-cookie': ['one=1; Path=/', 'two=2; Path=/'],
        });
        response.end(error);
      });
    });
    const config = configuration(base);
    const request = new Request('http://gateway/cc/api/hello?a=%2f&a=2', {
      method: 'POST', body: bytes,
      headers: {
        connection: 'keep-alive, X-Private-Hop', 'x-private-hop': 'discard', 'proxy-authorization': 'discard',
        'accept-encoding': 'gzip', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'original-beta',
        'x-claude-code-test': 'claude', 'x-codex-test': 'codex', 'x-other': 'unchanged',
        authorization: 'Bearer disposable-upstream', 'content-type': 'application/octet-stream',
      },
    });
    const result = await forwardUpstream(request, config.upstreams.relay!, '/api/hello?a=%2f&a=2', config);
    expect(result.status).toBe(429);
    expect(Buffer.from(await result.arrayBuffer())).toEqual(error);
    const incoming = await observed.promise;
    expect(incoming.body).toEqual(Buffer.from(bytes));
    expect(incoming.url).toBe('/api/hello?a=%2f&a=2');
    expect(incoming.headers['x-private-hop']).toBeUndefined();
    expect(incoming.headers['proxy-authorization']).toBeUndefined();
    expect(incoming.headers['accept-encoding']).toBe('identity');
    expect(incoming.headers['anthropic-version']).toBe('2023-06-01');
    expect(incoming.headers['anthropic-beta']).toBe('original-beta');
    expect(incoming.headers['x-claude-code-test']).toBe('claude');
    expect(incoming.headers['x-codex-test']).toBe('codex');
    expect(incoming.headers['x-other']).toBe('unchanged');
    expect(incoming.headers.authorization).toBe('Bearer disposable-upstream');
    expect(result.headers.get('retry-after')).toBe('7');
    expect(result.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(result.headers.get('connection')).toBeNull();
    expect(result.headers.get('x-response-hop')).toBeNull();
    expect(result.headers.get('content-length')).toBeNull();
    expect(result.headers.getSetCookie()).toEqual(['one=1; Path=/', 'two=2; Path=/']);
  });

  it.each([
    ['', '/v1/models', '/v1/models'],
    ['/v1', '/v1/responses?x=%2F', '/v1/responses?x=%2F'],
    ['/api/v1', '/v1/responses', '/api/v1/responses'],
    ['/api', '/v1/messages', '/api/v1/messages'],
    ['/v1', '/v10/unknown', '/v1/v10/unknown'],
    ['/v1', '/v1?x=1', '/v1?x=1'],
    ['', '//external.invalid/path', '//external.invalid/path'],
  ])('joins base path %s and path %s without changing the target origin', async (prefix, path, expected) => {
    const base = await mock((request, response) => response.end(request.url));
    const config = configuration(base + prefix);
    const response = await forwardUpstream(new Request('http://gateway/unused'), config.upstreams.relay!, path, config);
    expect(await response.text()).toBe(expected);
  });

  it.each(['HEAD', 'GET', 'POST'])('preserves %s semantics for unknown endpoints', async (method) => {
    const base = await mock((request, response) => {
      expect(request.method).toBe(method);
      response.setHeader('x-original', 'retained');
      response.end('{ "untouched" : true }\n');
    });
    const config = configuration(base);
    const path = method === 'HEAD' ? '/api/hello' : method === 'GET' ? '/v1/models' : '/v1/messages/count_tokens';
    const response = await forwardUpstream(new Request(`http://gateway${path}`, { method }), config.upstreams.relay!, path, config);
    expect(response.headers.get('x-original')).toBe('retained');
    expect(await response.text()).toBe(method === 'HEAD' ? '' : '{ "untouched" : true }\n');
  });

  it('returns redirects without forwarding any credentials to the redirect target', async () => {
    const second = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end('unexpected'));
    const destination = await mock(second);
    const base = await mock((_request, response) => {
      response.writeHead(307, { location: `${destination}/private`, 'retry-after': '2' });
      response.end('original redirect');
    });
    const config = configuration(base);
    const request = new Request('http://gateway/unknown', { headers: { authorization: 'Bearer disposable', 'x-api-key': 'disposable' } });
    const response = await forwardUpstream(request, config.upstreams.relay!, '/unknown', config);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${destination}/private`);
    expect(await response.text()).toBe('original redirect');
    expect(second).not.toHaveBeenCalled();
  });

  it('removes stale compression metadata if an upstream ignores identity', async () => {
    const body = Buffer.from('unchanged decoded payload');
    const base = await mock((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': gzipSync(body).length });
      response.end(gzipSync(body));
    });
    const config = configuration(base);
    const response = await forwardUpstream(new Request('http://gateway/unknown'), config.upstreams.relay!, '/unknown', config);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  it('delivers the first SSE event within 50ms without waiting for the second event', async () => {
    const first = ': ping\r\nid: 1\r\ndata: { "text": "hello" }\r\n\r\n';
    const second = 'event: done\ndata: {}\n\n';
    let sent = 0;
    let finish: (() => void) | undefined;
    const base = await mock((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      sent = performance.now();
      response.write(first);
      finish = () => response.end(second);
    });
    const config = configuration(base);
    const response = await forwardUpstream(new Request('http://gateway/stream'), config.upstreams.relay!, '/stream', config);
    const reader = response.body!.getReader();
    const event = await reader.read();
    expect(performance.now() - sent).toBeLessThan(50);
    expect(new TextDecoder().decode(event.value)).toBe(first);
    finish!();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(second);
    expect((await reader.read()).done).toBe(true);
  });

  it.each(['body', 'request', 'option'] as const)('aborts the upstream on downstream %s cancellation', async (source) => {
    const closed = Promise.withResolvers<void>();
    const base = await mock((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      response.on('close', () => closed.resolve());
    });
    const config = configuration(base);
    const abort = new AbortController();
    const request = new Request('http://gateway/stream', source === 'request' ? { signal: abort.signal } : {});
    const response = await forwardUpstream(request, config.upstreams.relay!, '/stream', config, source === 'option' ? { signal: abort.signal } : undefined);
    if (source === 'body') await response.body!.cancel();
    else {
      abort.abort();
      await expect(response.arrayBuffer()).rejects.toThrow();
    }
    await closed.promise;
  });

  it('applies downstream backpressure rather than draining an unconsumed response', async () => {
    let completed = false;
    let stopped = false;
    const base = await mock((_request, response) => {
      response.on('close', () => { stopped = true; });
      const chunk = Buffer.alloc(64 * 1024, 97);
      let remaining = 512;
      const send = () => {
        while (!stopped && remaining > 0) {
          remaining--;
          if (!response.write(chunk)) { response.once('drain', send); return; }
        }
        if (!stopped) { completed = true; response.end(); }
      };
      send();
    });
    const config = configuration(base);
    const response = await forwardUpstream(new Request('http://gateway/large'), config.upstreams.relay!, '/large', config);
    await delay(50);
    expect(completed).toBe(false);
    await response.body!.cancel();
  });

  it('returns a safe 502 on connection failure and records only the status', async () => {
    const base = await mock((_request, response) => response.end());
    const server = servers.pop()!;
    const shutdown = Promise.withResolvers<void>();
    server.close(() => shutdown.resolve());
    await shutdown.promise;
    const config = configuration(base);
    const onError = vi.fn();
    const response = await forwardUpstream(new Request('http://gateway/unknown'), config.upstreams.relay!, '/unknown', config, { onError });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"type":"error","error":{"type":"api_error","message":"Upstream connection failed"}}');
    expect(onError).toHaveBeenCalledExactlyOnceWith(502);
  });

  it.each(['headers', 'body'])('returns 504 when upstream %s never arrive', async (stage) => {
    const closed = Promise.withResolvers<void>();
    const base = await mock((_request, response) => {
      response.on('close', () => closed.resolve());
      if (stage === 'body') { response.writeHead(200); response.flushHeaders(); }
    });
    const config = configuration(base, { upstream_connect_timeout_ms: 50, upstream_read_timeout_ms: 50 });
    const onError = vi.fn();
    const response = await forwardUpstream(new Request('http://gateway/unknown'), config.upstreams.relay!, '/unknown', config, { onError });
    expect(response.status).toBe(504);
    expect(onError).toHaveBeenCalledExactlyOnceWith(504);
    await closed.promise;
  });

  it('terminates a stalled streaming response after its read timeout without rewriting prior bytes', async () => {
    const closed = Promise.withResolvers<void>();
    const base = await mock((_request, response) => {
      response.write('data: retained\n\n');
      response.on('close', () => closed.resolve());
    });
    const config = configuration(base, { upstream_read_timeout_ms: 50 });
    const onError = vi.fn();
    const response = await forwardUpstream(new Request('http://gateway/stream'), config.upstreams.relay!, '/stream', config, { onError });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: retained\n\n');
    await expect(reader.read()).rejects.toThrow('Upstream read timed out');
    expect(onError).toHaveBeenCalledExactlyOnceWith(504);
    await closed.promise;
  });
});
