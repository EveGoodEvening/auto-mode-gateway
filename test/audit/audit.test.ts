import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_FAILURE_DIAGNOSTIC, createAuditLogger } from '../../src/audit/logger.js';
import { collectConfigSecrets, createAuditRecord, type AuditInput } from '../../src/audit/record.js';
import { readAuditTail, registerAuditCommand } from '../../src/cli/audit.js';
import { configSchema } from '../../src/config/schema.js';
import { resolvePolicy } from '../../src/policy/effective.js';
import { buildState } from '../../src/policy/state-builder.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'amp-audit-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

function configuration(path = join(directory, 'private', 'audit.jsonl')) {
  return configSchema.parse({
    auth: { client_tokens: ['CLIENT_LITERAL_SENTINEL'], admin_token: 'ADMIN_LITERAL_SENTINEL' },
    routes: [{ prefix: '/mock', protocol: 'openai-responses', upstream: 'mock' }],
    upstreams: { mock: { base_url: 'http://127.0.0.1:1', api_key: 'UPSTREAM_LITERAL_SENTINEL', extra_headers: { 'x-custom': 'UPSTREAM_HEADER_SENTINEL' } } },
    decision: {
      chain: ['mock'],
      providers: { mock: { kind: 'systemone', base_url: 'http://127.0.0.1:1', api_key: 'PROVIDER_LITERAL_SENTINEL', model: 'jev-latest', headers: { 'x-custom': 'PROVIDER_HEADER_SENTINEL' } } },
      second_stage: { base_url: 'http://127.0.0.1:1', api_key: 'SECOND_LITERAL_SENTINEL', headers: { 'x-custom': 'SECOND_HEADER_SENTINEL' } },
    },
    audit: { path },
    policy: { version: 'audit-policy-test' },
  });
}
function input(text = 'printf harmless'): AuditInput {
  return {
    route: '/mock', protocol: 'openai-responses', agent_hint: 'codex-test', session_id: 'session-1', delivery: 'rewrite',
    action: { kind: 'command', tool: 'exec_command', text, paths: [], content_truncated: false, raw: { justification: 'AUDIT_ONLY_JUSTIFICATION', assistant: 'AUDIT_ONLY_ASSISTANT', result: 'AUDIT_ONLY_RESULT' } },
    verdict: { outcome: 'block', reasons: ['risk'], rule: 'threshold', provider: 'mock', probabilities: { destructive: 0.9, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.1 }, latency_ms: 12, cost_usd: 0.0000042, input_tokens: 100, output_tokens: 1 },
  };
}

