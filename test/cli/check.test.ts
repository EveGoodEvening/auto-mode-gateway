import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

const cli = resolve('src/cli/index.ts');
const secret = 'disposable-check-provider-secret';
const answers = {
  destructive: 0.01, exfiltration: 0.02, remote_code_exec: 0.03,
  security_weakening: 0.04, outside_scope: 0.05, matches_user_request: 0.99,
};
interface Seen { path?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }
const wireAnswers = Object.fromEntries(Object.entries(answers).map(([id, probability]) => [id, { type: 'noul', noul: probability }]));
interface Result { code: number | null; stdout: string; stderr: string }
const servers: Server[] = [];
let home: string;

async function mockProvider(reply: (response: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    seen.push({ path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
    response.setHeader('content-type', 'application/json');
    reply(response);
  });
  servers.push(server);
  const { promise: listening, resolve: listened } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listened);
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return { url: `http://127.0.0.1:${address.port}/systemone`, seen };
}

function run(args: string[]): Promise<Result> {
  const { promise, resolve: done, reject } = Promise.withResolvers<Result>();
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => done({ code, stdout, stderr }));
  return promise;
}

async function configuration(providers: Record<string, { base_url: string; kind?: string }>, timeout = 1000) {
  const path = join(home, 'config.yaml');
  await writeFile(path, stringify({
    auth: { mode: 'passthrough' },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }],
    upstreams: { relay: { base_url: 'http://127.0.0.1:9' } },
    gate: { provider_timeout_ms: timeout },
    decision: {
      chain: [Object.keys(providers)[0]],
      providers: Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, {
        kind: 'systemone', api_key: secret, model: 'private-model-name', ...provider,
      }])),
    },
  }));
  return path;
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'amp-check-')); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    const { promise, resolve: closed, reject } = Promise.withResolvers<void>();
    server.close((error) => error ? reject(error) : closed());
    await promise;
  }));
  await rm(home, { recursive: true, force: true });
});

describe('check actual configuration and HTTP behavior', () => {
  it('contacts every configured provider including entries outside the chain with the same fixed canary', async () => {
    const first = await mockProvider((response) => response.end(JSON.stringify({ answers: wireAnswers, usage: { input_tokens: 12 } })));
    const second = await mockProvider((response) => response.end(JSON.stringify({ answers: wireAnswers })));
    const path = await configuration({ first: { base_url: first.url }, second: { base_url: second.url } });
    const result = await run(['check', '--config', path]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/provider\[1\] ok latency_ms=\d+ answers=/);
    expect(result.stdout).toMatch(/provider\[2\] ok latency_ms=\d+ answers=/);
    expect(result.stdout).toContain('"matches_user_request":0.99');
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    expect(first.seen[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(first.seen[0]?.body).toEqual(second.seen[0]?.body);
    expect(first.seen[0]?.body.state).toEqual({
      action: { tool: 'canary', command: 'printf AMP_CANARY', workdir: '/canary' },
      environment: { platform: 'canary', project_dir: '/canary', trusted_directories: ['/canary'] },
      user_request: 'Print AMP_CANARY without changing files or accessing the network.',
    });
    expect(Object.keys(first.seen[0]?.body.questions as object)).toHaveLength(6);
    for (const value of [secret, 'private-model-name', first.url, second.url]) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it('continues after failure, exits nonzero and does not print provider errors or private identifiers', async () => {
    const first = await mockProvider((response) => {
      response.writeHead(500);
      response.end(`Bearer ${secret} private-model-name`);
    });
    const second = await mockProvider((response) => response.end(JSON.stringify({ answers: wireAnswers })));
    const path = await configuration({ 'secret-provider-name': { base_url: first.url }, second: { base_url: second.url } });
    const result = await run(['check', '--config', path]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('provider[1] failed');
    expect(result.stdout).toContain('provider[2] ok');
    expect(second.seen).toHaveLength(1);
    for (const value of [secret, 'Bearer ', 'private-model-name', 'secret-provider-name', first.url]) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it('rejects incomplete probabilities instead of reporting successful connectivity', async () => {
    const provider = await mockProvider((response) => response.end(JSON.stringify({ answers: { destructive: { type: 'noul', noul: 0.01 } } })));
    const result = await run(['check', '--config', await configuration({ broken: { base_url: provider.url } })]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('failed');
    expect(result.stdout).not.toContain(' ok ');
  });

  it('times out an unresponsive provider without leaking its configuration', async () => {
    const provider = await mockProvider(() => {});
    const result = await run(['check', '--config', await configuration({ slow: { base_url: provider.url } }, 30)]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('failed');
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it.each([false, true])('checks both adapter kinds and safely reports Decisions refusal=%s', async (refusal) => {
    const decisions = await mockProvider((response) => response.end(JSON.stringify({ answers: Object.entries(answers).map(([name, probability]) =>
      name === 'destructive' && refusal ? { name, type: 'refusal' } : { name, type: 'predicate', probability }) })));
    const systemone = await mockProvider((response) => response.end(JSON.stringify({ answers: wireAnswers })));
    const path = await configuration({ decisions: { base_url: decisions.url.replace('/systemone', '/v1'), kind: 'openai-decisions' }, systemone: { base_url: systemone.url } });
    const result = await run(['check', '--config', path]);
    expect(result.code).toBe(refusal ? 1 : 0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`provider[1] ${refusal ? 'failed' : 'ok'}`);
    expect(result.stdout).toContain('provider[2] ok');
    expect(decisions.seen).toHaveLength(1);
    expect(systemone.seen).toHaveLength(1);
    expect(decisions.seen[0]?.path).toBe('/v1/decisions');
    for (const value of [secret, 'private-model-name', decisions.url, systemone.url]) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it('fails safely when the default configuration is absent', async () => {
    const result = await run(['check']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Error: command failed.');
    expect(result.stderr).not.toContain(home);
  });

});
