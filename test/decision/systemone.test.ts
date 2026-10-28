import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '../../src/policy/effective.js';
import { SystemOneProvider, estimateCost, parseSystemOneResponse, systemOneUrl } from '../../src/decision/systemone.js';
import { retryAfterMs } from '../../src/decision/http.js';
import type { DecisionState, ProviderConfig } from '../../src/decision/types.js';

const questions = DEFAULT_POLICY.questions;
const state: DecisionState = { action: { tool: 'Bash', command: 'npm install' }, environment: { platform: 'linux', project_dir: '/project', trusted_directories: [] }, user_request: 'Install dependencies' };
function wire() { return { model: 'jev-1.14.0', answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.1 }])), usage: { input_tokens: 100, output_tokens: 12 } }; }
const servers: Server[] = [];
async function mock(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function config(base_url: string, extra: Partial<ProviderConfig> = {}): ProviderConfig { return { kind: 'systemone', base_url, api_key: 'private-key-sentinel', model: 'jev-latest', envelope: 'none', ...extra }; }
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close(() => resolve());
    return promise;
  }));
});

describe('System One request forms', () => {
  it.each(['/v1', '/api/v1', '/api/alpha/decisions', '/client/v4/accounts/test/ai/run/@cf/cloudflare/clef-flash'])('uses configured form %s with protected fields and bearer auth', async (path) => {
    let seen = false;
    const base = await mock((request, response) => {
      expect(request.url).toBe(path.endsWith('/v1') ? `${path}/systemone` : path);
      expect(request.headers.authorization).toBe('Bearer private-key-sentinel');
      expect(request.headers['cf-aig-gateway-id']).toBe('gateway');
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({ model: 'jev-latest', state, questions, provider: { only: ['typesafe'] } });
        seen = true;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(wire()));
      });
    });
    const provider = new SystemOneProvider('one', config(base + path, { headers: { authorization: 'evil', 'cf-aig-gateway-id': 'gateway' }, body_extra: { model: 'evil', state: {}, questions: {}, provider: { only: ['typesafe'] } } }), 1000);
    const result = await provider.decide(state, questions);
    expect(seen).toBe(true);
    expect(result).toMatchObject({ provider: 'one', model: 'jev-1.14.0', usage: { input_tokens: 100, output_tokens: 12 } });
    expect(result.cost_usd).toBeCloseTo(0.0000042);
  });
  it('preserves complete URLs and handles origin roots', () => {
    expect(systemOneUrl('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(systemOneUrl('https://openrouter.ai/api/v1/systemone')).toBe('https://openrouter.ai/api/v1/systemone');
    expect(() => systemOneUrl('https://user:secret@example.com/v1')).toThrow();
  });
  it('does not follow credential-bearing redirects or expose provider body', async () => {
    let destinationCalls = 0;
    const destination = await mock((_request, response) => { destinationCalls++; response.end('{}'); });
    const origin = await mock((_request, response) => { response.writeHead(307, { location: destination }); response.end('private-key-sentinel'); });
    await expect(new SystemOneProvider('one', config(origin), 1000).decide(state, questions)).rejects.toMatchObject({ code: 'http', message: 'Decision provider failed (http)' });
    expect(destinationCalls).toBe(0);
  });
});