describe('private JSONL audit logger', () => {
  it('appends concurrent complete records with source metadata, estimates and private permissions', async () => {
    const config = configuration();
    const logger = createAuditLogger(config);
    await Promise.all(Array.from({ length: 24 }, (_, index) => logger.append(input(`printf ${index}`))));
    await logger.flush();
    const contents = await readFile(config.audit.path, 'utf8');
    const records = contents.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(24);
    expect(records[0]).toMatchObject({ route: '/mock', protocol: 'openai-responses', agent_hint: 'codex-test', session_id: 'session-1', tool: 'exec_command', rule: 'threshold', provider: 'mock', verdict: 'block', delivery: 'rewrite', latency_ms: 12, input_tokens: 100, output_tokens: 1, cost_usd: 0.0000042, policy_version: 'audit-policy-test', probabilities: { destructive: 0.9 } });
    expect(records[0]?.ts).toEqual(expect.any(String));
    expect((await stat(config.audit.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700);
    expect(records.map((record) => record.action)).toEqual(Array.from({ length: 24 }, (_, index) => expect.objectContaining({ text: `printf ${index}` })));
  });

  it('redacts every configured credential and header value throughout raw action and metadata', async () => {
    const config = configuration();
    const secrets = collectConfigSecrets(config);
    expect(secrets).toHaveLength(8);
    const source = input(secrets.join(' '));
    const privateKey = ['-----BEGIN', 'PRIVATE KEY-----\nPRIVATE_SENTINEL\n-----END', 'PRIVATE KEY-----'].join(' ');
    source.action.raw = { justification: secrets.join(' '), [secrets[0]!]: 'property name', token: 'UNCONFIGURED_TOKEN_SENTINEL', private: privateKey };
    source.agent_hint = secrets.join(' ');
    source.verdict.reasons = [...secrets];
    await createAuditLogger(config).append(source);
    const output = await readFile(config.audit.path, 'utf8');
    for (const secret of [...secrets, 'UNCONFIGURED_TOKEN_SENTINEL', 'PRIVATE_SENTINEL']) expect(output).not.toContain(secret);
    expect(JSON.parse(output)).toMatchObject({ action: { raw: { justification: expect.stringContaining('[REDACTED:credential]') } } });
    expect(source.action.text).toContain('CLIENT_LITERAL_SENTINEL');
  });

  it('uses effective custom redaction and never places audit-only raw data in provider state', async () => {
    const config = configuration();
    const policy = resolvePolicy({ ...config.policy, redaction_patterns: [{ type: 'custom', pattern: { source: 'CUSTOM_SENTINEL', flags: 'g' } }] });
    const source = input('printf CUSTOM_SENTINEL');
    await createAuditLogger(config, { policy }).append(source);
    const output = await readFile(config.audit.path, 'utf8');
    expect(output).not.toContain('CUSTOM_SENTINEL');
    expect(output).toContain('AUDIT_ONLY_JUSTIFICATION');
    const state = JSON.stringify(buildState(source.action, {}));
    for (const marker of ['AUDIT_ONLY_JUSTIFICATION', 'AUDIT_ONLY_ASSISTANT', 'AUDIT_ONLY_RESULT']) expect(state).not.toContain(marker);
  });

  it('snapshots input, tightens an existing file and represents unknown cost/tokens honestly', async () => {
    const config = configuration(join(directory, 'existing.jsonl'));
    await writeFile(config.audit.path, '', { mode: 0o666 });
    const source = input();
    source.verdict.cost_usd = null;
    delete source.verdict.input_tokens;
    delete source.verdict.output_tokens;
    const logger = createAuditLogger(config);
    const pending = logger.append(source);
    source.action.text = 'MUTATED_AFTER_APPEND';
    await pending;
    const record = JSON.parse(await readFile(config.audit.path, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ action: { text: 'printf harmless' }, cost_usd: null, input_tokens: null, output_tokens: null });
    expect((await stat(config.audit.path)).mode & 0o777).toBe(0o600);
  });

  it('isolates filesystem failures and emits only fixed safe diagnostics', async () => {
    const secret = 'FAILURE_PATH_SECRET_SENTINEL';
    const parent = join(directory, secret);
    await writeFile(parent, 'not a directory');
    const diagnostic = vi.fn();
    const logger = createAuditLogger(configuration(join(parent, 'audit.jsonl')), { diagnostic });
    await expect(logger.append(input())).resolves.toBeUndefined();
    await expect(logger.append(input())).resolves.toBeUndefined();
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(diagnostic.mock.calls).toEqual([[AUDIT_FAILURE_DIAGNOSTIC], [AUDIT_FAILURE_DIAGNOSTIC]]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(secret);
  });

  it('isolates cyclic serialization and a throwing diagnostic callback', async () => {
    const source = input();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    source.action.raw = cyclic;
    const logger = createAuditLogger(configuration(), { diagnostic: () => { throw new Error('SECRET_EXCEPTION_SENTINEL'); } });
    await expect(logger.append(source)).resolves.toBeUndefined();
    await expect(logger.append(input())).resolves.toBeUndefined();
    await logger.flush();
    expect((await readFile(configuration().audit.path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('refuses final-component symlinks without touching their target', async () => {
    const target = join(directory, 'target');
    const path = join(directory, 'audit.jsonl');
    await writeFile(target, 'original');
    await symlink(target, path);
    const diagnostic = vi.fn();
    await createAuditLogger(configuration(path), { diagnostic }).append(input());
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(diagnostic).toHaveBeenCalledWith(AUDIT_FAILURE_DIAGNOSTIC);
  });

  it('redacts escaped property names and replacement strings containing configured literals', () => {
    const secret = 'quoted"credential\\sentinel';
    const policy = resolvePolicy({ redaction_patterns: [{ type: 'custom', pattern: { source: 'CUSTOM', flags: 'g' }, replacement: secret }] });
    const source = input('CUSTOM');
    source.action.raw = { [secret]: secret };
    const output = JSON.stringify(createAuditRecord(source, [secret], policy));
    expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.parse(output)).toBeTruthy();
  });
});

describe('real audit tail', () => {
  it('returns last physical lines in order, including a safe malformed marker', async () => {
    const path = join(directory, 'audit.jsonl');
    await writeFile(path, '{"sequence":0}\n{"sequence":1}\nMALFORMED_SECRET_SENTINEL\n{"sequence":3}\n');
    const lines = await readAuditTail(path, 3);
    expect(lines).toEqual(['{"sequence":1}', '[audit: malformed record omitted]', '{"sequence":3}']);
    expect(lines.join('')).not.toContain('MALFORMED_SECRET_SENTINEL');
  });

  it('handles missing files, invalid JSON shapes and an unterminated final line safely', async () => {
    const path = join(directory, 'audit.jsonl');
    expect(await readAuditTail(path)).toEqual([]);
    await writeFile(path, 'null\n["SECRET"]\n"SECRET"\n{"sequence":4}');
    expect(await readAuditTail(path)).toEqual(['[audit: malformed record omitted]', '[audit: malformed record omitted]', '[audit: malformed record omitted]', '{"sequence":4}']);
  });

  it('re-sanitizes historical records with literals and effective policy before printing', async () => {
    const config = configuration(join(directory, 'audit.jsonl'));
    const secret = config.auth.client_tokens[0]!;
    await writeFile(config.audit.path, JSON.stringify({ command: `${secret} CUSTOM_SENTINEL`, raw: { authorization: 'Bearer historical-secret' }, [secret]: 'key' }) + '\n');
    const policy = resolvePolicy({ redaction_patterns: [{ type: 'custom', pattern: { source: 'CUSTOM_SENTINEL', flags: 'g' } }] });
    const lines = await readAuditTail(config.audit.path, 10, collectConfigSecrets(config), policy);
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('CUSTOM_SENTINEL');
    expect(lines.join('')).not.toContain('historical-secret');
  });

  it('runs registered audit tail -n against a real loaded config and file', async () => {
    const config = configuration(join(directory, 'audit.jsonl'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(config.audit.path, '{"sequence":1}\n{"sequence":2,"text":"CLIENT_LITERAL_SENTINEL"}\n');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerAuditCommand(program);
    await program.parseAsync(['audit', 'tail', '--config', configPath, '-n', '1'], { from: 'user' });
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout.mock.calls[0]?.[0]).toBe('{"sequence":2,"text":"[REDACTED:credential]"}\n');
  });

  it.each(['0', '-1', '1.5', 'nan', '10001'])('rejects invalid line count %s without reading config', async (count) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerAuditCommand(program);
    await expect(program.parseAsync(['audit', 'tail', '-n', count], { from: 'user' })).rejects.toBeInstanceOf(CommanderError);
  });
});
