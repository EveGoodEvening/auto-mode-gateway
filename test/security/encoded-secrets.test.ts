import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditLogger } from '../../src/audit/logger.js';
import { collectConfigSecrets } from '../../src/audit/record.js';
import { readAuditTail } from '../../src/cli/audit.js';
import { configSchema } from '../../src/config/schema.js';
import type { DecisionProvider } from '../../src/decision/types.js';
import { createGate } from '../../src/gate/decide.js';
import { normalizeToolCall } from '../../src/gate/normalize/index.js';
import { resolvePolicy } from '../../src/policy/effective.js';
import { parseShell } from '../../src/policy/shell-parse.js';
import type { DecisionState } from '../../src/policy/state-builder.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

// Decode precisely the JSON array representation generated for multi-part writes.
// A raw includes check cannot detect the quote/backslash credentials it encodes.
function recoveredComponents(excerpt: string, multipart: boolean): string[] {
  if (!multipart) return [excerpt];
  const decoded: unknown = JSON.parse(excerpt);
  if (!Array.isArray(decoded) || !decoded.every(value => typeof value === 'string')) throw new Error('Expected generated write components');
  return decoded as string[];
}
function containsCredential(value: unknown, credentials: readonly string[]): boolean {
  if (typeof value === 'string') return credentials.some(secret => value.includes(secret));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => credentials.some(secret => key.includes(secret)) || containsCredential(entry, credentials));
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amp-encoded-'));
  directories.push(directory);
  const credentials = ['Opaque"QuoteCredentialQ7', 'Opaque\\BackslashCredentialR8'];
  const config = configSchema.parse({
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }],
    upstreams: { relay: { base_url: 'http://127.0.0.1:1', extra_headers: { 'x-private-one': credentials[0], 'x-private-two': credentials[1] } } },
    decision: { chain: ['one'], providers: { one: { kind: 'systemone', base_url: 'http://127.0.0.1:1', model: 'inert', api_key: 'inert-provider-key' } } },
    audit: { path: join(directory, 'audit.jsonl') },
  });
  return { config, credentials, policy: resolvePolicy(config.policy) };
}

