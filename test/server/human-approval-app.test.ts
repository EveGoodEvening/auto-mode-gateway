import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalBroker } from '../../src/approval/broker.js';
import { createApprovalApp } from '../../src/approval/web.js';
import { configSchema, type Config } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { anthropicAdapter } from '../../src/protocols/anthropic/adapter.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

/** A gray first stage: every risk sits between the allow and block thresholds. */
async function grayProvider() {
  return mockServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { questions: Record<string, unknown> };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.5 }])) }));
    });
  });
}

async function relay() {
  return mockServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'message', content: [{ type: 'tool_use', id: 'gray-call', name: 'Bash', input: { command: 'npm install inert' } }], stop_reason: 'tool_use' }));
  });
}

function config(base: string, provider: string, overrides: Record<string, unknown> = {}): Config {
  const auditPath = join(tmpdir(), `amp-human-audit-${randomUUID()}.jsonl`);
  cleanups.push(() => rm(auditPath, { force: true }));
  return configSchema.parse({
    auth: { mode: 'vault', client_tokens: ['disposable-client'], admin_token: 'disposable-admin' },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock' }],
    upstreams: { mock: { base_url: base, api_key: 'disposable-upstream', auth_header: 'both' } },
    decision: {
      chain: ['mock'],
      providers: { mock: { kind: 'systemone', base_url: provider, api_key: 'disposable-provider', model: 'mock' } },
    },
    log_level: 'silent',
    audit: { path: auditPath },
    human_approval: { enabled: true, timeout_ms: 30_000 },
    ...overrides,
  });
}

function send(app: ReturnType<typeof createApp>) {
  return app.request('/cc/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer disposable-client' },
    body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'Install inert package' }] }),
  });
}

describe('createApp with a shared approval broker', () => {
  it.each(['allow', 'block'] as const)('holds a gray action for the web UI to %s', async (decision) => {
    const settings = config(await relay(), await grayProvider());
    const approvals = new ApprovalBroker({ timeout_ms: settings.human_approval.timeout_ms, max_pending: settings.human_approval.max_pending });
    cleanups.push(async () => approvals.close());
    const app = createApp(settings, { approvals });
    const web = createApprovalApp(approvals, settings.human_approval);
    const pending = send(app);
    await vi.waitFor(() => expect(approvals.size).toBe(1), { timeout: 5_000 });
    const listed = await (await web.request('/api/pending', { headers: { host: '127.0.0.1:8485' } })).json() as { pending: { id: string; subject: { tool: string } }[] };
    expect(listed.pending[0]!.subject.tool).toBe('Bash');
    const decided = await web.request(`/api/approvals/${listed.pending[0]!.id}`, {
      method: 'POST', headers: { host: '127.0.0.1:8485', 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
    });
    expect(decided.status).toBe(200);
    const response = await pending;
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    if (decision === 'allow') expect(body).toContain('"tool_use"');
    else {
      expect(body).not.toContain('"tool_use"');
      expect(body).toContain('[auto-mode-proxy]');
    }
    await app.flushAudit();
  });

  it('keeps gray-block without an injected broker', async () => {
    const settings = config(await relay(), await grayProvider());
    const app = createApp(settings);
    const response = await send(app);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('"tool_use"');
    expect(body).toContain('gray-block');
    await app.flushAudit();
  });

  it('never asks a human in shadow mode', async () => {
    const settings = config(await relay(), await grayProvider(), { gate: { mode: 'shadow' } });
    const approvals = new ApprovalBroker({ timeout_ms: 30_000, max_pending: 10 });
    cleanups.push(async () => approvals.close());
    const request = vi.spyOn(approvals, 'request');
    const app = createApp(settings, { approvals });
    const response = await send(app);
    expect(JSON.stringify(await response.json())).toContain('"tool_use"');
    await app.flushAudit();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['enforce with broker', 'enforce', true, 90_000],
    ['enforce without broker', 'enforce', false, 60_000],
    ['shadow with broker', 'shadow', true, 60_000],
  ] as const)('passes the whole-turn decision deadline (%s)', async (_name, mode, withBroker, expected) => {
    const settings = config(await relay(), await grayProvider(), { gate: { mode }, human_approval: { enabled: true, timeout_ms: 30_000 } });
    const approvals = withBroker ? new ApprovalBroker({ timeout_ms: 30_000, max_pending: 10 }) : undefined;
    // Answer immediately so the held turn completes in either mode.
    if (approvals) {
      cleanups.push(async () => approvals.close());
      approvals.subscribe(() => { for (const item of approvals.list()) approvals.decide(item.id, 'block'); });
    }
    const spy = vi.spyOn(anthropicAdapter, 'transformResponse');
    const app = createApp(settings, { approvals });
    await (await send(app)).arrayBuffer();
    await app.flushAudit();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![2].decisionTimeoutMs).toBe(expected);
  });
});
