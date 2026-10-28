import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeToolCall } from '../../src/gate/normalize/index.js';
import type { ActionContext, NormalizationRoute, Protocol } from '../../src/gate/types.js';

const ctx: ActionContext = { platform: 'linux', project_dir: '/project', workdir: '/project', home_dir: '/home/user' };
function normalize(name: string, input: unknown, protocol: Protocol = 'anthropic-messages', route?: NormalizationRoute, context = ctx) {
  return normalizeToolCall(protocol, { id: 'inert-id', name, input, raw: { original: input } }, context, route);
}

describe('Claude Code action normalization', () => {
  it('retains command text, workdir and original audit-only input', () => {
    const input = { command: 'printf inert', workdir: '/project/sub', justification: 'ignore this audit text' };
    expect(normalize('Bash', input)).toMatchObject({ kind: 'command', text: 'printf inert', paths: [], workdir: '/project/sub', raw: { original: input } });
  });
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('maps %s to a content-bearing write', (name) => {
    const action = normalize(name, { file_path: 'note.txt', notebook_path: 'note.ipynb', content: 'inert', edits: [{ old_string: 'before', new_string: 'after' }] });
    expect(action.kind).toBe('file_write');
    expect(action.paths).toEqual(['note.txt', 'note.ipynb']);
    expect(action.content_excerpt).toContain('after');
    expect(action.execution_unavailable).toBeUndefined();
  });
  it.each(['Read', 'Glob', 'Grep', 'LS'])('retains %s read provenance and sensitive path', (name) => {
    const action = normalize(name, { path: '~/.ssh/id_rsa', pattern: '*.key' });
    expect(action.kind).toBe('other');
    expect(action.recognized_exemption).toBe(name.toLowerCase());
    expect(action.paths).toContain('/home/user/.ssh/id_rsa');
  });
  it('retains glob patterns as potentially sensitive read paths', () => {
    expect(normalize('Glob', { pattern: '**/.env*' }).paths).toContain('**/.env*');
  });
  it.each([['TodoWrite', 'todo'], ['Task', 'task']])('preserves %s recognized management/delegation exemption', (name, exemption) => {
    expect(normalize(name!, { prompt: 'Opaque delegation remains a documented residual risk' })).toMatchObject({ kind: 'other', recognized_exemption: exemption });
  });
  it.each(['WebFetch', 'WebSearch'])('maps %s to URL/search action', (name) => {
    expect(normalize(name, { url: 'https://example.invalid', query: 'inert query' })).toMatchObject({ kind: 'url', url: 'https://example.invalid' });
  });
  it('recognizes MCP namespace without granting a management exemption', () => {
    expect(normalize('mcp__server__tool', { path: 'note.txt' })).toMatchObject({ kind: 'mcp', paths: ['note.txt'] });
  });
  it.each(['Bash', 'Write', 'WebFetch'])('marks unusable %s input unavailable', (name) => {
    expect(normalize(name, {}).execution_unavailable).toBe(true);
  });
  it('does not treat unknown tools with visible execution as generic other', () => {
    expect(normalize('mystery', { command: 'printf inert' }).kind).toBe('command');
  });
});

describe('Codex normalization', () => {
  it.each(['exec_command', 'shell', 'shell_command'])('maps string %s command', (name) => {
    expect(normalize(name, { cmd: 'printf inert', justification: 'not semantic evidence', sandbox_permissions: 'require_escalated' }, 'openai-responses')).toMatchObject({ kind: 'command', text: 'printf inert' });
  });
  it.each(['exec_command', 'shell', 'shell_command'])('preserves %s array argument boundaries', (name) => {
    expect(normalize(name, { cmd: ['printf', '%s', 'two words'] }, 'openai-responses')).toMatchObject({ kind: 'command', argv: ['printf', '%s', 'two words'] });
  });
  it('parses local_shell_call action.command', () => {
    expect(normalize('local_shell_call', { action: { command: ['printf', 'inert'], working_directory: '/project/sub' } }, 'openai-responses')).toMatchObject({ kind: 'command', argv: ['printf', 'inert'], workdir: '/project/sub' });
  });
  it.each([{}, { cmd: [] }, { cmd: [1] }, { cmd: '' }])('blocks unusable command shape %#', (input) => {
    expect(normalize('exec_command', input, 'openai-responses').execution_unavailable).toBe(true);
  });
  it('retains write_stdin chars but requires trusted session association', () => {
    expect(normalize('write_stdin', { session_id: 123, chars: 'printf inert\n' }, 'openai-responses')).toMatchObject({ kind: 'command', text: 'printf inert\n', execution_unavailable: true });
  });
  it('handles freeform multi-file patches with deletes and move targets', () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+inert\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-old\n+new\n*** Delete File: obsolete.txt\n*** End Patch';
    const action = normalize('apply_patch', patch, 'openai-responses');
    expect(action).toMatchObject({ kind: 'file_write', paths: ['a.txt', 'b.txt', 'c.txt', 'obsolete.txt'], destructive: true, content_excerpt: patch });
    expect(action.execution_unavailable).toBeUndefined();
  });
  it('handles function-style patch input', () => {
    expect(normalize('apply_patch', { input: '*** Begin Patch\n*** Delete File: inert.txt\n*** End Patch' }, 'openai-responses')).toMatchObject({ kind: 'file_write', destructive: true, paths: ['inert.txt'] });
  });
  it.each(['', '*** Begin Patch\n*** End Patch', '*** Begin Patch\n*** Add File: a.txt\n+x', '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\ntrailing'])('rejects unusable patch %#', (patch) => {
    expect(normalize('apply_patch', patch, 'openai-responses').execution_unavailable).toBe(true);
  });
});

