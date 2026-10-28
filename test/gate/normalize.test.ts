import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeToolCall } from '../../src/gate/normalize/index.js';
import { resolvePolicy } from '../../src/policy/effective.js';
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
  it.each(['exec', 'wait', 'request_permissions'])('never treats native opaque %s as generic other or an unrelated benign cmd', (name) => {
    expect(normalize(name, { cmd: 'pwd', call_id: 'opaque-continuation' }, 'openai-responses')).toMatchObject({ kind: 'command', execution_unavailable: true });
    expect(normalize(name, 'opaque native input', 'openai-responses')).toMatchObject({ kind: 'command', execution_unavailable: true });
  });
  it('keeps native client tool search out of generic-other approval', () => {
    expect(normalizeToolCall('openai-responses', { id: 'call', name: 'tool_search', input: { query: 'opaque native dispatch' }, raw: { type: 'tool_search_call', execution: 'client' } }, ctx)).toMatchObject({ execution_unavailable: true });
  });
  it.each([undefined, null, '', 'functions'])('supports the native default namespace %s', (namespace) => {
    expect(normalizeToolCall('openai-responses', { id: 'call', name: 'exec_command', input: { cmd: 'pwd' }, raw: { namespace } }, ctx)).toMatchObject({ kind: 'command', text: 'pwd' });
  });
  it('does not approve a local command name in a different namespace', () => {
    expect(normalizeToolCall('openai-responses', { id: 'call', name: 'exec_command', input: { cmd: 'pwd' }, raw: { namespace: 'remote' } }, ctx).execution_unavailable).toBe(true);
    expect(normalizeToolCall('openai-responses', { id: 'call', name: 'generic_note', input: {}, raw: { namespace: 'remote' } }, ctx)).toMatchObject({ kind: 'mcp', execution_unavailable: true });
    expect(normalizeToolCall('openai-responses', { id: 'call', name: 'generic_note', input: {}, raw: { namespace: 'functions' } }, ctx)).toMatchObject({ kind: 'other' });
  });
  it.each([{ encrypted_function_args: ['opaque'] }, { encrypted_function_args: 'malformed' }, { encrypted_function_args: {} }])('never approves unseen encrypted execution arguments %#', ({ encrypted_function_args }) => {
    expect(normalizeToolCall('openai-responses', { id: 'call', name: 'exec_command', input: { cmd: 'pwd' }, raw: { encrypted_function_args } }, ctx).execution_unavailable).toBe(true);
  });
  it.each([{ env: { PATH: '/inert/alternate-bin' } }, { env: [] }, { user: 'alternate-user' }])('withholds unbound legacy shell context %#', (override) => {
    expect(normalize('local_shell_call', { action: { command: ['pwd'], ...override } }, 'openai-responses')).toMatchObject({ kind: 'command', execution_unavailable: true });
  });
  it.each([{}, null])('retains legacy command support without an execution context override %#', (env) => {
    expect(normalize('local_shell_call', { action: { command: ['pwd'], env, user: null } }, 'openai-responses').execution_unavailable).toBeUndefined();
  });
  it.each([{}, { cmd: [] }, { cmd: [1] }, { cmd: '' }])('blocks unusable command shape %#', (input) => {
    expect(normalize('exec_command', input, 'openai-responses').execution_unavailable).toBe(true);
  });
  it('retains write_stdin chars but requires trusted session association', () => {
    expect(normalize('write_stdin', { session_id: 123, chars: 'printf inert\n' }, 'openai-responses')).toMatchObject({ kind: 'command', text: 'printf inert\n', execution_unavailable: true });
  });
  it('keeps native MCP calls out of the generic-other exemption', () => {
    expect(normalize('mcp__server__opaque', { path: 'note.txt' }, 'openai-responses')).toMatchObject({ kind: 'mcp', paths: ['note.txt'], execution_unavailable: true });
  });
  it.each([{ shell: '/inert/alternate-shell' }, { environment_id: 'unbound-remote' }])('does not approve cmd under an unbound executable context %#', (override) => {
    expect(normalize('exec_command', { cmd: 'pwd', ...override }, 'openai-responses')).toMatchObject({ kind: 'command', text: 'pwd', execution_unavailable: true });
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
  it.each([
    ['Add body without plus prefix', '*** Add File: a.txt\ninert'],
    ['Add body with deletion line', '*** Add File: a.txt\n-inert'],
    ['Add body with context line', '*** Add File: a.txt\n inert'],
    ['Delete body with added line', '*** Delete File: a.txt\n+inert'],
    ['Delete body with removed line', '*** Delete File: a.txt\n-inert'],
    ['Delete body with plain text', '*** Delete File: a.txt\ninert'],
    ['Update hunk with unprefixed body', '*** Update File: a.txt\n@@\nold\n+new'],
    ['Update with empty hunk', '*** Update File: a.txt\n@@'],
    ['Update without body', '*** Update File: a.txt'],
    ['orphan Move header', '*** Move to: b.txt'],
    ['Move following Add', '*** Add File: a.txt\n+inert\n*** Move to: b.txt'],
    ['Move following Delete', '*** Delete File: a.txt\n*** Move to: b.txt'],
    ['Move after Update body', '*** Update File: a.txt\n@@\n-old\n+new\n*** Move to: b.txt'],
    ['repeated Move headers', '*** Update File: a.txt\n*** Move to: b.txt\n*** Move to: c.txt\n@@\n-old\n+new'],
    ['Update with empty intermediate hunk', '*** Update File: a.txt\n@@\n@@ located\n-old\n+new'],
    ['Update with malformed hunk marker', '*** Update File: a.txt\n@@invalid\n-old\n+new'],
    ['Update body after end marker', '*** Update File: a.txt\n@@\n-old\n+new\n*** End of File\n+later'],
    ['Add with empty path', '*** Add File:   \n+inert'],
    ['Delete current directory', '*** Delete File: .'],
  ])('rejects invalid apply_patch operation grammar: %s', (_label, body) => {
    const patch = `*** Begin Patch\n${body}\n*** End Patch`;
    expect(normalize('apply_patch', patch, 'openai-responses')).toMatchObject({ kind: 'file_write', execution_unavailable: true });
  });
  it.each([
    ['Add', '*** Add File: a.txt\n+inert\n+', ['a.txt'], false],
    ['Delete', '*** Delete File: obsolete.txt', ['obsolete.txt'], true],
    ['Update', '*** Update File: a.txt\n@@\n context\n-old\n+new', ['a.txt'], false],
    ['Update with implicit initial hunk', '*** Update File: a.txt\n-old\n+new', ['a.txt'], false],
    ['Update with raw blank context', '*** Update File: a.txt\n@@\n-old\n\n+new', ['a.txt'], false],
    ['Update with implicit raw blank context', '*** Update File: a.txt\n\n-old\n+new', ['a.txt'], false],
    ['Update with located hunk and end marker', '*** Update File: a.txt\n@@ function inert()\n-old\n+new\n*** End of File', ['a.txt'], false],
    ['Update with trailing whitespace on hunk marker', '*** Update File: a.txt\n@@ \n-old\n+new', ['a.txt'], false],
    ['Move with Update', '*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new', ['a.txt', 'b.txt'], false],
    ['empty Add', '*** Add File: empty.txt', ['empty.txt'], false],
    ['multiple Update hunks', '*** Update File: a.txt\n@@ first\n old\n-new\n+inert\n@@ second\n-before\n+after', ['a.txt'], false],
    ['Update with later hunk after end marker', '*** Update File: a.txt\n@@\n-old\n+new\n*** End of File\n@@\n-more\n+later', ['a.txt'], false],
    ['Update with later located hunk after end marker', '*** Update File: a.txt\n@@\n-old\n+new\n*** End of File\n@@ located\n-more\n+later', ['a.txt'], false],
    ['Update with blank lines after end marker', '*** Update File: a.txt\n@@\n-old\n+new\n*** End of File\n\n \n@@\n-more\n+later', ['a.txt'], false],
    ['multiple operations', '*** Add File: a.txt\n+inert\n*** Delete File: obsolete.txt\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-old\n+new', ['a.txt', 'obsolete.txt', 'b.txt', 'c.txt'], true],
  ] as const)('accepts valid apply_patch operation grammar: %s', (_label, body, paths, destructive) => {
    const patch = `*** Begin Patch\n${body}\n*** End Patch`;
    const action = normalize('apply_patch', patch, 'openai-responses');
    expect(action.kind).toBe('file_write');
    expect(action.paths).toEqual(paths);
    expect(action.execution_unavailable).toBeUndefined();
    expect(action.destructive === true).toBe(destructive);
    expect(action.content_excerpt).toBe(patch);
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
  describe.each([
    ['without explicit mapping', undefined],
    ['with explicit other mapping', { tool_map: { generic: 'other' as const } }],
  ] as const)('malformed recognizable paths %s', (_label, route) => {
    const malformedPaths = [
      ...['file_path', 'notebook_path', 'path', 'file', 'filename', 'directory', 'target_path'].flatMap((key) => [
        { [key]: null },
        { [key]: { value: 'inert.txt' } },
        { [key]: 42 },
        { [key]: ['inert.txt'] },
        { [key]: '' },
        { [key]: '   ' },
      ]),
      { paths: null },
      { paths: 'inert.txt' },
      { paths: { value: 'inert.txt' } },
      { paths: [] },
      { paths: [null] },
      { paths: [42] },
      { paths: [{ value: 'inert.txt' }] },
      { paths: ['inert.txt', null] },
      { paths: ['inert.txt', ''] },
      { paths: ['inert.txt', {}] },
      { path: 'inert.txt', file_path: null },
    ];
    it.each(malformedPaths)('blocks malformed recognizable path without content %#', (input) => {
      const action = normalize('generic', input, chat, route);
      expect(action.kind).not.toBe('other');
      expect(action.execution_unavailable).toBe(true);
    });
    it.each(malformedPaths)('blocks malformed recognizable path with content %#', (input) => {
      const action = normalize('generic', { ...input, content: 'inert' }, chat, route);
      expect(action.kind).not.toBe('other');
      expect(action.execution_unavailable).toBe(true);
    });
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
  it.each([
    ['anthropic-messages', 'Write', { file_path: 'inert.txt', content: 'ab💠suffix' }, 'ab💠suffix'],
    ['openai-chat', 'custom', { path: 'inert.txt', content: 'ab💠suffix' }, 'ab💠suffix'],
    ['openai-responses', 'apply_patch', '*** Begin Patch\n*** Add File: inert.txt\n+inert\n*** End Patch', '*** Begin Patch\n*** Add File: inert.txt\n+inert\n*** End Patch'],
  ] as const)('uses resolved fifth-argument visibility cap for %s', (protocol, name, input, fullContent) => {
    const policy = resolvePolicy({ write_content_max_bytes: 4 });
    const action = normalizeToolCall(protocol, { id: 'inert-cap', name, input, raw: input }, ctx, undefined, policy);
    expect(action.content_truncated).toBe(true);
    expect(action.content_excerpt).toBe(protocol === 'openai-responses' ? '*** ' : 'ab');
    expect(action.content_digest).toBe(createHash('sha256').update(fullContent).digest('hex'));
    expect(action.execution_unavailable).toBeUndefined();
  });
  it('retains a full content code point exactly at a configured byte cap', () => {
    const policy = resolvePolicy({ write_content_max_bytes: 6 });
    const action = normalizeToolCall('anthropic-messages', {
      id: 'inert-boundary', name: 'Write', input: { file_path: 'inert.txt', content: 'ab💠' }, raw: {},
    }, ctx, undefined, policy);
    expect(action.content_excerpt).toBe('ab💠');
    expect(action.content_truncated).toBe(false);
  });
});
