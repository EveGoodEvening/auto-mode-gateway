import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { anthropicSceneResponse, startLoopback } from '../integration/mock-relay.js';

// Existing suites cover logger APIs, individual audit sanitizers and stream
// exceptions. This regression instead observes their composed HTTP boundary:
// an actual socket failure stays visible with logging enabled, and a subsequent
// denied action persists useful sanitized evidence on the same application.
describe('HTTP diagnostic and persisted audit privacy', () => {
  it('retains transport failure and later denial evidence without leaking fake configured credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amp-regression-'));
    const cleanups: (() => Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
    const secrets = Array.from({ length: 8 }, (_, index) => `fake-c15-credential-${index}-only`);
    let logs = '';
    let logBytes = 0;
    let overflow = false;
    let failedSockets = 0;
    let generationRequests = 0;
    let decisionRequests = 0;
    let unexpectedRequests = 0;
    const capture = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...args: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      logBytes += Buffer.byteLength(text);
      if (logBytes <= 128 * 1024) logs += text;
      else overflow = true;
      const callback = args.find((arg) => typeof arg === 'function');
      if (callback) (callback as () => void)();
      return true;
    }) as typeof process.stderr.write);
    const deadline = AbortSignal.timeout(5000);
    try {
      const source = anthropicSceneResponse({ content: [{ type: 'tool_use', id: 'inert-write', name: 'Write', input: { file_path: '/project/.env', content: secrets.join(' ') } }] }, { method: 'POST', path: '/v1/messages', headers: new Headers(), body: { model: 'mock', stream: false } });
      const sourceBytes = await source.text();
      const relay = createServer((request, response) => {
        if (request.url === '/v1/models') {
          failedSockets++;
          request.socket.destroy();
          return;
        }
        if (request.url === '/v1/messages') {
          generationRequests++;
          request.resume();
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(sourceBytes);
          return;
        }
        // Sensitive writes require the configured provider; they are not a
        // structural hard deny. Serve only its exact declared POST endpoint,
        // using the fixed deny schema from the existing mock-decision fixture.
        if (request.method === 'POST' && request.url === '/v1/systemone') {
          decisionRequests++;
          request.resume();
          const names = ['destructive', 'exfiltration', 'remote_code_exec', 'security_weakening', 'outside_scope', 'matches_user_request'];
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ model: 'mock', answers: Object.fromEntries(names.map((name) => [name, { type: 'noul', noul: name === 'matches_user_request' ? 0.1 : 0.95 }])), usage: { input_tokens: 1, output_tokens: 1 } }));
          return;
        }
        unexpectedRequests++;
        request.resume();
        response.writeHead(500); response.end();
      });
      cleanups.push(async () => {
        const completion = Promise.withResolvers<void>();
        relay.close((error) => error ? completion.reject(error) : completion.resolve());
        relay.closeAllConnections();
        await completion.promise;
      });
      relay.listen(0, '127.0.0.1');
      await once(relay, 'listening');
      const address = relay.address();
      if (!address || typeof address === 'string') throw new Error('Missing regression loopback address');
      const base = `http://127.0.0.1:${address.port}`;
      const config = configSchema.parse({
        auth: { mode: 'vault', client_tokens: [secrets[0]], admin_token: secrets[1] },
        upstreams: { mock: { base_url: base, api_key: secrets[2], extra_headers: { 'x-fake-private': secrets[3] } } },
        routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock', claude_delivery: 'rewrite', project_dirs: ['/project'] }],
        decision: { chain: ['mock'], providers: { mock: { kind: 'systemone', base_url: base, api_key: secrets[4], headers: { 'x-fake-private': secrets[5] }, model: 'mock' } }, second_stage: { base_url: base, api_key: secrets[6], headers: { 'x-fake-private': secrets[7] } } },
        // Mandatory configured-literal privacy cannot depend on optional regexes.
        policy: { redaction_patterns: [], redaction_sensitive_keys: { source: '^never-match$' } },
        audit: { path: join(directory, 'audit.jsonl') }, log_level: 'info',
      });
      const app = createApp(config);
      cleanups.push(app.flushAudit);
      const gateway = await startLoopback(app);
      cleanups.push(gateway.close);
      const headers = { authorization: `Bearer ${secrets[0]!}`, 'x-api-key': secrets[0]!, 'content-type': 'application/json' };
      const failed = await fetch(gateway.url + '/cc/v1/models', { headers, signal: deadline });
      const failureBody = await failed.text();
      expect(failed.status).toBe(502);
      expect(failureBody.includes('Upstream connection failed')).toBe(true);
      const blocked = await fetch(gateway.url + '/cc/v1/messages', { method: 'POST', headers, signal: deadline, body: JSON.stringify({ model: 'mock', max_tokens: 100, stream: false, messages: [{ role: 'user', content: 'Inert privacy regression' }] }) });
      const blockedBody = await blocked.text();
      expect(blocked.status).toBe(200);
      expect(blockedBody.includes('auto-mode-proxy')).toBe(true);
      expect(blockedBody.includes('"type":"tool_use"')).toBe(false);
      const recovered = await fetch(gateway.url + '/healthz', { signal: deadline });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: 'ok' });
      await app.flushAudit();
      const audit = await readFile(config.audit.path, 'utf8');
      // Check booleans, never echo captured records, fake credentials or raw
      // exception text in assertion failures (including vulnerable-code runs).
      expect(overflow).toBe(false);
      expect(logBytes > 0).toBe(true);
      expect(failedSockets > 0).toBe(true);
      expect(generationRequests).toBe(1);
      expect(decisionRequests).toBe(1);
      expect(unexpectedRequests).toBe(0);
      for (const secret of secrets) {
        expect(logs.includes(secret)).toBe(false);
        expect(audit.includes(secret)).toBe(false);
        expect(failureBody.includes(secret)).toBe(false);
        expect(blockedBody.includes(secret)).toBe(false);
      }
      const diagnostics = logs.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(diagnostics.some((row) => row.level === 50 && row.status === 502 && row.msg === 'Upstream transport failed')).toBe(true);
      expect(diagnostics.some((row) => row.msg === 'Request completed' && row.status === 200)).toBe(true);
      const records = audit.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.length).toBe(1);
      expect(records.every((row) => row.verdict === 'block' && row.tool === 'Write' && row.protocol === 'anthropic-messages' && row.provider === 'mock' && row.rule === 'model-threshold')).toBe(true);
      expect(audit.includes('[REDACTED:credential]')).toBe(true);
    } finally {
      let cleanupFailed = false;
      try {
        for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { cleanupFailed = true; } }
      } finally { capture.mockRestore(); }
      expect(cleanupFailed).toBe(false);
    }
  }, 10_000);
});