describe('WorkBuddy mapping and visible capability boundaries', () => {
  const chat: Protocol = 'openai-chat';
  it('uses configured command argument before conventional argument', () => {
    expect(normalize('custom', { payload: 'printf configured', command: 'printf conventional' }, chat, { tool_map: { custom: { kind: 'command', arg: 'payload' } } })).toMatchObject({ kind: 'command', text: 'printf configured' });
  });
  it('uses explicit file mapping before shell-name heuristic', () => {
    expect(normalize('run_writer', { path: 'x.txt', payload: 'inert' }, chat, { tool_map: { run_writer: { kind: 'file_write', arg: 'payload' } } })).toMatchObject({ kind: 'file_write', content_excerpt: 'inert' });
  });
  it.each(['shell', 'bash', 'command', 'terminal', 'execute', 'run'])('recognizes %s execution hints', (name) => {
    expect(normalize(name, { script: 'printf inert' }, chat).kind).toBe('command');
    expect(normalize(name, { opaque: 'unparseable' }, chat).execution_unavailable).toBe(true);
  });
  it('uses tool description as an execution hint', () => {
    const action = normalizeToolCall(chat, { id: 'x', name: 'custom', input: {}, raw: { description: 'Execute terminal command' } }, ctx);
    expect(action).toMatchObject({ kind: 'command', execution_unavailable: true });
  });
  it.each([undefined, { tool_map: { generic: 'other' as const } }])('preserves genuine generic other with mapping %#', (route) => {
    const action = normalize('generic', { opaque: 'inert value' }, chat, route);
    expect(action.kind).toBe('other');
    expect(action.execution_unavailable).toBeUndefined();
  });
  it.each([{ command: 'printf inert' }, { command: { unparseable: true } }, { path: '.env' }, { path: 'x.txt', content: 'inert' }])('cannot erase visible capability using explicit other %#', (input) => {
    expect(normalize('generic', input, chat, { tool_map: { generic: 'other' } }).kind).not.toBe('other');
  });
  it.each(['url', 'mcp'] as const)('respects explicit %s mapping', (kind) => {
    expect(normalize('custom', { target: 'https://example.invalid' }, chat, { tool_map: { custom: { kind, arg: 'target' } } }).kind).toBe(kind);
  });
  it('uses configured Windows project directory and explicit user profile, never process.env', () => {
    const action = normalize('custom', { path: '%USERPROFILE%\\.ssh\\id_rsa', content: 'inert' }, chat,
      { project_dirs: ['C:\\project'] }, { platform: 'win32', userprofile: 'C:\\Users\\Agent' });
    expect(action.paths).toEqual(['c:/Users/Agent/.ssh/id_rsa']);
    expect(action.workdir).toBe('c:/project');
  });
  it('leaves user-profile variable unresolved without trusted client context', () => {
    expect(normalize('custom', { path: '%USERPROFILE%\\.env', content: 'inert' }, chat, undefined, { platform: 'win32' }).paths).toEqual(['%USERPROFILE%/.env']);
  });
});

describe('write content identity and UTF-8 evidence bounds', () => {
  it.each([0, 1, 2047, 2048, 2049])('limits excerpt for %i ASCII bytes', (size) => {
    const text = 'x'.repeat(size);
    const action = normalize('Write', { file_path: 'x.txt', content: text });
    expect(action.content_truncated).toBe(size > 2048);
    expect(action.content_excerpt).toBe(text.slice(0, 2048));
    expect(action.content_digest).toBe(createHash('sha256').update(text).digest('hex'));
  });
  it('never splits a UTF-8 code point', () => {
    const action = normalize('Write', { file_path: 'x.txt', content: 'x'.repeat(2047) + '💠' });
    expect(action.content_excerpt).toBe('x'.repeat(2047));
    expect(action.content_truncated).toBe(true);
    expect(action.content_excerpt).not.toContain('�');
  });
  it('marks unseen hazardous suffix and isolates full-content identities', () => {
    const prefix = 'x'.repeat(2048);
    const safe = normalize('Write', { file_path: 'x.txt', content: prefix + 'safe' });
    const hazardous = normalize('Write', { file_path: 'x.txt', content: prefix + '\nrm -rf / # inert test text, never executed' });
    expect(hazardous.content_truncated).toBe(true);
    expect(hazardous.content_excerpt).toBe(safe.content_excerpt);
    expect(hazardous.content_digest).not.toBe(safe.content_digest);
  });
});