describe('configured credentials in gateway-generated write JSON', () => {
  it.each(['Edit', 'MultiEdit', 'Write'] as const)('sanitizes actual %s provider state, decoded raw, persisted JSONL and source tail without changing execution identity', async tool => {
    const { config, credentials, policy } = await fixture();
    const replacement = credentials.join(' ordinary separator ');
    const input = tool === 'Write' ? { file_path: '/project/note.txt', content: replacement }
      : tool === 'Edit' ? { file_path: '/project/note.txt', old_string: 'ordinary old text', new_string: replacement }
        : { file_path: '/project/note.txt', edits: [{ old_string: 'ordinary old text', new_string: replacement }, { old_string: 'second old text', new_string: 'second new text' }] };
    const originalInput = JSON.stringify(input);
    const context = { platform: 'linux', project_dir: '/project', workdir: '/project', lastUserText: 'Update the project note', protocol: 'anthropic-messages' as const };
    const action = normalizeToolCall(context.protocol, { id: 'encoded-write', name: tool, input, raw: { type: 'tool_use', id: 'encoded-write', name: tool, input } }, context, undefined, policy);
    const originalAction = JSON.stringify(action);
    const excerpt = action.content_excerpt!;
    const digest = createHash('sha256').update(excerpt, 'utf8').digest('hex');
    expect(containsCredential(recoveredComponents(excerpt, tool !== 'Write'), credentials)).toBe(true);
    expect(action.content_digest === digest).toBe(true);
    const captured: DecisionState[] = [];
    const provider: DecisionProvider = { id: 'one', async decide(state) {
      captured.push(structuredClone(state));
      return { answers: { destructive: 0.1, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 }, provider: 'one', model: 'inert', latency_ms: 0, usage: {}, cost_usd: null };
    } };
    const logger = createAuditLogger(config, { policy });
    const gate = createGate(config, { providers: [provider], audit: logger.append, policy });
    const verdict = await gate.decide(action, context);
    await gate.flushAudit(); await logger.flush();
    expect(verdict.outcome === 'allow').toBe(true);
    expect(captured.length).toBe(1);
    const persisted = (await readFile(config.audit.path, 'utf8')).trim().split('\n');
    const tail = await readAuditTail(config.audit.path, 10, collectConfigSecrets(config), policy);
    expect(persisted.length).toBe(1); expect(tail.length).toBe(1);
    expect.soft(containsCredential(recoveredComponents(captured[0]!.action.content_excerpt!, tool !== 'Write'), credentials), 'decoded provider components are private').toBe(false);
    for (const serialized of [...persisted, ...tail]) {
      const record = JSON.parse(serialized) as { action: { content_excerpt: string; content_digest: string; raw: unknown } };
      expect.soft(containsCredential(record.action.raw, credentials), 'decoded raw action is private').toBe(false);
      expect.soft(containsCredential(recoveredComponents(record.action.content_excerpt, tool !== 'Write'), credentials), 'decoded persisted/tail components are private').toBe(false);
      expect(record.action.content_digest === digest).toBe(true);
    }
    expect(JSON.stringify(input) === originalInput).toBe(true);
    expect(JSON.stringify(action) === originalAction).toBe(true);
  });

  it('re-sanitizes historical generated escaped excerpts through source tail without rewriting the archive', async () => {
    const { config, credentials, policy } = await fixture();
    const excerpt = JSON.stringify(['ordinary old text', ...credentials]);
    const digest = createHash('sha256').update(excerpt).digest('hex');
    const historical = JSON.stringify({ tool: 'MultiEdit', verdict: 'allow', action: { kind: 'file_write', tool: 'MultiEdit', content_excerpt: excerpt, content_truncated: false, content_digest: digest, raw: { edits: credentials.map(new_string => ({ old_string: 'old', new_string })) } } }) + '\n';
    await writeFile(config.audit.path, historical);
    const tail = await readAuditTail(config.audit.path, 10, collectConfigSecrets(config), policy);
    expect(tail.length).toBe(1);
    const record = JSON.parse(tail[0]!) as { action: { content_excerpt: string; content_digest: string; raw: unknown } };
    expect.soft(containsCredential(recoveredComponents(record.action.content_excerpt, true), credentials), 'historical decoded components are private').toBe(false);
    expect(containsCredential(record.action.raw, credentials)).toBe(false);
    expect(record.action.content_digest === digest).toBe(true);
    expect((await readFile(config.audit.path, 'utf8')) === historical).toBe(true);
  });

  it('sanitizes native argv shell rendering in provider state, current audit and historical source tail without changing inputs', async () => {
    const { config, policy } = await fixture();
    const secret = "Opaque'CredentialQ7";
    config.upstreams.relay!.extra_headers!['x-private-native'] = secret;
    const credentials = collectConfigSecrets(config);
    const input = { action: { type: 'exec', command: ['printf', '%s', secret] } };
    const raw = { type: 'local_shell_call', id: 'native-encoded', call_id: 'native-encoded', status: 'completed', ...input };
    const originalInput = JSON.stringify(input);
    const originalRaw = JSON.stringify(raw);
    const context = { platform: 'linux', project_dir: '/project', workdir: '/project', lastUserText: 'Display the supplied inert text', protocol: 'openai-responses' as const };
    const action = normalizeToolCall(context.protocol, { id: 'native-encoded', name: 'local_shell_call', input, raw }, context, undefined, policy);
    const originalAction = JSON.stringify(action);
    const originalIdentity = createHash('sha256').update(originalAction).digest('hex');
    const parsedOriginal = parseShell(action.text!, policy);
    expect(parsedOriginal.valid).toBe(true);
    expect(parsedOriginal.segments.length).toBe(1);
    expect(parsedOriginal.segments[0]!.argv[2] === secret).toBe(true);
    const captured: DecisionState[] = [];
    const provider: DecisionProvider = { id: 'one', async decide(state) {
      captured.push(structuredClone(state));
      return { answers: { destructive: 0.1, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 }, provider: 'one', model: 'inert', latency_ms: 0, usage: {}, cost_usd: null };
    } };
    const logger = createAuditLogger(config, { policy });
    const gate = createGate(config, { providers: [provider], audit: logger.append, policy });
    const verdict = await gate.decide(action, context);
    await gate.flushAudit(); await logger.flush();
    expect(verdict.outcome === 'allow').toBe(true);
    expect(captured.length).toBe(1);
    const parsedState = parseShell(captured[0]!.action.command!, policy);
    expect(parsedState.valid).toBe(true);
    expect.soft(containsCredential(parsedState.segments.map(segment => segment.argv), credentials), 'parsed provider argv is private').toBe(false);
    const persisted = (await readFile(config.audit.path, 'utf8')).trim().split('\n');
    const tail = await readAuditTail(config.audit.path, 10, credentials, policy);
    const historicalPath = config.audit.path + '.historical';
    const historical = JSON.stringify({ tool: action.tool, action, verdict: 'allow' }) + '\n';
    await writeFile(historicalPath, historical);
    const historicalTail = await readAuditTail(historicalPath, 10, credentials, policy);
    expect(persisted.length).toBe(1); expect(tail.length).toBe(1); expect(historicalTail.length).toBe(1);
    for (const serialized of [...persisted, ...tail, ...historicalTail]) {
      const record = JSON.parse(serialized) as { action: { text: string; argv: unknown; raw: unknown } };
      const parsed = parseShell(record.action.text, policy);
      expect(parsed.valid).toBe(true);
      expect.soft(containsCredential(parsed.segments.map(segment => segment.argv), credentials), 'parsed persisted/current/historical argv is private').toBe(false);
      expect(containsCredential(record.action.argv, credentials)).toBe(false);
      expect(containsCredential(record.action.raw, credentials)).toBe(false);
    }
    expect((await readFile(historicalPath, 'utf8')) === historical).toBe(true);
    expect(JSON.stringify(input) === originalInput).toBe(true);
    expect(JSON.stringify(raw) === originalRaw).toBe(true);
    expect(JSON.stringify(action) === originalAction).toBe(true);
    expect(createHash('sha256').update(JSON.stringify(action)).digest('hex') === originalIdentity).toBe(true);
  });
});
