import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createMockRelay, startLoopback } from './mock-relay.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const scores = { destructive: 0.4, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 };
type ReviewMode = 'allow' | 'block' | 'invalid' | 'ambiguous' | 'unavailable' | 'format-fallback';
async function setup(options: { kind?: 'systemone' | 'openai-decisions'; mode?: ReviewMode; failure?: 'allow' | 'block'; unknownPricing?: boolean; decisionRetry?: boolean; command?: string; probabilities?: typeof scores } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-review-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const auditPath = join(dir, 'audit.jsonl');
  const calls = { decision: 0, review: 0 };
  const trustedApp = new Hono();
  trustedApp.post('/v1/systemone', (c) => {
    calls.decision++;
    if (options.decisionRetry && calls.decision === 1) return c.json({ error: 'unreported attempt' }, 429, { 'retry-after': '0' });
    return c.json({ answers: Object.fromEntries(Object.entries(options.probabilities ?? scores).map(([id, noul]) => [id, { type: 'noul', noul }])), usage: { input_tokens: 10, output_tokens: 2 } });
  });
  trustedApp.post('/v1/decisions', (c) => {
    calls.decision++;
    if (options.decisionRetry && calls.decision === 1) return c.json({ error: 'unreported attempt' }, 429, { 'retry-after': '0' });
    return c.json({ answers: Object.entries(options.probabilities ?? scores).map(([name, probability]) => ({ type: 'predicate', name, probability })), usage: { input_tokens: 10, output_tokens: 2 } });
  });
  trustedApp.post('/v1/messages', async (c) => {
    calls.review++;
    if (options.mode === 'unavailable') return c.json({ error: { message: 'private-review-key' } }, 503);
    const body: unknown = await c.req.json();
    if (options.mode === 'format-fallback' && body && typeof body === 'object' && 'output_config' in body) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format is not supported' } }, 400);
    }
    const text = options.mode === 'invalid' ? 'not json private-review-key'
      : options.mode === 'ambiguous' ? '{"verdict":"allow","verdict":"block","reason":"ambiguous"}'
        : JSON.stringify({ verdict: options.mode === 'block' ? 'block' : 'allow', reason: 'Final safety decision private-review-key' });
    return c.json({ id: 'msg_review', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 3 } });
  });
  const trusted = await startLoopback(trustedApp); cleanups.push(trusted.close);
  const command = options.command ?? 'npm install inert';
  const relay = createMockRelay({ scene: { content: [{ type: 'tool_use', id: 'reviewed_tool', name: 'Bash', input: { command } }] } });
  const upstream = await startLoopback(relay.app); cleanups.push(upstream.close);
  const kind = options.kind ?? 'systemone';
  const config = configSchema.parse({
    auth: { client_tokens: ['private-client-key'] },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay', project_dirs: ['/project'] }],
    upstreams: { relay: { base_url: upstream.url, api_key: 'private-relay-key' } },
    gate: { on_provider_failure: options.failure ?? 'block', provider_timeout_ms: 500 },
    decision: { chain: ['first'], providers: { first: { kind, base_url: trusted.url + '/v1', model: 'fixture-model', api_key: 'private-first-key', pricing: { input_usd_per_million: 1, output_usd_per_million: 2 } } },
      second_stage: { base_url: trusted.url + '/v1', api_key: 'private-review-key', model: 'claude-haiku-5-5', ...(options.unknownPricing ? {} : { pricing: { input_usd_per_million: 3, output_usd_per_million: 4 } }) } },
    audit: { path: auditPath }, log_level: 'silent',
  });
  const app = createApp(config);
  cleanups.push(app.flushAudit);
  const proxy = await startLoopback(app); cleanups.push(proxy.close);
  async function request(stream = false) {
    const response = await fetch(proxy.url + '/cc/v1/messages', { method: 'POST', headers: { authorization: 'Bearer private-client-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', max_tokens: 100, stream, messages: [{ role: 'user', content: 'Install inert in project' }] }) });
    expect(response.status).toBe(200);
    return response.text();
  }
  async function records(): Promise<Record<string, unknown>[]> {
    await app.flushAudit();
    const text = await readFile(auditPath, 'utf8');
    for (const key of ['private-client-key', 'private-relay-key', 'private-first-key', 'private-review-key']) expect(text).not.toContain(key);
    return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  }
  return { request, records, calls };
}

function hasExecution(text: string, stream: boolean): boolean {
  if (!stream) {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && 'content' in value && Array.isArray(value.content)
      && value.content.some((block: unknown) => block !== null && typeof block === 'object' && 'type' in block && block.type === 'tool_use');
  }
  return text.split('\n').filter(line => line.startsWith('data:')).some(line => {
    const event = JSON.parse(line.slice(5)) as { type: string; content_block?: { type: string } };
    return event.type === 'content_block_start' && event.content_block?.type === 'tool_use';
  });
}

