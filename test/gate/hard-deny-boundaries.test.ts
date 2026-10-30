import { describe, expect, it, vi } from 'vitest';

import { configSchema } from '../../src/config/schema.js';
import type { Answers, DecisionResult } from '../../src/decision/types.js';
import { createGate, deterministicOutcome } from '../../src/gate/decide.js';
import { normalizeToolCall } from '../../src/gate/normalize/index.js';
import type { GateContext } from '../../src/gate/types.js';
import { resolvePolicy } from '../../src/policy/effective.js';

// Payloads are data for the real normalizer/gate only; no command is executed.
const context: GateContext = { platform: 'linux', project_dir: '/project', workdir: '/project', lastUserText: 'Inert boundary fixture' };
const safe: Answers = { destructive: 0.1, exfiltration: 0.1, remote_code_exec: 0.1, security_weakening: 0.1, outside_scope: 0.1, matches_user_request: 0.9 };

function config(failure: 'allow' | 'block') {
  return configSchema.parse({
    routes: [{ prefix: '/', protocol: 'anthropic-messages', upstream: 'mock' }],
    upstreams: { mock: { base_url: 'http://127.0.0.1:1234', api_key: 'inert-upstream-credential' } },
    decision: { chain: ['one'], providers: { one: { kind: 'systemone', base_url: 'http://127.0.0.1:1235', model: 'inert', api_key: 'inert-provider-credential' } } },
    gate: { on_provider_failure: failure },
  });
}

function provider(behavior: 'would-allow' | 'unavailable') {
  return { id: 'one', decide: vi.fn(async (): Promise<DecisionResult> => {
    if (behavior === 'unavailable') throw new Error('Inert provider unavailable');
    return { answers: { ...safe }, provider: 'one', model: 'inert', latency_ms: 0, usage: {}, cost_usd: null };
  }) };
}

for (const failure of ['allow', 'block'] as const) {
  for (const behavior of ['would-allow', 'unavailable'] as const) {
    describe(`hard-deny normalization boundary: failure=${failure}, provider=${behavior}`, () => {
      it.each([
        ['bare', { cmd: 'mkfs /dev/inert' }],
        ['quoted', { cmd: '"/sbin/mkfs.xfs" /dev/inert' }],
        ['concatenated', { cmd: "mk''fs.btrfs /dev/inert" }],
        ['native argv', { action: { command: ['mkfs.ext4', '/dev/inert'] } }],
      ] as const)('blocks %s formatting before any provider work', async (label, input) => {
        const name = label === 'native argv' ? 'local_shell_call' : 'exec_command';
        const action = normalizeToolCall('openai-responses', { id: 'inert-format', name, input, raw: {} }, context);
        expect(action.kind).toBe('command');
        expect(action.execution_unavailable).toBeUndefined();
        if (label === 'native argv') expect(action.argv).toEqual(['mkfs.ext4', '/dev/inert']);
        const p = provider(behavior);
        const audit = vi.fn();
        const result = await createGate(config(failure), { providers: [p], audit }).decide(action, context);
        expect(result.outcome).toBe('block');
        expect(result.rule).toMatch(/^filesystem[-_]format$/u);
        expect(p.decide).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledTimes(1);
      });

      it('hard blocks a normalized Windows authorized-keys case alias with no client home', async () => {
        const windows: GateContext = { ...context, platform: 'win32', project_dir: 'c:/project', workdir: 'c:/project' };
        const action = normalizeToolCall('anthropic-messages', {
          id: 'inert-key', name: 'Write',
          input: { file_path: 'C:\\Users\\Agent\\.SSH\\AUTHORIZED_KEYS', content: 'inert key data' }, raw: {},
        }, windows);
        expect(action).toMatchObject({ kind: 'file_write', paths: ['c:/Users/Agent/.SSH/AUTHORIZED_KEYS'], content_truncated: false });
        expect(action.execution_unavailable).toBeUndefined();
        const p = provider(behavior);
        const audit = vi.fn();
        expect(await createGate(config(failure), { providers: [p], audit }).decide(action, windows)).toMatchObject({ outcome: 'block', rule: 'authorized-keys-write' });
        expect(p.decide).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledTimes(1);
      });

      it('hard blocks raw UNC after normalization with entirely empty client context', async () => {
        const empty: GateContext = {};
        const action = normalizeToolCall('anthropic-messages', {
          id: 'inert-unc-key', name: 'Write',
          input: { file_path: '\\\\server\\share\\Agent\\.SSH\\AUTHORIZED_KEYS', content: 'inert key data' }, raw: {},
        }, empty);
        expect(action).toMatchObject({ kind: 'file_write', paths: ['//server/share/Agent/.SSH/AUTHORIZED_KEYS'], content_truncated: false });
        expect(action.workdir).toBeUndefined();
        expect(action.execution_unavailable).toBeUndefined();
        const p = provider(behavior);
        const audit = vi.fn();
        expect(await createGate(config(failure), { providers: [p], audit }).decide(action, empty)).toMatchObject({ outcome: 'block', rule: 'authorized-keys-write' });
        expect(p.decide).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledTimes(1);
      });
    });
  }
}

describe('effective selectors and POSIX case controls at the normalized gate boundary', () => {
  it('sends formatting to review when effective selectors explicitly disable its hard deny', async () => {
    const action = normalizeToolCall('openai-responses', {
      id: 'inert-disabled', name: 'exec_command', input: { cmd: ['mkfs.ext4', '/dev/inert'] }, raw: {},
    }, context);
    const policy = resolvePolicy({ hard_deny_commands: [], hard_deny_patterns: [] });
    expect(deterministicOutcome(action, context, policy).outcome).toBe('review');
    const p = provider('would-allow');
    expect(await createGate(config('block'), { providers: [p], audit: vi.fn(), policy }).decide(action, context)).toMatchObject({ outcome: 'allow', provider: 'one' });
    expect(p.decide).toHaveBeenCalledTimes(1);
  });

  it('retains POSIX component case instead of globally lowercasing authorized-keys paths', async () => {
    const action = normalizeToolCall('anthropic-messages', {
      id: 'inert-posix-case', name: 'Write', input: { file_path: '/project/.SSH/AUTHORIZED_KEYS', content: 'inert key data' }, raw: {},
    }, context);
    expect(action.paths).toEqual(['/project/.SSH/AUTHORIZED_KEYS']);
    expect(deterministicOutcome(action, context, resolvePolicy()).outcome).toBe('review');
    const p = provider('would-allow');
    expect(await createGate(config('block'), { providers: [p], audit: vi.fn() }).decide(action, context)).toMatchObject({ outcome: 'allow', provider: 'one' });
    expect(p.decide).toHaveBeenCalledTimes(1);
  });
});
