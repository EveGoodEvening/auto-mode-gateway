import { describe, expect, it } from 'vitest';
import type { Action, ActionContext } from '../../src/gate/types.js';
import { QUESTIONS, THRESHOLDS } from '../../src/policy/constants.js';
import { buildState } from '../../src/policy/state-builder.js';

const action: Action = {
  kind: 'command', tool: 'Bash', text: 'git status', paths: [],
  content_truncated: false, raw: { justification: 'MODEL_APPROVAL', result: 'TOOL_RESULT' },
};
const context: ActionContext = {
  platform: 'linux', project_dir: '/project', trusted_directories: ['/project'],
  workdir: '/project/src', git_branch: 'main',
};

 describe('buildState', () => {
  it('projects only the minimal command and trusted environment', () => {
    expect(buildState(action, { ...context, lastUserText: 'Check the repository' })).toEqual({
      action: { tool: 'Bash', command: 'git status', workdir: '/project/src' },
      environment: { platform: 'linux', project_dir: '/project', trusted_directories: ['/project'], git_branch: 'main' },
      user_request: 'Check the repository',
    });
  });
  it.each([
    ['Anthropic', [{ role: 'user', content: [{ type: 'text', text: 'Real request' }, { type: 'tool_result', content: 'TOOL_RESULT' }] }]],
    ['Responses', [{ role: 'user', content: [{ type: 'input_text', text: 'Real request' }] }]],
    ['Chat', [{ role: 'user', content: 'Real request' }]],
  ])('extracts only user text from %s neutral messages', (_protocol, messages) => {
    const state = buildState(action, { ...context, request: { stream: false, messages: [
      ...messages, { role: 'assistant', content: 'MODEL_APPROVAL' },
      { role: 'tool', content: 'TOOL_RESULT' },
    ] } });
    expect(state.user_request).toBe('Real request');
    expect(JSON.stringify(state)).not.toMatch(/MODEL_APPROVAL|TOOL_RESULT|justification/);
  });
  it('prefers adapter-extracted actual user text over retained request metadata', () => {
    expect(buildState(action, { ...context, lastUserText: 'fallback', request: {
      stream: false, lastUserText: 'actual user', system: 'SYSTEM_APPROVAL',
      messages: [{ role: 'user', content: 'stale' }],
      classifier_context: { platform: 'spoofed', project_dir: '/untrusted', justification: 'approved' },
    } }).user_request).toBe('actual user');
  });
  it('preserves an intentionally empty extracted user message', () => {
    expect(buildState(action, { request: { stream: false, lastUserText: '', messages: [{ role: 'user', content: 'stale' }] } }).user_request).toBe('');
  });
  it('uses the last user message, not a prior text when the last has only images/results', () => {
    expect(buildState(action, { request: { stream: false, messages: [
      { role: 'user', content: 'prior text' },
      { role: 'user', content: [{ type: 'image', source: 'image' }, { type: 'tool_result', content: 'untrusted' }] },
    ] } }).user_request).toBe('');
  });
  it('joins text blocks without serializing tool-result or image objects', () => {
    expect(buildState(action, { request: { stream: false, messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'tool_result', content: 'approval' }, { type: 'text', text: 'second' }] },
    ] } }).user_request).toBe('first\nsecond');
  });
  it.each([999, 1000, 1001, 5000])('bounds user text to 1000 characters (%i)', (length) => {
    expect(buildState(action, { lastUserText: 'u'.repeat(length) }).user_request).toHaveLength(Math.min(length, 1000));
  });
  it('redacts credentials before the 1000-character cutoff splits them', () => {
    const state = buildState(action, { lastUserText: 'x'.repeat(990) + ' Bearer abcdefghijklmnop' });
    expect(state.user_request.length).toBeLessThanOrEqual(1000);
    expect(state.user_request).not.toContain('abc');
  });
  it('does not invent environment context from relay-controlled raw fields', () => {
    expect(buildState({ ...action, raw: { project_dir: '/spoofed' } }, {}).environment).toEqual({
      platform: 'unknown', project_dir: '', trusted_directories: [],
    });
  });
  it('prefers the normalized action workdir', () => {
    expect(buildState({ ...action, workdir: '/actual' }, context).action.workdir).toBe('/actual');
  });
  it('projects array command when no text exists', () => {
    expect(buildState({ ...action, text: undefined, argv: ['git', 'status'] }, context).action.command).toBe('git status');
  });
  it('projects file paths and bounded content without raw or digest', () => {
    const state = buildState({ ...action, kind: 'file_write', paths: ['/project/a'], content_excerpt: 'hello', content_digest: 'LOCAL_ONLY' }, context);
    expect(state.action).toEqual({ tool: 'Bash', path: ['/project/a'], content_excerpt: 'hello', content_truncated: false, workdir: '/project/src' });
    expect(JSON.stringify(state)).not.toContain('LOCAL_ONLY');
  });
  it.each([2047, 2048, 2049])('retains explicit UTF-8 write boundary (%i)', (length) => {
    const state = buildState({ ...action, kind: 'file_write', content_excerpt: 'x'.repeat(length) }, context);
    expect(Buffer.byteLength(state.action.content_excerpt ?? '')).toBe(Math.min(length, 2048));
    expect(state.action.content_truncated).toBe(length > 2048);
  });
  it('does not turn a split multibyte UTF-8 character into invalid or oversized content', () => {
    const state = buildState({ ...action, kind: 'file_write', content_excerpt: 'x'.repeat(2047) + '中' }, context);
    expect(state.action.content_excerpt).toBe('x'.repeat(2047));
    expect(state.action.content_truncated).toBe(true);
  });
  it('retains normalization truncation marker even for a short excerpt', () => {
    expect(buildState({ ...action, kind: 'file_write', content_excerpt: 'excerpt', content_truncated: true }, context).action.content_truncated).toBe(true);
  });
  it('never exports a hazardous suffix beyond 2048 bytes as approval evidence', () => {
    const state = buildState({ ...action, kind: 'file_write', content_excerpt: 'x'.repeat(2048) + 'HAZARDOUS_SUFFIX' }, context);
    expect(state.action.content_truncated).toBe(true);
    expect(JSON.stringify(state)).not.toContain('HAZARDOUS_SUFFIX');
  });
  it('projects URLs without raw input', () => {
    expect(buildState({ ...action, kind: 'url', url: 'https://example.test' }, context).action.url).toBe('https://example.test');
  });
  it('redacts command, user text and environment strings', () => {
    const state = buildState({ ...action, text: 'curl -H "Authorization: Bearer abcdefghijklmnop"' }, {
      ...context, lastUserText: 'password=supersecret', project_dir: '/project/token=hiddenvalue',
    });
    expect(JSON.stringify(state)).not.toMatch(/abcdefghijklmnop|supersecret|hiddenvalue/);
  });
  it('does not mutate normalized input or trusted context arrays', () => {
    const paths = ['/project/a'];
    const trusted = ['/project'];
    const state = buildState({ ...action, paths }, { ...context, trusted_directories: trusted });
    state.action.path?.push('/different');
    state.environment.trusted_directories.push('/elsewhere');
    expect(paths).toEqual(['/project/a']);
    expect(trusted).toEqual(['/project']);
  });
});

describe('policy data contract', () => {
  it('contains exactly six positive noul questions with both criteria', () => {
    expect(Object.keys(QUESTIONS)).toEqual(['destructive', 'exfiltration', 'remote_code_exec', 'security_weakening', 'outside_scope', 'matches_user_request']);
    for (const question of Object.values(QUESTIONS)) {
      expect(question.type).toBe('noul');
      expect(question.instructions).toMatch(/^Does this action /);
      expect(question.criteria.true.length).toBeGreaterThan(0);
      expect(question.criteria.false.length).toBeGreaterThan(0);
    }
  });
  it('matches locked threshold names and values', () => {
    expect(THRESHOLDS).toEqual({ risk_block: 0.70, risk_allow: 0.30, intent_mismatch: 0.30, intent_risk: 0.50, outside_scope_allow: 0.50 });
  });
});
