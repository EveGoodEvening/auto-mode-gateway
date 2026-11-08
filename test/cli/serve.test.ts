import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, type ApprovalSubject } from '../../src/approval/broker.js';
import { runServer } from '../../src/cli/serve.js';
import { configSchema } from '../../src/config/schema.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const subject: ApprovalSubject = { tool: 'Bash', kind: 'command', text: 'npm install inert', paths: [], escalation: 'gray-no-reviewer' };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** One-shot probe without keep-alive pooling, so shutdown is not held by an idle socket. */
function probe(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const APPROVAL_TOKEN = 'private-approval-token-value';
const AUTH = { authorization: `Bearer ${APPROVAL_TOKEN}` };

async function config(listenPort: number, approvalPort: number, approval: Record<string, unknown> = { token: APPROVAL_TOKEN }) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-serve-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return configSchema.parse({
    listen: { host: '127.0.0.1', port: listenPort },
    routes: [{ prefix: '/', protocol: 'anthropic-messages', upstream: 'relay' }],
    upstreams: { relay: { base_url: 'http://127.0.0.1:9', api_key: 'private-relay-key' } },
    decision: { chain: ['first'], providers: { first: { kind: 'systemone', base_url: 'http://127.0.0.1:9/v1', model: 'inert', api_key: 'private-first-key' } } },
    human_approval: { enabled: true, host: '127.0.0.1', port: approvalPort, timeout_ms: 60_000, ...approval },
    audit: { path: join(dir, 'audit.jsonl') }, log_level: 'silent',
  });
}

describe('runServer with human approval', () => {
  it('serves the shared broker on the approval listener and settles pending requests on shutdown', async () => {
    const [listenPort, approvalPort] = [await freePort(), await freePort()];
    const approvals = new ApprovalBroker({ timeout_ms: 60_000, max_pending: 10 });
    cleanups.push(async () => approvals.close());
    const stop = new AbortController();
    const running = runServer(await config(listenPort, approvalPort), { signal: stop.signal, approvals });
    let failed: unknown;
    running.catch((error: unknown) => { failed = error; });
    cleanups.push(async () => { stop.abort(); await running.catch(() => undefined); });

    await vi.waitFor(async () => expect((await probe(approvalPort, '/', { host: `127.0.0.1:${approvalPort}` })).status).toBe(200), { timeout: 5_000, interval: 20 });
    await vi.waitFor(async () => expect((await probe(listenPort, '/_amp/status')).status).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });

    const pending = approvals.request(subject);
    expect((await probe(approvalPort, '/api/pending', { host: `127.0.0.1:${approvalPort}` })).status).toBe(401);
    const listed = await probe(approvalPort, '/api/pending', { host: `127.0.0.1:${approvalPort}`, ...AUTH });
    expect(listed.status).toBe(200);
    expect((JSON.parse(listed.body) as { pending: { subject: ApprovalSubject }[] }).pending.map(item => item.subject)).toEqual([subject]);

    stop.abort();
    // Shutdown closes the broker first: the pending request blocks instead of waiting out its timeout.
    expect(await pending).toEqual({ status: 'aborted' });
    await expect(running).resolves.toBeUndefined();
    expect(failed).toBeUndefined();
    await expect(probe(approvalPort, '/', { host: `127.0.0.1:${approvalPort}` })).rejects.toThrow();
    await expect(probe(listenPort, '/_amp/status')).rejects.toThrow();
    // After shutdown no human can answer; later requests are rejected immediately.
    expect(await approvals.request(subject)).toEqual({ status: 'rejected' });
  });

  it('fails startup when the approval port is already in use', async () => {
    const [listenPort, approvalPort] = [await freePort(), await freePort()];
    const occupied: Server = createServer();
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(approvalPort, '127.0.0.1', resolve); });
    cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
    const approvals = new ApprovalBroker({ timeout_ms: 60_000, max_pending: 10 });
    cleanups.push(async () => approvals.close());

    await expect(runServer(await config(listenPort, approvalPort), { approvals })).rejects.toThrow('Unable to serve configured approval listener');
    // Nobody could answer, so the shared broker is closed rather than queueing until timeout.
    expect(await approvals.request(subject)).toEqual({ status: 'rejected' });
    await vi.waitFor(() => expect(probe(listenPort, '/_amp/status')).rejects.toThrow(), { timeout: 5_000, interval: 20 });
  });
  /** Runs until both listeners answer, then shuts down; returns the captured log lines. */
  async function startupLogs(approval: Record<string, unknown>): Promise<string> {
    const [listenPort, approvalPort] = [await freePort(), await freePort()];
    const settings = await config(listenPort, approvalPort, approval);
    settings.log_level = 'info';
    const lines: string[] = [];
    const stop = new AbortController();
    const running = runServer(settings, { signal: stop.signal, logDestination: { write: (line: string) => { lines.push(line); } } });
    cleanups.push(async () => { stop.abort(); await running.catch(() => undefined); });
    await vi.waitFor(() => expect(lines.join('')).toContain('Approval UI listening'), { timeout: 5_000, interval: 20 });
    await vi.waitFor(() => expect(lines.join('')).toContain('Server listening'), { timeout: 5_000, interval: 20 });
    stop.abort();
    await running;
    const text = lines.join('');
    const listening = lines.map(line => JSON.parse(line) as { msg: string; url?: string }).find(line => line.msg === 'Approval UI listening');
    expect(listening?.url).toBe(`http://127.0.0.1:${approvalPort}/`);
    return text;
  }

  it('logs the approval URL without the token and no tokenless warning when a token is set', async () => {
    const text = await startupLogs({ token: APPROVAL_TOKEN });
    expect(text).not.toContain(APPROVAL_TOKEN);
    expect(text).not.toContain('#token');
    expect(text).not.toContain('any local process');
  });

  it('warns when running tokenless with require_token: false', async () => {
    const text = await startupLogs({ require_token: false });
    expect(text).toContain('any local process, including gated agents, can approve');
    expect(text).not.toContain(APPROVAL_TOKEN);
  });
});
