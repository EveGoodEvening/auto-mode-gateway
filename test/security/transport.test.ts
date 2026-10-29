import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  it('rejects missing nonloopback client tokens in the real serve CLI before any listener or network attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amp-security-startup-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const preload = join(directory, 'deny-network.cjs');
    await writeFile(preload, `
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const dgram = require('node:dgram');
const { isMainThread } = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const NativeError = Error;
const captureStackTrace = NativeError.captureStackTrace;
const loaderRoot = path.dirname(require.resolve('tsx', { paths: [process.cwd()] }));
const loaderOrigins = [
  { path: path.join(loaderRoot, 'client-XItNFmsq.cjs'), kind: 'loader-cjs-ipc-denied' },
  { path: path.join(loaderRoot, 'require-CBjy4Foe.mjs'), kind: 'loader-esm-ipc-denied' },
];
const privateLoaderPipe = path.join(__dirname, 'tsx-' + process.geteuid(), String(process.ppid) + '.pipe');
function report(kind) { fs.writeSync(3, JSON.stringify({ kind }) + '\\n'); }
function deny(kind) { return function () { report(kind); throw new Error('Startup network guard'); }; }
net.Server.prototype.listen = deny('listen');
net.Socket.prototype.connect = deny('network');
net.connect = deny('network');
net.createConnection = function deniedConnection(...args) {
  let kind = 'network';
  // The installed loader makes these exact bootstrap probes. Classify only its
  // immediate native callsite AND its exact owned private pathname/signature.
  // All calls still throw before native connection, including these probes.
  if (args.length === 2 && args[0] === privateLoaderPipe && typeof args[1] === 'function') {
    const previous = NativeError.prepareStackTrace;
    try {
      NativeError.prepareStackTrace = (_error, frames) => frames;
      const marker = {};
      captureStackTrace(marker, deniedConnection);
      let filename = marker.stack[0]?.getFileName();
      if (filename?.startsWith('file:')) filename = fileURLToPath(filename);
      const origin = loaderOrigins.find((entry) => entry.path === filename);
      if (origin) kind = origin.kind;
    } catch {
      kind = 'network';
    } finally {
      NativeError.prepareStackTrace = previous;
    }
  }
  report(kind);
  throw new NativeError('Startup network guard');
};
http.request = http.get = https.request = https.get = deny('network');
dgram.Socket.prototype.connect = dgram.Socket.prototype.send = deny('network');
for (const key of ['lookup', 'lookupService', 'reverse', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']) {
  if (typeof dns[key] === 'function') dns[key] = deny('network');
  if (typeof dns.promises[key] === 'function') dns.promises[key] = deny('network');
}
globalThis.fetch = deny('network');
syncBuiltinESMExports();
if (isMainThread) {
  report('ready');
  process.once('exit', () => report('exit'));
}
`, { mode: 0o600 });
    const config = await configuration();
    config.listen = { host: '0.0.0.0', port: 8484 };
    async function startup(client_tokens: string[]) {
      const path = join(directory, client_tokens.length === 0 ? 'missing.yaml' : 'present.yaml');
      await writeFile(path, JSON.stringify({ ...config, auth: { ...config.auth, client_tokens } }), { mode: 0o600 });
      const child = spawn(process.execPath, [
        '--require', preload, '--import', 'tsx', 'src/cli/index.ts', 'serve', '--config', path,
      ], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {
          HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory,
          XDG_STATE_HOME: directory, XDG_CACHE_HOME: directory, TMPDIR: directory,
          PATH: '/usr/bin:/bin', FORCE_COLOR: '0', TSX_DISABLE_CACHE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL',
      });
      const { promise, resolve } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
      let spawnFailed = false;
      let overflow = false;
      let stdout = '';
      let stderr = '';
      let guard = '';
      let captured = 0;
      function receive(stream: 'stdout' | 'stderr' | 'guard', chunk: Buffer) {
        if (chunk.byteLength > 16_384 - captured) {
          overflow = true;
          child.kill('SIGKILL');
          return;
        }
        captured += chunk.byteLength;
        if (stream === 'stdout') stdout += chunk.toString();
        else if (stream === 'stderr') stderr += chunk.toString();
        else guard += chunk.toString();
      }
      child.stdout!.on('data', (chunk: Buffer) => receive('stdout', chunk));
      child.stderr!.on('data', (chunk: Buffer) => receive('stderr', chunk));
      child.stdio[3]!.on('data', (chunk: Buffer) => receive('guard', chunk));
      child.once('error', () => { spawnFailed = true; });
      child.once('close', (code, signal) => resolve({ code, signal }));
      let result;
      try {
        result = await promise;
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await promise;
        }
      }
      expect(spawnFailed).toBe(false);
      expect(overflow).toBe(false);
      expect(result).toEqual({ code: 1, signal: null });
      expect(stdout).toBe('');
      expect(stderr).toBe('Error: command failed. Check the command options and configuration.\n');
      const events = guard.trim().split('\n').map((line) => JSON.parse(line) as { kind: string });
      expect(events.filter(({ kind }) => kind === 'ready')).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === 'exit')).toHaveLength(1);
      expect(events.filter(({ kind }) => kind === 'network')).toHaveLength(0);
      expect(events.every(({ kind }) => ['ready', 'exit', 'listen', 'network', 'loader-cjs-ipc-denied', 'loader-esm-ipc-denied'].includes(kind))).toBe(true);
      return events.filter(({ kind }) => kind === 'listen').length;
    }
    // Identical CLI/config path, changing only tokens: invalid configuration must
    // fail before listen; its valid control must reach the real serve listener.
    // The preloaded guard records and throws BEFORE native listen, so even a
    // regression can never expose a public listener, and guard failure cannot
    // itself satisfy the negative zero-attempt assertion.
    expect(await startup([])).toBe(0);
    expect(await startup(config.auth.client_tokens)).toBe(1);
  }, 15_000);

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
