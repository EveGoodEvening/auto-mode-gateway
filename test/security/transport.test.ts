import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configSchema, type Config } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createStatus } from '../../src/server/status.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function own(server: ServerType) {
  cleanups.push(() => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
    return promise;
  });
}
async function address(server: ServerType) {
  await once(server, 'listening');
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === 'string') throw new Error('Missing owned loopback address');
  return `http://127.0.0.1:${endpoint.port}`;
}
async function relay(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  own(server);
  server.listen(0, '127.0.0.1');
  return address(server);
}
async function configuration(base = 'http://127.0.0.1:1', overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'amp-security-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return configSchema.parse({
    auth: { mode: 'vault', client_tokens: ['fake-security-client-42'], admin_token: 'fake-security-admin-42' },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock' }],
    upstreams: { mock: { base_url: base, api_key: 'fake-security-upstream-42' } },
    decision: { chain: ['mock'], providers: { mock: { kind: 'systemone', base_url: base, api_key: 'fake-security-provider-42', model: 'mock' } } },
    audit: { path: join(directory, 'audit.jsonl') },
    log_level: 'silent',
    ...overrides,
  });
}
const auth = { authorization: `Bearer ${'fake-security-client-42'}` };

describe('security transport consumer contracts', () => {
  it('rejects nonloopback configuration without client credentials before creating a listener', async () => {
    const config = await configuration();
    expect(() => configSchema.parse({ ...config, listen: { host: '0.0.0.0', port: 8484 }, auth: { ...config.auth, client_tokens: [] } })).toThrow();
    expect(configSchema.parse({ ...config, listen: { host: '0.0.0.0', port: 8484 } }).listen.host).toBe('0.0.0.0');
  });

  it('rejects a declared body over the default 64 MB boundary without contacting upstream', async () => {
    let upstreamCalls = 0;
    const base = await relay((_request, response) => { upstreamCalls++; response.end('unexpected'); });
    const result = await createApp(await configuration(base)).request('/cc/opaque', { method: 'POST', headers: { ...auth, 'content-length': '64000001' }, body: 'small' });
    expect(result.status).toBe(413);
    expect(await result.json()).toMatchObject({ error: { type: 'request_too_large' } });
    expect(upstreamCalls).toBe(0);
  });

  it('enforces actual chunked bytes, cancels overflow, and allows the exact configured boundary', async () => {
    const received: string[] = [];
    const base = await relay((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => { received.push(body); response.end('accepted'); });
    });
    const config = await configuration(base);
    config.limits.request_body_bytes = 8;
    const app = createApp(config);
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(1)); },
      cancel() { canceled = true; },
    });
    const request = new Request('http://gateway/cc/opaque', { method: 'POST', headers: auth, body, duplex: 'half' } as RequestInit);
    const rejected = await app.fetch(request);
    expect(rejected.status).toBe(413);
    expect(canceled).toBe(true);
    expect(received).toEqual([]);
    const accepted = await app.request('/cc/opaque', { method: 'POST', headers: auth, body: '12345678' });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe('accepted');
    expect(received).toEqual(['12345678']);
  });

  it.each([false, true])('never uses forwarded loopback for management authorization, trust_proxy=%s', async (trust_proxy) => {
    const config = await configuration(undefined, { trust_proxy });
    const status = createStatus(config);
    const forged = new Headers({ 'x-forwarded-for': '127.0.0.1', ...auth });
    expect(status.response(forged, '203.0.113.42').status).toBe(403);
    expect(status.response(forged, undefined).status).toBe(403);
    forged.set('authorization', `Bearer ${config.auth.admin_token!}`);
    const allowed = status.response(forged, '203.0.113.42');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    const output = await allowed.text();
    for (const secret of ['fake-security-client-42', 'fake-security-admin-42', 'fake-security-upstream-42', 'fake-security-provider-42']) expect(output).not.toContain(secret);
  });

  it.each(['connect', 'read'] as const)('bounds stalled upstream %s and emits fixed credential-free diagnostics', async (phase) => {
    const base = await relay((_request, response) => {
      if (phase === 'read') response.writeHead(200, { 'content-type': 'text/plain' }).flushHeaders();
      // No headers/body completion: owned socket cleanup is mandatory below.
    });
    let logs = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { logs += chunk.toString(); return true; }) as typeof process.stderr.write);
    const config = await configuration(base, { log_level: 'info' });
    config.limits.upstream_connect_timeout_ms = phase === 'connect' ? 30 : 1000;
    config.limits.upstream_read_timeout_ms = phase === 'read' ? 30 : 1000;
    const server = serve({ fetch: createApp(config).fetch, hostname: '127.0.0.1', port: 0 });
    own(server);
    const proxy = await address(server);
    const result = await fetch(`${proxy}/cc/opaque?secret=fake-query-secret-42`, { headers: auth, signal: AbortSignal.timeout(3000) });
    expect(result.status).toBe(504);
    expect(await result.json()).toMatchObject({ error: { type: 'timeout_error' } });
    expect(logs).toContain('Upstream transport failed');
    for (const secret of ['fake-security-client-42', 'fake-security-upstream-42', 'fake-query-secret-42']) expect(logs).not.toContain(secret);
  });

  it.each([false, true])('captures actual HTTP completion logs with trust_proxy=%s without credentials or request URLs', async (trust_proxy) => {
    let logs = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { logs += chunk.toString(); return true; }) as typeof process.stderr.write);
    const server = serve({ fetch: createApp(await configuration(undefined, { trust_proxy, log_level: 'info' })).fetch, hostname: '127.0.0.1', port: 0 });
    own(server);
    const proxy = await address(server);
    const result = await fetch(`${proxy}/healthz?fake-query-secret-42`, { headers: { ...auth, 'x-api-key': 'fake-header-secret-42', 'x-forwarded-for': '198.51.100.42' }, signal: AbortSignal.timeout(3000) });
    expect(result.status).toBe(200);
    await result.arrayBuffer();
    const rows = logs.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toContainEqual(expect.objectContaining({ msg: 'Request completed', method: 'GET', status: 200, client_address: trust_proxy ? '198.51.100.42' : '127.0.0.1' }));
    for (const secret of ['fake-security-client-42', 'fake-header-secret-42', 'fake-query-secret-42']) expect(logs).not.toContain(secret);
  });
});
