import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectConfigSecrets } from '../../src/audit/record.js';
import { readAuditTail } from '../../src/cli/audit.js';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createMockRelay, startLoopback } from './mock-relay.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amp-audit-hints-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const relay = createMockRelay({ scene: { content: [{ type: 'tool_use', id: 'hint-tool', name: 'Bash', input: { command: 'pwd' } }] } });
  const upstream = await startLoopback(relay.app); cleanups.push(upstream.close);
  const credential = 'Opaque"HintCredential\\Q7zN4pR8vB6wY2mF9';
  const config = configSchema.parse({
    auth: { client_tokens: ['inert-client-auth'] },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay', project_dirs: ['/project'], claude_delivery_by_version: { '2.1.311': 'rewrite' } }],
    upstreams: { relay: { base_url: upstream.url, extra_headers: { 'x-private-configured': credential } } },
    decision: { chain: ['one'], providers: { one: { kind: 'systemone', base_url: 'http://127.0.0.1:1', api_key: 'inert-provider-auth', model: 'inert' } } },
    audit: { path: join(directory, 'audit.jsonl') },
  });
  const app = createApp(config); cleanups.push(app.flushAudit);
  async function request(hints: Record<string, string>, authorized = true, optedIn = false) {
    const response = await app.request('/cc/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer inert-client-auth' } : {}), ...hints },
      body: JSON.stringify({ model: 'inert', max_tokens: 100, messages: [{ role: 'user', content: 'Show the working directory' }], ...(optedIn ? { safeguards: [{ type: 'dangerous_tool_use', classifier_context: { v: 1, live_cwd: '/project', trusted_directories: ['/project'] } }] } : {}) }) });
    const status = response.status;
    await response.text();
    await app.flushAudit();
    return status;
  }
  return { config, credential, request };
}

describe('HTTP audit-only client hints', () => {
  it.each([
    ['user-agent', 'codex_cli_rs/0.164.0'],
    ['x-claude-code-request-class', 'interactive-client'],
  ])('persists supplied %s through actual HTTP gate and source tail', async (header, hint) => {
    const { config, request } = await fixture();
    expect(await request({ [header]: hint })).toBe(200);
    const lines = (await readFile(config.audit.path, 'utf8')).trim().split('\n');
    const tail = await readAuditTail(config.audit.path, 10, collectConfigSecrets(config));
    expect(lines.length).toBe(1); expect(tail.length).toBe(1);
    for (const line of [...lines, ...tail]) {
      const record = JSON.parse(line) as { agent_hint: unknown; delivery: unknown; verdict: unknown };
      expect(record.agent_hint === hint).toBe(true);
      expect(record.delivery === 'rewrite').toBe(true);
      expect(record.verdict === 'allow').toBe(true);
    }
  });

  it.each(['user-agent', 'x-claude-code-request-class'])('sanitizes the complete %s source before hint normalization or cropping', async header => {
    const { config, credential, request } = await fixture();
    const hint = `codex_cli_rs/0.164.0 ${'x'.repeat(230)}${credential} suffix`;
    expect(await request({ [header]: hint })).toBe(200);
    const lines = (await readFile(config.audit.path, 'utf8')).trim().split('\n');
    const tail = await readAuditTail(config.audit.path, 10, collectConfigSecrets(config));
    expect(lines.length).toBe(1); expect(tail.length).toBe(1);
    for (const line of [...lines, ...tail]) {
      const record = JSON.parse(line) as { agent_hint: unknown };
      const output = typeof record.agent_hint === 'string' ? record.agent_hint : '';
      expect.soft(output.includes('codex_cli_rs/0.164.0'), 'non-Claude hint is retained').toBe(true);
      expect.soft(output.includes(credential), 'decoded hint omits configured credential').toBe(false);
      expect.soft(output.includes(credential.slice(0, -1)), 'cropped hint omits recoverable credential prefix').toBe(false);
      expect.soft(output.includes('[REDACTED:credential]'), 'complete-source configured redaction is applied').toBe(true);
    }
  });

  it('does not promote request-class metadata into a Claude delivery version or authorization identity', async () => {
    const { config, request } = await fixture();
    const hints = { 'x-claude-code-request-class': 'claude-code/2.1.311' };
    expect(await request(hints, false, true)).toBe(401);
    expect(await request(hints, true, true)).toBe(200);
    expect(await request({ 'user-agent': 'claude-code/2.1.311' }, true, true)).toBe(200);
    const lines = (await readFile(config.audit.path, 'utf8')).trim().split('\n');
    expect(lines.length).toBe(2);
    const records = lines.map(line => JSON.parse(line) as { delivery: unknown; agent_hint: unknown });
    expect(records[0]!.delivery === 'safeguard').toBe(true);
    expect(records[1]!.delivery === 'rewrite').toBe(true);
    expect(records.every(record => typeof record.agent_hint === 'string' && record.agent_hint.includes('claude-code/2.1.311'))).toBe(true);
  });
});
