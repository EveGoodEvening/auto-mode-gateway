import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import type { Action } from '../../src/gate/types.js';
import { DEFAULT_POLICY, resolvePolicy } from '../../src/policy/effective.js';
import { hardDeny } from '../../src/policy/hard-deny.js';
import { isReadonlyCommand } from '../../src/policy/readonly-allowlist.js';
import { redact, redactText } from '../../src/policy/redact.js';
import { parseShell } from '../../src/policy/shell-parse.js';
import { sensitivePaths } from '../../src/policy/sensitive-paths.js';
import { buildState } from '../../src/policy/state-builder.js';

const baseConfig = {
  routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }],
  upstreams: { relay: { base_url: 'https://relay.example' } },
  decision: { chain: ['trusted'], providers: { trusted: {
    kind: 'systemone', base_url: 'https://trusted.example', api_key: 'fixture', model: 'fixture',
  } } },
};
const context = { platform: 'linux', project_dir: '/repo', workdir: '/repo', home_dir: '/home/user' };
const action: Action = { kind: 'command', tool: 'Bash', text: 'pwd', paths: [], content_truncated: false, raw: {} };

function configured(policy: unknown) {
  return resolvePolicy(configSchema.parse({ ...baseConfig, policy }).policy);
}

describe('one constants-backed effective policy', () => {
  it('reproduces default behavior through the same resolution path', () => {
    const resolved = configured({});
    expect(resolved).toEqual(DEFAULT_POLICY);
    expect(isReadonlyCommand('pwd', resolved)).toBe(true);
    expect(hardDeny({ ...action, text: 'rm -rf /' }, resolved)).toBeDefined();
    expect(redactText('client_secret=opaque', [], resolved)).not.toContain('opaque');
  });

  it('merges question leaves and partial thresholds without losing positive criteria or version', () => {
    const policy = configured({
      version: 'local-reviewed',
      questions: { destructive: { instructions: 'Local destructive question?', criteria: { true: 'Local destructive evidence.' } } },
      thresholds: { risk_block: 0.9, intent_mismatch: 0.2 },
    });
    expect(policy.version).toBe('local-reviewed');
    expect(policy.questions.destructive).toEqual({
      type: 'noul', instructions: 'Local destructive question?',
      criteria: { true: 'Local destructive evidence.', false: DEFAULT_POLICY.questions.destructive.criteria.false },
    });
    expect(policy.questions.matches_user_request).toEqual(DEFAULT_POLICY.questions.matches_user_request);
    expect(policy.thresholds).toEqual({ risk_block: 0.9, risk_allow: 0.3, intent_mismatch: 0.2, intent_risk: 0.5, outside_scope_allow: 0.5 });
    expect(DEFAULT_POLICY.questions.destructive.instructions).not.toBe('Local destructive question?');
    expect(DEFAULT_POLICY.thresholds.risk_block).toBe(0.7);
  });

  it('replaces readonly programs before appending extras and retains shell invariants', () => {
    const policy = configured({ readonly_programs: ['localread'], readonly_allow_extra: ['extra-read'] });
    expect(isReadonlyCommand('localread', policy)).toBe(true);
    expect(isReadonlyCommand('extra-read', policy)).toBe(true);
    expect(isReadonlyCommand('pwd', policy)).toBe(false);
    expect(isReadonlyCommand('extra-read > output', policy)).toBe(false);
    expect(isReadonlyCommand('extra-read && rm file', policy)).toBe(false);
  });

  it('uses shell vocabulary replacements in parsing rather than retaining default aliases', () => {
    const policy = configured({ shell_unsafe_programs: ['local-wrapper'], shell_interpreters: ['local-interpreter'] });
    expect(parseShell('local-wrapper pwd').unsafe).toBe(false);
    expect(parseShell('local-wrapper pwd', policy).unsafe).toBe(true);
    expect(parseShell('local-interpreter code', policy).unsafe).toBe(true);
  });

  it('merges argument records by program and replaces supplied entries in real classification', () => {
    const policy = configured({ readonly_unsafe_arguments: { cat: ['--local-write'] }, readonly_positional_limits: { cat: 0 } });
    expect(isReadonlyCommand('cat --local-write', policy)).toBe(false);
    expect(isReadonlyCommand('cat file', policy)).toBe(false);
    expect(isReadonlyCommand('sort -o output input', policy)).toBe(false);
    expect(isReadonlyCommand('cat', policy)).toBe(true);
  });

  it('replaces deny patterns and compiles extras with their historical case/unicode flags', () => {
    const policy = configured({ hard_deny_patterns: [{ id: 'local-deny', pattern: { source: 'local-danger', flags: 'g' } }], hard_deny_extra: ['extra-danger'] });
    expect(hardDeny({ ...action, text: 'local-danger' }, policy)).toBeDefined();
    expect(hardDeny({ ...action, text: 'local-danger' }, policy)).toBeDefined();
    expect(hardDeny({ ...action, text: 'EXTRA-DANGER' }, policy)).toBeDefined();
    expect(hardDeny({ ...action, text: 'local-danger' })).toBeUndefined();
    expect(hardDeny({ ...action, execution_unavailable: true }, configured({ hard_deny_patterns: [], hard_deny_commands: [] }))).toBeDefined();
  });

  it('uses target regex replacements without losing absent default targets', () => {
    const policy = configured({ hard_deny_target_patterns: { root: { source: '^/local-root$' } } });
    expect(hardDeny({ ...action, text: 'rm -rf /local-root' }, policy)).toBeDefined();
    expect(hardDeny({ ...action, text: 'rm -rf /local-root' })).toBeUndefined();
    expect(hardDeny({ ...action, text: 'dd if=input of=/dev/sda' }, policy)).toBeDefined();
  });

  it('replaces sensitive globs before appending extras in actual read classification', () => {
    const read: Action = { ...action, kind: 'other', recognized_exemption: 'read', tool: 'Read', paths: ['/repo/secret.local'] };
    const policy = configured({ sensitive_path_globs: ['**/*.local'], sensitive_paths_extra: ['**/*.extra'] });
    expect(sensitivePaths(read, context).review).toBe(false);
    expect(sensitivePaths(read, context, policy).review).toBe(true);
    expect(sensitivePaths({ ...read, paths: ['/repo/secret.extra'] }, context, policy).review).toBe(true);
    expect(sensitivePaths({ ...read, paths: ['/repo/.env'] }, context, policy).review).toBe(false);
  });

  it('propagates configured redaction and lower projection ceilings through state construction', () => {
    const policy = configured({
      user_request_max_chars: 12, write_content_max_bytes: 4,
      redaction_patterns: [{ type: 'local', pattern: { source: 'opaque', flags: 'g' } }],
      redaction_sensitive_keys: { source: '^local_key$', flags: 'gi' },
    });
    expect(redact({ local_key: 'opaque', text: 'opaque' }, [], policy)).toEqual({ local_key: '[REDACTED:credential]', text: '[REDACTED:local]' });
    const state = buildState({ ...action, text: 'echo opaque' }, { ...context, lastUserText: 'opaque plus long request' }, policy);
    expect(state.action.command).toBe('echo [REDACTED:local]');
    expect(state.user_request).toBe('[REDACTED:lo');
    const write = buildState({ ...action, kind: 'file_write', paths: ['/repo/file'], content_excerpt: 'abcdefgh' }, context, policy);
    expect(write.action.content_excerpt).toBe('abcd');
    expect(write.action.content_truncated).toBe(true);
  });

  it('throws on invalid direct-call regexes rather than dropping configured protection', () => {
    expect(() => resolvePolicy({ redaction_sensitive_keys: { source: '[' } })).toThrow();
    expect(() => resolvePolicy({ hard_deny_extra: ['['] })).toThrow();
  });
});
