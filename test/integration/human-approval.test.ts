import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../../src/approval/broker.js';
import { createApprovalApp } from '../../src/approval/web.js';
import { collectConfigSecrets } from '../../src/audit/record.js';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createMockRelay, startLoopback, type MockProtocol } from './mock-relay.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Every risk lies between the allow and block thresholds: a gray first stage.
const gray = { destructive: 0.4, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 };
const routes = {
  'anthropic-messages': { prefix: '/cc', path: '/cc/v1/messages', scene: { content: [{ type: 'tool_use', id: 'held_tool', name: 'Bash', input: { command: 'npm install inert' } }] } },
  'openai-chat': { prefix: '/workbuddy', path: '/workbuddy/v1/chat/completions', scene: { message: { role: 'assistant', content: null, tool_calls: [{ id: 'held_tool', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm install inert' }) } }] } } },
  'openai-responses': { prefix: '/codex', path: '/codex/v1/responses', scene: { output: [{ type: 'function_call', id: 'fc_held_tool', call_id: 'held_tool', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm install inert' }), status: 'completed' }] } },
} as const;

type ReviewMode = 'uncertain' | 'allow';
async function setup(options: { protocol?: MockProtocol; review?: ReviewMode; timeoutMs?: number } = {}) {
  const protocol = options.protocol ?? 'anthropic-messages';
  const route = routes[protocol];
  const dir = await mkdtemp(join(tmpdir(), 'amp-human-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const auditPath = join(dir, 'audit.jsonl');
  const calls = { decision: 0, review: 0 };
  const trustedApp = new Hono();
  trustedApp.post('/v1/systemone', (c) => {
    calls.decision++;
    return c.json({ answers: Object.fromEntries(Object.entries(gray).map(([id, noul]) => [id, { type: 'noul', noul }])), usage: { input_tokens: 10, output_tokens: 2 } });
  });
  trustedApp.post('/v1/messages', (c) => {
    calls.review++;
    const text = JSON.stringify({ verdict: options.review ?? 'uncertain', reason: 'Reviewer cannot tell private-review-key' });
    return c.json({ id: 'msg_review', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 3 } });
  });
  const trusted = await startLoopback(trustedApp); cleanups.push(trusted.close);
  const relay = createMockRelay({ protocol, scene: route.scene as never });
  const upstream = await startLoopback(relay.app); cleanups.push(upstream.close);
  const config = configSchema.parse({
    auth: { client_tokens: ['private-client-key'] },
    routes: [{ prefix: route.prefix, protocol, upstream: 'relay', project_dirs: ['/project'] }],
    upstreams: { relay: { base_url: upstream.url, api_key: 'private-relay-key' } },
    gate: { on_provider_failure: 'allow', provider_timeout_ms: 500, hold_keepalive_ms: 20 },
    decision: { chain: ['first'], providers: { first: { kind: 'systemone', base_url: trusted.url + '/v1', model: 'fixture-model', api_key: 'private-first-key' } },
      ...(options.review ? { second_stage: { base_url: trusted.url + '/v1', api_key: 'private-review-key', model: 'claude-haiku-5-5' } } : {}) },
    human_approval: { enabled: true, timeout_ms: options.timeoutMs ?? 30_000, token: 'private-approval-key' },
    audit: { path: auditPath }, log_level: 'silent',
  });
  const approvals = new ApprovalBroker({ timeout_ms: config.human_approval.timeout_ms, max_pending: config.human_approval.max_pending });
  cleanups.push(async () => approvals.close());
  const app = createApp(config, { approvals });
  cleanups.push(app.flushAudit);
  const proxy = await startLoopback(app); cleanups.push(proxy.close);
  const web = await startLoopback(createApprovalApp(approvals, config.human_approval)); cleanups.push(web.close);
  const auth = { authorization: 'Bearer private-approval-key' };

  async function request(): Promise<Response> {
    const body = protocol === 'anthropic-messages' ? { model: 'fixture', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Install inert in project' }] }
      : protocol === 'openai-chat' ? { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'Install inert in project' }] }
        : { model: 'fixture', stream: true, input: 'Install inert in project' };
    const response = await fetch(proxy.url + route.path, { method: 'POST', headers: { authorization: 'Bearer private-client-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return response;
  }
  async function pending(): Promise<{ id: string; subject: Record<string, unknown> }[]> {
    const response = await fetch(web.url + '/api/pending', { headers: auth });
    expect(response.status).toBe(200);
    return ((await response.json()) as { pending: { id: string; subject: Record<string, unknown> }[] }).pending;
  }
  async function waitHeld() {
    let items: Awaited<ReturnType<typeof pending>> = [];
    await vi.waitFor(async () => { items = await pending(); expect(items).toHaveLength(1); }, { timeout: 5_000, interval: 20 });
    return items[0]!;
  }
  async function decide(id: string, decision: 'allow' | 'block', headers: Record<string, string> = auth) {
    return fetch(`${web.url}/api/approvals/${id}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
  }
  async function records(): Promise<Record<string, unknown>[]> {
    await app.flushAudit();
    const text = await readFile(auditPath, 'utf8');
    for (const key of collectConfigSecrets(config)) expect(text).not.toContain(key);
    return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  }
  return { request, pending, waitHeld, decide, records, calls, approvals };
}

/** True when the client stream carries an execution item for its protocol. */
function hasExecution(protocol: MockProtocol, text: string): boolean {
  const events = text.split('\n').filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]').map(line => JSON.parse(line.slice(5)) as Record<string, unknown>);
  return events.some((event) => {
    if (protocol === 'anthropic-messages') return event.type === 'content_block_start' && (event.content_block as { type?: string } | undefined)?.type === 'tool_use';
    if (protocol === 'openai-chat') return Array.isArray(event.choices) && event.choices.some((choice: { delta?: { tool_calls?: unknown } }) => choice.delta?.tool_calls !== undefined);
    return event.type === 'response.output_item.added' && (event.item as { type?: string } | undefined)?.type === 'function_call';
  });
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setTimeout(resolve, ms));
  return done;
}

describe('end-to-end human approval over real HTTP listeners', () => {
  for (const protocol of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const) {
    it.each(['allow', 'block'] as const)(`${protocol}: gray first stage without reviewer is held, then human %s decides the stream`, async decision => {
      const fixture = await setup({ protocol });
      const response = await fixture.request();
      const body = response.text();
      const held = await fixture.waitHeld();
      expect(held.subject).toMatchObject({ escalation: 'gray-no-reviewer', probabilities: gray });
      expect(JSON.stringify(held.subject)).toContain('npm install inert');
      // Still held: no decision yet, so the client body has not completed.
      expect(await settledWithin(body, 100)).toBe(false);
      // Unauthenticated decisions are refused and leave the action pending.
      expect((await fixture.decide(held.id, 'allow', {})).status).toBe(401);
      expect(await fixture.pending()).toHaveLength(1);
      const decided = await fixture.decide(held.id, decision);
      expect(decided.status).toBe(200);
      expect(await decided.json()).toEqual({ ok: true });
      // A second decision on the settled id is not accepted.
      expect((await fixture.decide(held.id, decision)).status).toBe(404);
      const text = await body;
      expect(hasExecution(protocol, text)).toBe(decision === 'allow');
      if (decision === 'block') expect(text).toContain('a human reviewer denied this action');
      expect(text).not.toContain('private-');
      const [record] = await fixture.records();
      expect(record).toMatchObject({ verdict: decision, raw_outcome: 'uncertain', rule: decision === 'allow' ? 'human-approved' : 'human-denied', cache_hit: false,
        stages: [{ stage: 'decision', provider: 'first' }, { stage: 'human', provider: 'human', input_tokens: 0, output_tokens: 0, cost_usd: 0 }] });
      expect(fixture.calls).toEqual({ decision: 1, review: 0 });
      expect(await fixture.pending()).toHaveLength(0);
    });
  }

  it('escalates an uncertain reviewer to a human and never caches the human approval', async () => {
    const fixture = await setup({ review: 'uncertain' });
    for (let turn = 0; turn < 2; turn++) {
      const body = (await fixture.request()).text();
      const held = await fixture.waitHeld();
      expect(held.subject).toMatchObject({ escalation: 'reviewer-uncertain', probabilities: gray });
      expect(String(held.subject.reviewer_reason)).toContain('Reviewer cannot tell');
      expect(JSON.stringify(held.subject)).not.toContain('private-review-key');
      expect((await fixture.decide(held.id, 'allow')).status).toBe(200);
      expect(hasExecution('anthropic-messages', await body)).toBe(true);
    }
    const records = await fixture.records();
    expect(records).toHaveLength(2);
    for (const record of records) expect(record).toMatchObject({ verdict: 'allow', rule: 'human-approved', raw_outcome: 'uncertain', cache_hit: false,
      stages: [{ stage: 'decision' }, { stage: 'review', provider: 'second_stage' }, { stage: 'human', provider: 'human' }] });
    // Both turns consulted the first stage, reviewer and the human again.
    expect(fixture.calls).toEqual({ decision: 2, review: 2 });
  });

  it('keeps a decisive reviewer final without asking a human', async () => {
    const fixture = await setup({ review: 'allow' });
    const subscriber = vi.fn();
    fixture.approvals.subscribe(subscriber);
    expect(hasExecution('anthropic-messages', await (await fixture.request()).text())).toBe(true);
    expect(subscriber).not.toHaveBeenCalled();
    expect((await fixture.records())[0]).toMatchObject({ verdict: 'allow', rule: 'llm-review', stages: [{ stage: 'decision' }, { stage: 'review' }] });
  });

  it('blocks when the human does not answer before timeout_ms', async () => {
    const fixture = await setup({ timeoutMs: 300 });
    const text = await (await fixture.request()).text();
    expect(hasExecution('anthropic-messages', text)).toBe(false);
    expect(text).toContain('human approval timed out');
    expect((await fixture.records())[0]).toMatchObject({ verdict: 'block', rule: 'human-timeout', cache_hit: false });
    expect(await fixture.pending()).toHaveLength(0);
  });
});