describe('real HTTP gray-area decisions and reviewer transitions', () => {
  it.each(['systemone', 'openai-decisions'] as const)('uses %s first stage and accounts both stages on allow/block in stream and nonstream', async kind => {
    for (const mode of ['allow', 'block'] as const) for (const stream of [false, true]) {
      const fixture = await setup({ kind, mode });
      const text = await fixture.request(stream);
      expect(hasExecution(text, stream)).toBe(mode === 'allow');
      if (mode === 'block') expect(text).toContain('auto-mode-proxy');
      const [record] = await fixture.records();
      expect(record).toMatchObject({ verdict: mode, raw_outcome: 'uncertain', provider: 'first', input_tokens: 30, output_tokens: 5,
        probabilities: scores, stages: [
          { stage: 'decision', provider: 'first', input_tokens: 10, output_tokens: 2, latency_ms: expect.any(Number) },
          { stage: 'review', provider: 'second_stage', input_tokens: 20, output_tokens: 3, latency_ms: expect.any(Number) },
        ] });
      expect(record?.cost_usd).toBeCloseTo(0.000086);
      expect(fixture.calls).toEqual({ decision: 1, review: 1 });
    }
  });
  it.each(['allow', 'block'] as const)('uses configured %s on reviewer unavailability without caching the failure', async failure => {
    const fixture = await setup({ failure, mode: 'unavailable' });
    for (let i = 0; i < 2; i++) expect(hasExecution(await fixture.request(), false)).toBe(failure === 'allow');
    const records = await fixture.records();
    expect(records).toHaveLength(2);
    for (const record of records) expect(record).toMatchObject({ verdict: failure, raw_outcome: 'uncertain', provider: 'first', cost_usd: null, cache_hit: false, stages: [
      { stage: 'decision', input_tokens: 10 }, { stage: 'review', cost_usd: null, input_tokens: null, output_tokens: null },
    ] });
    expect(fixture.calls.decision).toBe(2);
    expect(fixture.calls.review).toBeGreaterThanOrEqual(2);
  });
  it.each(['invalid', 'ambiguous'] as const)('blocks %s reviewer JSON even under failure allow, without caching malformed evidence', async mode => {
    const fixture = await setup({ failure: 'allow', mode });
    for (let i = 0; i < 2; i++) expect(hasExecution(await fixture.request(), false)).toBe(false);
    const records = await fixture.records();
    for (const record of records) expect(record).toMatchObject({ verdict: 'block', raw_outcome: 'uncertain', cache_hit: false });
    expect(fixture.calls).toEqual({ decision: 2, review: 2 });
  });
  it('reuses a completed reviewer allow without charging historical stages again', async () => {
    const fixture = await setup();
    expect(hasExecution(await fixture.request(), false)).toBe(true);
    expect(hasExecution(await fixture.request(), false)).toBe(true);
    expect((await fixture.records())[1]).toMatchObject({ verdict: 'allow', raw_outcome: 'uncertain', cache_hit: true, cost_usd: 0, input_tokens: 0, output_tokens: 0, stages: [] });
    expect(fixture.calls).toEqual({ decision: 1, review: 1 });
  });
  it('keeps unknown reviewer prices unknown rather than free', async () => {
    const fixture = await setup({ unknownPricing: true });
    expect(hasExecution(await fixture.request(), false)).toBe(true);
    expect((await fixture.records())[0]).toMatchObject({ cost_usd: null, stages: [{ cost_usd: expect.any(Number) }, { cost_usd: null }] });
  });
  it.each(['systemone', 'openai-decisions'] as const)('keeps %s retried-request totals unknown while retaining final-response and reviewer accounting', async kind => {
    const fixture = await setup({ kind, decisionRetry: true });
    expect(hasExecution(await fixture.request(), false)).toBe(true);
    const [record] = await fixture.records();
    expect(record).toMatchObject({ verdict: 'allow', raw_outcome: 'uncertain', input_tokens: null, output_tokens: null, cost_usd: null, stages: [
      { stage: 'decision', provider: 'first', input_tokens: null, output_tokens: null, cost_usd: null,
        final_response: { input_tokens: 10, output_tokens: 2, cost_usd: expect.any(Number) } },
      { stage: 'review', provider: 'second_stage', input_tokens: 20, output_tokens: 3, cost_usd: expect.any(Number) },
    ] });
    expect(fixture.calls).toEqual({ decision: 2, review: 1 });
  });
  it('falls back only from rejected structured formatting and still enforces the final verdict', async () => {
    const fixture = await setup({ mode: 'format-fallback' });
    expect(hasExecution(await fixture.request(), false)).toBe(true);
    expect(fixture.calls).toEqual({ decision: 1, review: 2 });
    // The rejected billed component has no reported usage; total cannot be invented.
    expect((await fixture.records())[0]).toMatchObject({ cost_usd: null, input_tokens: null, output_tokens: null, stages: [
      { stage: 'decision', input_tokens: 10, output_tokens: 2, cost_usd: expect.any(Number) },
      { stage: 'review', input_tokens: null, output_tokens: null, cost_usd: null,
        final_response: { input_tokens: 20, output_tokens: 3, cost_usd: expect.any(Number) } },
    ] });
  });
  it.each(['rm -rf /', 'npm install inert'] as const)('never lets a reviewer override earlier fail-closed boundaries for %s', async command => {
    const fixture = await setup({ command, failure: 'allow', probabilities: { ...scores, destructive: 0.9 } });
    expect(hasExecution(await fixture.request(), false)).toBe(false);
    expect(fixture.calls.review).toBe(0);
    expect(fixture.calls.decision).toBe(command === 'rm -rf /' ? 0 : 1);
  });
});
