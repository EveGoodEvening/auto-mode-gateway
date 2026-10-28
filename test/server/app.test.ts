import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';

import { configSchema, type Config } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function mockServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock address');
  return `http://127.0.0.1:${address.port}`;
}

function config(base: string, overrides: Partial<Config> = {}): Config {
  return configSchema.parse({
    auth: { mode: 'vault', client_tokens: ['disposable-client'], admin_token: 'disposable-admin' },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock' }],
    upstreams: { mock: { base_url: base, api_key: 'disposable-upstream', auth_header: 'both' } },
    decision: {
      chain: ['mock'],
      providers: { mock: { kind: 'systemone', base_url: base, api_key: 'disposable-provider', model: 'mock' } },
    },
    log_level: 'silent',
    ...overrides,
  });
}

const credentials = { authorization: 'Bearer disposable-client' };

describe('createApp authenticated transparent transport', () => {
  it('exposes health without auth and denies status without a real loopback peer or admin token', async () => {
    const app = createApp(config('http://127.0.0.1:1'));
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/_amp/status', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403);
    expect((await app.request('/_amp/status', { headers: credentials })).status).toBe(403);
    const status = await app.request('/_amp/status', { headers: { authorization: 'Bearer disposable-admin' } });
    expect(status.status).toBe(200);
    const text = await status.text();
    expect(text).not.toContain('disposable-client');
    expect(text).not.toContain('disposable-upstream');
    expect(text).not.toContain('disposable-provider');
  });

  it('uses the socket identity for real HTTP status access, irrespective of forwarded headers', async () => {
    const server = serve({ fetch: createApp(config('http://127.0.0.1:1')).fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    cleanups.push(async () => {
      const closed = once(server, 'close');
      server.close();
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await closed;
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener address');
    const result = await fetch(`http://127.0.0.1:${address.port}/_amp/status`, {
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(result.status).toBe(200);
    await result.arrayBuffer();
  });

  it('rejects invalid credentials before contacting the upstream with an Anthropic error body', async () => {
    let requests = 0;
    const base = await mockServer((_request, response) => { requests++; response.end(); });
    const result = await createApp(config(base)).request('/cc/v1/messages', {
      method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}',
    });
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(requests).toBe(0);
  });

  it.each(['/v1/models?cursor=a%2Fb&limit=2', '/v1/messages/count_tokens', '/api/hello'])('forwards untouched paths and error bytes: %s', async (path) => {
    const bytes = Buffer.from([0, 255, 123, 13, 10, 125]);
    const base = await mockServer((request, response) => {
      expect(request.url).toBe(path);
      expect(request.headers.authorization).toBe('Bearer disposable-upstream');
      expect(request.headers['x-api-key']).toBe('disposable-upstream');
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      expect(request.headers['accept-encoding']).toBe('identity');
      response.writeHead(429, { 'retry-after': '7', 'x-ratelimit-remaining': '0' });
      response.end(bytes);
    });
    const result = await createApp(config(base)).request(`/cc${path}`, {
      headers: { ...credentials, 'anthropic-version': '2023-06-01' },
    });
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('7');
    expect(result.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
  });

  it('preserves opaque request bytes, JSON responses and the configured /v1 base boundary', async () => {
    const payload = Buffer.from([0, 255, 10, 32, 123, 125]);
    const base = await mockServer((request, response) => {
      expect(request.url).toBe('/v1/responses?x=1');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(Buffer.concat(chunks)).toEqual(payload);
        response.setHeader('content-type', 'application/json');
        response.end('{ "untouched": true }\n');
      });
    });
    const result = await createApp(config(`${base}/v1`)).request('/cc/v1/responses?x=1', {
      method: 'POST', headers: credentials, body: payload,
    });
    expect(await result.text()).toBe('{ "untouched": true }\n');
  });

  it('forwards HEAD without inventing a body', async () => {
    const base = await mockServer((request, response) => {
      expect(request.method).toBe('HEAD');
      expect(request.url).toBe('/api/hello');
      response.setHeader('x-mock', 'head');
      response.end();
    });
    const result = await createApp(config(base)).request('/cc/api/hello', { method: 'HEAD', headers: credentials });
    expect(result.headers.get('x-mock')).toBe('head');
    expect(await result.text()).toBe('');
  });

  it('enforces both declared and chunked body limits before upstream contact', async () => {
    let requests = 0;
    const base = await mockServer((request, response) => {
      requests++;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(Buffer.concat(chunks).toString()).toBe('1234');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'msg_body_limit', type: 'message', role: 'assistant', model: 'mock',
          content: [{ type: 'text', text: 'accepted boundary' }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    const settings = config(base);
    settings.limits.request_body_bytes = 4;
    const app = createApp(settings);
    const declared = await app.request('/cc/v1/messages', {
      method: 'POST', headers: { ...credentials, 'content-length': '5' }, body: '12345',
    });
    expect(declared.status).toBe(413);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    const request = new Request('http://localhost/cc/v1/messages', {
      method: 'POST', headers: credentials, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const chunked = await app.request(request);
    expect(chunked.status).toBe(413);
    expect(requests).toBe(0);
    const accepted = await app.request('/cc/v1/messages', { method: 'POST', headers: credentials, body: '1234' });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      type: 'message', content: [{ type: 'text', text: 'accepted boundary' }],
    });
    expect(requests).toBe(1);
  });

  it('does not buffer SSE until completion', async () => {
    const release = Promise.withResolvers<void>();
    const base = await mockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': original\r\ndata: first\r\n\r\n');
      void release.promise.then(() => response.end('data: last\n\n'));
    });
    const response = await createApp(config(base)).request('/cc/v1/messages', { headers: credentials });
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(': original\r\ndata: first\r\n\r\n');
    } finally {
      release.resolve();
      while (!(await reader.read()).done) { /* drain the owned response */ }
      reader.releaseLock();
    }
  });

  it('cancels the upstream when a real HTTP client disconnects mid-stream', async () => {
    const disconnected = Promise.withResolvers<void>();
    const base = await mockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: initial\n\n');
      response.once('close', () => disconnected.resolve());
    });
    const server = serve({ fetch: createApp(config(base)).fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    cleanups.push(async () => {
      const closed = once(server, 'close');
      server.close();
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await closed;
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener address');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/cc/v1/messages`, {
      headers: credentials, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const result = await Promise.race([
      disconnected.promise.then(() => true),
      delay(1000).then(() => false),
    ]);
    expect(result).toBe(true);
  });

  it('never releases malformed execution from a successful generation even with unparseable request metadata', async () => {
    const base = await mockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":"msg_mock","type":"message","content":[{"type":"tool_use","id":"must_not_escape","name":"echo"}]}');
    });
    const response = await createApp(config(base)).request('/cc/v1/messages', {
      method: 'POST', headers: credentials, body: 'opaque request bytes',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('must_not_escape');
  });

  it.each([
    '{"type":"error","error":{"type":"overloaded_error","message":"fixture"}}\r\n',
    '{ "unknown": true }\r\n',
  ])('preserves successful opaque/error JSON without treating it as generation: %s', async (body) => {
    const base = await mockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
    const response = await createApp(config(base)).request('/cc/v1/messages', {
      method: 'POST', headers: credentials, body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it('adapts a complete nonstream Messages tool response without changing request or response bytes', async () => {
    const requestBytes = Buffer.from(' { "model": "mock", "stream": false, "messages": [{"role":"user","content":"你好"}] }\r\n');
    const responseBytes = Buffer.from(' { "id":"msg_mock", "type":"message", "role":"assistant", "content":[{"type":"tool_use","id":"call_mock","name":"echo","input":{"text":"fixture"}}], "stop_reason":"tool_use" }\n');
    const base = await mockServer((request, response) => {
      expect(request.url).toBe('/v1/messages?fixture=1');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(Buffer.concat(chunks)).toEqual(requestBytes);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-mock': 'nonstream' });
        response.end(responseBytes);
      });
    });
    const response = await createApp(config(base)).request('/cc/v1/messages?fixture=1', {
      method: 'POST', headers: { ...credentials, 'content-type': 'application/json' }, body: requestBytes,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-mock')).toBe('nonstream');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(responseBytes);
  });

  it('streams text before tool completion and releases complete allowed fixture frames byte-for-byte', async () => {
    const frame = (event: string, data: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
    const initial = ': fixture raw comment\r\n\r\n'
      + frame('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [] } })
      + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'visible now' } })
      + frame('content_block_stop', { type: 'content_block_stop', index: 0 });
    const toolStart = frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_mock', name: 'echo', input: {} } });
    const tail = frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"fixture"}' } })
      + frame('content_block_stop', { type: 'content_block_stop', index: 1 })
      + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
      + frame('message_stop', { type: 'message_stop' });
    const release = Promise.withResolvers<void>();
    const base = await mockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(initial + toolStart);
      void release.promise.then(() => response.end(tail));
    });
    const response = await createApp(config(base)).request('/cc/v1/messages', {
      method: 'POST', headers: credentials, body: '{"model":"mock","stream":true,"messages":[]}',
    });
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let visible = '';
    try {
      while (!visible.includes('visible now')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        chunks.push(chunk.value!);
        visible += new TextDecoder().decode(chunk.value);
      }
      expect(visible).not.toContain('call_mock');
    } finally {
      release.resolve();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      reader.releaseLock();
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(initial + toolStart + tail));
  });

  it.each([undefined, 'application/octet-stream', 'text/plain'])('rejects generation MIME bypass before releasing tool bytes: %s', async (contentType) => {
    const base = await mockServer((_request, response) => {
      if (contentType) response.setHeader('content-type', contentType);
      response.end('{"type":"message","content":[{"type":"tool_use","id":"must_not_escape","name":"echo","input":{}}]}');
    });
    const response = await createApp(config(base)).request('/cc/v1/messages', {
      method: 'POST', headers: credentials, body: '{"model":"mock","messages":[]}',
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('must_not_escape');
  });

  it.each([
    ['POST', '/v1/messages/count_tokens', 200, 'application/json'],
    ['POST', '/unknown', 200, 'application/json'],
    ['GET', '/v1/messages', 200, 'application/json'],
    ['POST', '/v1/messages', 429, 'application/json'],
  ] as const)('leaves non-generation/error bodies opaque: %s %s %s %s', async (method, path, status, contentType) => {
    // Deliberately invalid as a Messages tool response: interception would fail.
    const bytes = Buffer.from('{"type":"error","content":[{"type":"tool_use","id":"broken"}]}\r\n');
    const base = await mockServer((_request, response) => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(bytes);
    });
    const response = await createApp(config(base)).request(`/cc${path}`, {
      method, headers: credentials, ...(method === 'POST' ? { body: '{}' } : {}),
    });
    expect(response.status).toBe(status);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
});

it('runs the genuine serve CLI with config/log-level and shuts down its owned listener on SIGTERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amp-serve-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const address = reserve.address();
  if (!address || typeof address === 'string') throw new Error('Missing reserved address');
  const closed = once(reserve, 'close');
  reserve.close();
  await closed;
  const settings = config('http://127.0.0.1:1', { listen: { host: '127.0.0.1', port: address.port } });
  const path = join(directory, 'config.yaml');
  await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'src/cli/index.ts', 'serve', '--config', path, '--log-level', 'silent',
  ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      await response.arrayBuffer();
      if (response.status === 200) { ready = true; break; }
    } catch { /* listener is still starting */ }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(25);
  }
  expect(ready).toBe(true);
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  expect(code).toBe(0);
  expect(signal).toBeNull();
  expect(output).toBe('');
}, 15_000);