describe('strict response and metadata', () => {
  it.each(['none', 'cloudflare'] as const)('auto-detects direct and envelope responses with configured %s', async (envelope) => {
    let n = 0;
    const base = await mock((_request, response) => { response.end(JSON.stringify(n++ === 0 ? wire() : { success: true, errors: [], result: wire() })); });
    const provider = new SystemOneProvider('one', config(base, { envelope }), 1000);
    expect((await provider.decide(state, questions)).answers.destructive).toBe(0.1);
    expect((await provider.decide(state, questions)).answers.destructive).toBe(0.1);
  });
  it.each([undefined, null, '0.2', -0.1, 1.1, NaN, Infinity])('rejects unavailable or invalid probability %s', (value) => {
    const response = wire();
    response.answers.destructive = { type: 'noul', noul: value as number };
    expect(() => parseSystemOneResponse(response, questions)).toThrow();
  });
  it('rejects missing, refusal, numeric-only and unsuccessful envelopes', () => {
    for (const answer of [{ type: 'refusal', noul: 0 }, 0.1, { type: 'noul', noul: 0, refusal: 'no' }]) {
      expect(() => parseSystemOneResponse({ answers: { ...wire().answers, destructive: answer } }, questions)).toThrow();
    }
    const missing = wire(); delete missing.answers.destructive;
    expect(() => parseSystemOneResponse(missing, questions)).toThrow();
    expect(() => parseSystemOneResponse({ success: false, ...wire() }, questions)).toThrow();
    expect(() => parseSystemOneResponse({ success: true, errors: [{ message: 'secret' }], result: wire() }, questions)).toThrow();
  });
  it('distinguishes unknown costs from real zero and uses model-aware overrides', () => {
    expect(estimateCost(config('http://127.0.0.1'), { input_tokens: 100 })).toBeCloseTo(0.0000042);
    expect(estimateCost(config('http://127.0.0.1'), { input_tokens: 0 })).toBe(0);
    expect(estimateCost(config('http://127.0.0.1'), {})).toBeNull();
    expect(estimateCost(config('http://127.0.0.1', { model: 'clef-flash' }), { input_tokens: 100, output_tokens: 0 })).toBeNull();
    expect(estimateCost(config('http://127.0.0.1', { model: 'clef-flash', pricing: { input_usd_per_million: 2, output_usd_per_million: 4 } }), { input_tokens: 100, output_tokens: 10 })).toBeCloseTo(0.00024);
    expect(estimateCost(config('http://127.0.0.1', { model: 'clef-flash', pricing: { input_usd_per_million: 2 } }), { input_tokens: 100, output_tokens: 10 })).toBeNull();
  });
});

describe('bounded attempts and cancellation', () => {
  it.each([429, 529])('retries %s exactly once', async (status) => {
    let calls = 0;
    const base = await mock((_request, response) => { calls++; response.writeHead(status, { 'retry-after': '0' }); response.end('secret'); });
    await expect(new SystemOneProvider('one', config(base), 1000).decide(state, questions)).rejects.toMatchObject({ code: 'http' });
    expect(calls).toBe(2);
  });
  it('accepts the second attempt after an outage', async () => {
    let calls = 0;
    const base = await mock((_request, response) => { if (++calls === 1) { response.writeHead(429, { 'retry-after': '0' }); response.end(); } else response.end(JSON.stringify(wire())); });
    expect((await new SystemOneProvider('one', config(base), 1000).decide(state, questions)).answers.destructive).toBe(0.1);
    expect(calls).toBe(2);
  });
  it('retries one timed-out attempt and aborts both fetches', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => { signals.push(init.signal as AbortSignal); return Promise.withResolvers<Response>().promise; }));
    const result = new SystemOneProvider('one', config('http://127.0.0.1/v1'), 100).decide(state, questions).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(201);
    expect(await result).toMatchObject({ code: 'timeout' });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('honors retry-after and cancellation during backoff', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '5' } }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const result = new SystemOneProvider('one', config('http://127.0.0.1/v1'), 1000).decide(state, questions, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await result).toMatchObject({ code: 'aborted' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not exceed a whole-decision budget to honor retry-after', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 529, headers: { 'retry-after': '120' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new SystemOneProvider('one', config('http://127.0.0.1/v1'), 1000).decide(state, questions)).rejects.toMatchObject({ code: 'timeout' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(retryAfterMs('Wed, 28 Oct 2026 00:00:05 GMT', Date.parse('2026-10-28T00:00:00Z'))).toBe(5000);
  });
  it('does not retry ordinary HTTP errors or malformed JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new SystemOneProvider('one', config('http://127.0.0.1/v1'), 1000).decide(state, questions)).rejects.toMatchObject({ code: 'http' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response('{secret'));
    await expect(new SystemOneProvider('one', config('http://127.0.0.1/v1'), 1000).decide(state, questions)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('response bounds and Retry-After schedule', () => {
  it('waits the full advertised delay before the sole retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wire())));
    vi.stubGlobal('fetch', fetcher);
    const pending = new SystemOneProvider('one', config('http://127.0.0.1/v1'), 1000).decide(state, questions);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).answers.destructive).toBe(0.1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects an oversized response without reflecting its contents', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('private-key-sentinel'.repeat(100_000)));
    vi.stubGlobal('fetch', fetcher);
    await expect(new SystemOneProvider('one', config('http://127.0.0.1/v1'), 1000).decide(state, questions)).rejects.toMatchObject({ code: 'invalid_response', message: 'Decision provider failed (invalid_response)' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
