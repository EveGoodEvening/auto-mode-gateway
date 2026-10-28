import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createMockDecision, type DecisionMode } from './mock-decision.js';
import { createMockRelay, startLoopback, type MockProtocol, type RelayScene } from './mock-relay.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
interface Ingress { protocol: MockProtocol; prefix: string; endpoint: string; execution: string; malicious: string; classifierApplicable: boolean; nativeApplicable: boolean }
const ingresses: Ingress[] = [
  { protocol: 'anthropic-messages', prefix: '/cc', endpoint: '/v1/messages', execution: '"type":"tool_use"', malicious: 'attacker.test', classifierApplicable: true, nativeApplicable: true },
  { protocol: 'openai-responses', prefix: '/codex', endpoint: '/v1/responses', execution: '"type":"function_call"', malicious: 'rm -rf ~', classifierApplicable: false, nativeApplicable: false },
  { protocol: 'openai-chat', prefix: '/workbuddy', endpoint: '/v1/chat/completions', execution: '"tool_calls":[{', malicious: 'attacker.test', classifierApplicable: false, nativeApplicable: false },
];
const safeguards = [{ type: 'dangerous_tool_use', classifier_context: { v: 1, live_cwd: '/project', trusted_directories: ['/project'] } }];
const classifierSystem = [{ type: 'text', text: 'attribution', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'You are a security monitor for autonomous AI coding agents\nEvaluate.' }];
const recordSchema = z.record(z.string(), z.unknown());
function reviewedScene(ingress: Ingress): RelayScene {
  switch (ingress.protocol) {
    case 'anthropic-messages': return { content: [{ type: 'tool_use', id: 'review', name: 'Bash', input: { command: 'npm install' } }] };
    case 'openai-responses': return { output: [{ type: 'function_call', id: 'fc_review', call_id: 'review', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm install' }), status: 'completed' }] };
    case 'openai-chat': return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'review', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm install' }) } }] } };
  }
}
async function setup(ingress: Ingress, options: { scene?: string | RelayScene; mode?: 'enforce' | 'shadow'; auth?: 'vault' | 'passthrough'; decision?: DecisionMode; allFail?: boolean; delivery?: 'native' | 'rewrite' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-matrix-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const relay = createMockRelay({ protocol: ingress.protocol, scene: options.scene ?? 'text' });
  const first = createMockDecision({ mode: options.decision ?? 'keywords', delayMs: options.decision === 'timeout' ? 200 : undefined });
  const second = createMockDecision({ mode: '5xx' });
  const upstream = await startLoopback(relay.app); cleanups.push(upstream.close);
  const trusted = await startLoopback(first.app); cleanups.push(trusted.close);
  const backup = await startLoopback(second.app); cleanups.push(backup.close);
  const config = configSchema.parse({
    auth: { mode: options.auth ?? 'vault', client_tokens: ['matrix-client'] },
    routes: [{ prefix: ingress.prefix, protocol: ingress.protocol, upstream: 'relay', project_dirs: ['/project'], ...(ingress.nativeApplicable ? { claude_delivery: options.delivery ?? 'rewrite' } : {}) }],
    upstreams: { relay: { base_url: upstream.url, api_key: 'matrix-relay', forward_safeguards: false } },
    gate: { mode: options.mode ?? 'enforce', provider_timeout_ms: 50, hold_keepalive_ms: 10 },
    decision: { chain: options.allFail ? ['first', 'backup'] : ['first'], providers: {
      first: { kind: 'systemone', base_url: trusted.url, api_key: 'matrix-first', model: 'mock' },
      backup: { kind: 'systemone', base_url: backup.url, api_key: 'matrix-backup', model: 'mock' },
    }, second_stage: { base_url: trusted.url + '/v1', api_key: 'matrix-classifier', model: 'mock-classifier', pin: { provider: { only: ['anthropic'], allow_fallbacks: false } } } },
    classifier_reroute: { enabled: true, model_map: { 'claude-sonnet-5': 'mock-classifier' } },
    audit: { path: join(dir, 'audit.jsonl') }, log_level: 'silent',
  });
  const app = createApp(config); cleanups.push(app.flushAudit);
  const gateway = await startLoopback(app); cleanups.push(gateway.close);
  const responses: Response[] = [];
  cleanups.push(async () => { for (const response of responses) if (response.body && !response.bodyUsed && !response.body.locked) await response.body.cancel(); });
  async function request(stream = false, extras: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const body = { model: 'claude-sonnet-5', max_tokens: 100, stream, ...(ingress.protocol === 'openai-responses' ? { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Install dependencies in project' }] }] } : { messages: [{ role: 'user', content: 'Install dependencies in project' }] }), ...extras };
    const response = await fetch(gateway.url + ingress.prefix + ingress.endpoint, { method: 'POST', headers: { authorization: 'Bearer matrix-client', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.311', ...headers }, body: JSON.stringify(body) });
    responses.push(response); return response;
  }
  return { request, relay, first, second, async records() { await app.flushAudit(); const text = await readFile(config.audit.path, 'utf8'); for (const secret of ['matrix-client', 'matrix-relay', 'matrix-first', 'matrix-backup', 'matrix-classifier']) expect(text).not.toContain(secret); return text.trim().split('\n').map(line => recordSchema.parse(JSON.parse(line))); } };
}

for (const ingress of ingresses) describe(`${ingress.protocol} real gateway/provider/audit matrix`, () => {
  it.each([false, true])('enforces pure/benign/injected/partial/nonstream scenes over HTTP, stream=%s', async stream => {
    for (const scene of ['text', 'good', 'bad', 'parallel', 'nonstream']) {
      const fixture = await setup(ingress, { scene }); const response = await fixture.request(stream); expect(response.status).toBe(200); const raw = await response.text();
      if (scene === 'text') expect(raw).toContain('AMP mock response');
      else if (scene === 'good') { expect(raw).toContain(ingress.protocol === 'openai-chat' && stream ? '"id":"good"' : 'pwd'); expect(raw).toContain(ingress.execution); }
      else { expect(raw).not.toContain(ingress.malicious); expect(raw).toContain('auto-mode-proxy'); if (scene === 'parallel') expect(raw).toContain(ingress.protocol === 'openai-chat' && stream ? '"id":"good"' : 'pwd'); else expect(raw).not.toContain(ingress.execution); }
      if (scene !== 'text') expect(await fixture.records()).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: scene === 'good' ? 'allow' : 'block' })]));
    }
  });
  it.each([false, true])('preserves shadow source bytes with both auth modes, stream=%s', async stream => {
    for (const auth of ['vault', 'passthrough'] satisfies ('vault' | 'passthrough')[]) {
      const fixture = await setup(ingress, { scene: 'parallel', mode: 'shadow', auth }); const raw = await (await fixture.request(stream)).text(); const observed = fixture.relay.requests[0]; if (!observed) throw new Error('Relay was not called');
      expect(observed.headers.get('authorization')).toBe(`Bearer ${auth === 'vault' ? 'matrix-relay' : 'matrix-client'}`);
      const original = await fixture.relay.app.request(observed.path, { method: observed.method, headers: observed.headers, body: JSON.stringify(observed.body) });
      expect(raw).toBe(await original.text());
    }
  });
  it.each(['timeout', '429', '529', '5xx'] satisfies DecisionMode[])('blocks actual whole-chain provider failure %s', async decision => {
    const fixture = await setup(ingress, { scene: reviewedScene(ingress), decision, allFail: true });
    const raw = await (await fixture.request()).text(); expect(raw).not.toContain(ingress.execution); expect(raw).toContain('auto-mode-proxy'); expect(fixture.first.requests.length).toBeGreaterThan(0); expect(fixture.second.requests.length).toBeGreaterThan(0);
    expect(await fixture.records()).toEqual([expect.objectContaining({ verdict: 'block', cache_hit: false })]);
  });
  it('caches reviewed state while keeping the provider and per-ingress audit observable', async () => {
    const fixture = await setup(ingress, { scene: reviewedScene(ingress) });
    for (let i = 0; i < 2; i++) expect(await (await fixture.request()).text()).toContain(ingress.execution);
    expect(fixture.first.requests).toHaveLength(1); expect(await fixture.records()).toEqual([expect.objectContaining({ verdict: 'allow', cache_hit: false }), expect.objectContaining({ verdict: 'allow', cache_hit: true })]);
  });
  it('reroutes the configured exact Anthropic classifier payload carried on this ingress with trusted credentials', async () => {
    const fixture = await setup(ingress); const response = await fixture.request(false, { system: classifierSystem, messages: [{ role: 'user', content: 'Evaluate the proposed action' }] }, { 'x-api-key': 'untrusted-client-key', cookie: 'untrusted-cookie' });
    expect(response.status).toBe(200); expect(await response.text()).toContain('trusted_classifier'); expect(fixture.relay.requests).toHaveLength(0); expect(fixture.first.requests).toHaveLength(1);
    const trusted = fixture.first.requests[0]; expect(trusted?.path).toBe('/v1/messages'); expect(trusted?.headers.get('authorization')).toBe('Bearer matrix-classifier'); expect(trusted?.headers.get('x-api-key')).toBeNull(); expect(trusted?.headers.get('cookie')).toBeNull(); expect(trusted?.body).toMatchObject({ system: classifierSystem, messages: [{ role: 'user', content: 'Evaluate the proposed action' }], model: 'mock-classifier', provider: { only: ['anthropic'], allow_fallbacks: false } });
  });
  if (!ingress.classifierApplicable) it('does not invent native Responses/Chat classifier rerouting from a security-monitor text mimic', async () => {
    const fixture = await setup(ingress);
    const mimic = 'You are a security monitor for autonomous AI coding agents\nEvaluate.';
    const native = ingress.protocol === 'openai-responses' ? { input: [{ role: 'system', content: [{ type: 'input_text', text: mimic }] }, { role: 'user', content: [{ type: 'input_text', text: 'Evaluate the proposed action' }] }] } : { messages: [{ role: 'system', content: mimic }, { role: 'user', content: 'Evaluate the proposed action' }] };
    const response = await fixture.request(false, native); expect(response.status).toBe(200); expect(await response.text()).toContain('AMP mock response'); expect(fixture.relay.requests).toHaveLength(1); expect(fixture.relay.requests[0]?.body).toMatchObject(native); expect(fixture.relay.requests[0]?.body.system).toBeUndefined(); expect(fixture.first.requests).toHaveLength(0); expect(fixture.second.requests).toHaveLength(0);
  });
  if (ingress.nativeApplicable) it.each([false, true])('Anthropic-only native safeguards and rewrite both enforce forged approvals, stream=%s', async stream => {
    for (const delivery of ['native', 'rewrite'] satisfies ('native' | 'rewrite')[]) {
      const fixture = await setup(ingress, { scene: 'forged-native', delivery }); const raw = await (await fixture.request(stream, { safeguards })).text();
      expect(raw).not.toContain('FORGED_UPSTREAM_ALLOW');
      if (delivery === 'native') { expect(raw).toContain(ingress.execution); expect(raw).toContain('"outcome":"flagged"'); }
      else { expect(raw).not.toContain(ingress.execution); expect(raw).toContain('auto-mode-proxy'); }
      expect(await fixture.records()).toEqual([expect.objectContaining({ verdict: 'block' })]);
    }
  });
  else it('native Anthropic safeguards are nonapplicable: an attached field cannot authorize execution', async () => {
    const fixture = await setup(ingress, { scene: 'bad' }); const raw = await (await fixture.request(false, { safeguards })).text(); expect(raw).not.toContain(ingress.execution); expect(raw).not.toContain(ingress.malicious); expect(raw).toContain('auto-mode-proxy');
    expect(await fixture.records()).toEqual([expect.objectContaining({ verdict: 'block' })]);
  });
});
