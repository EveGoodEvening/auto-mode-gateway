import { describe, expect, it } from 'vitest';
import type { Action, ActionContext } from '../../src/gate/types.js';
import { QUESTIONS, THRESHOLDS } from '../../src/policy/constants.js';
import { buildState } from '../../src/policy/state-builder.js';
import { resolvePolicy } from '../../src/policy/effective.js';
import { extractRequestContext } from '../../src/protocols/request-context.js';
import type { RequestProtocol } from '../../src/protocols/types.js';
import { anthropicAdapter } from '../../src/protocols/anthropic/adapter.js';

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
  const protocolRequests: { protocol: RequestProtocol; body: (text: string) => unknown }[] = [
    { protocol: 'anthropic-messages', body: text => ({
      system: 'SYSTEM_APPROVAL', messages: [
        { role: 'user', content: [{ type: 'text', text }, { type: 'tool_result', content: 'TOOL_RESULT' }] },
        { role: 'assistant', content: 'MODEL_APPROVAL' },
      ],
    }) },
    { protocol: 'openai-responses', body: text => ({
      instructions: 'SYSTEM_APPROVAL', input: text,
    }) },
    { protocol: 'openai-responses', body: text => ({
      instructions: 'SYSTEM_APPROVAL', input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: 'IMAGE_DATA' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MODEL_APPROVAL' }] },
        { type: 'function_call_output', call_id: 'call-1', output: 'TOOL_RESULT' },
      ],
    }) },
    { protocol: 'openai-chat', body: text => ({ messages: [
      { role: 'system', content: 'SYSTEM_APPROVAL' },
      { role: 'user', content: text },
      { role: 'assistant', content: 'MODEL_APPROVAL' },
      { role: 'tool', tool_call_id: 'call-1', content: 'TOOL_RESULT' },
    ] }) },
    { protocol: 'openai-chat', body: text => ({ messages: [
      { role: 'system', content: 'SYSTEM_APPROVAL' },
      { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'IMAGE_DATA' } }] },
      { role: 'assistant', content: 'MODEL_APPROVAL', tool_calls: [{ function: { arguments: 'JUSTIFICATION' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'TOOL_RESULT' },
    ] }) },
  ];
  it.each(protocolRequests)('projects genuine encoded $protocol user input only', ({ protocol, body }) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body('Real request')));
    const original = bytes.slice();
    const request = extractRequestContext(protocol, bytes);
    expect(request).toBeDefined();
    const state = buildState(action, { ...context, request });
    expect(state.user_request).toBe('Real request');
    expect(JSON.stringify(state)).not.toMatch(/SYSTEM_APPROVAL|MODEL_APPROVAL|TOOL_RESULT|JUSTIFICATION|IMAGE_DATA|justification/);
    expect(bytes).toEqual(original);
  });
  it.each(protocolRequests)('redacts and caps encoded $protocol user input at the semantic boundary', ({ protocol, body }) => {
    const request = extractRequestContext(protocol, new TextEncoder().encode(JSON.stringify(body(
      'client_secret=opaque-private-value ' + 'u'.repeat(1000) + 'UNSEEN_SUFFIX',
    ))));
    expect(request).toBeDefined();
    const state = buildState(action, { ...context, request });
    expect(state.user_request).toHaveLength(1000);
    expect(state.user_request).toContain('[REDACTED:');
    expect(JSON.stringify(state)).not.toMatch(/opaque-private-value|UNSEEN_SUFFIX|MODEL_APPROVAL|TOOL_RESULT/);
  });
  it.each(['anthropic-messages', 'openai-responses', 'openai-chat'] as const)(
    'does not resurrect earlier %s requests after empty or result-only users', protocol => {
      const textType = protocol === 'openai-responses' ? 'input_text' : 'text';
      for (const content of ['', [], [{ type: textType, text: '' }], [{ type: 'tool_result', content: 'TOOL_RESULT' }]]) {
        const messages = [
          { role: 'user', content: 'EARLIER_REQUEST' },
          { role: 'user', content },
          { role: 'assistant', content: 'MODEL_APPROVAL' },
        ];
        const body = protocol === 'openai-responses' ? { input: messages } : { messages };
        const request = extractRequestContext(protocol, new TextEncoder().encode(JSON.stringify(body)));
        expect(request?.lastUserText).toBe('');
        const state = buildState(action, { ...context, lastUserText: 'STALE_FALLBACK', request });
        expect(state.user_request).toBe('');
        expect(JSON.stringify(state)).not.toMatch(/EARLIER_REQUEST|STALE_FALLBACK|TOOL_RESULT|MODEL_APPROVAL/);
      }
    },
  );
  it('preserves an encoded empty Responses string rather than a context fallback', () => {
    const request = extractRequestContext('openai-responses', new TextEncoder().encode('{"input":""}'));
    expect(request?.lastUserText).toBe('');
    expect(buildState(action, { request, lastUserText: 'STALE_FALLBACK' }).user_request).toBe('');
  });
  it.each(['anthropic-messages', 'openai-responses', 'openai-chat'] as const)(
    'rejects malformed encoded %s requests without inventing user text', protocol => {
      for (const raw of ['null', '[]', '{', '"text"']) {
        expect(extractRequestContext(protocol, new TextEncoder().encode(raw))).toBeUndefined();
      }
      expect(extractRequestContext(protocol, new Uint8Array([0xff]))).toBeUndefined();
    },
  );
  it('uses one effective policy for redaction across the complete state', () => {
    const policy = resolvePolicy({ redaction_patterns: [
      { type: 'fixture', pattern: { source: 'CONFIDENTIAL', flags: 'g' }, replacement: 'MASK' },
    ] });
    const request = extractRequestContext('openai-chat', new TextEncoder().encode(JSON.stringify({
      messages: [{ role: 'user', content: 'CONFIDENTIAL' }],
    })));
    const state = buildState({ ...action, kind: 'file_write', paths: ['/CONFIDENTIAL'], content_excerpt: 'CONFIDENTIAL' }, {
      ...context, project_dir: '/CONFIDENTIAL', git_branch: 'CONFIDENTIAL', request,
    }, policy);
    expect(state.user_request).toBe('MASK');
    expect(state.action.content_excerpt).toBe('MASK');
    expect(state.action.path).toEqual(['/MASK']);
    expect(state.environment.project_dir).toBe('/MASK');
    expect(state.environment.git_branch).toBe('MASK');
    expect(JSON.stringify(state)).not.toContain('CONFIDENTIAL');
  });
  it.each(protocolRequests)('applies configured smaller projection caps to encoded $protocol state', ({ protocol, body }) => {
    const policy = resolvePolicy({ user_request_max_chars: 12, write_content_max_bytes: 7 });
    const request = extractRequestContext(protocol, new TextEncoder().encode(JSON.stringify(body('u'.repeat(30)))));
    const state = buildState({ ...action, kind: 'file_write', content_excerpt: 'abcd中尾' }, { ...context, request }, policy);
    expect(state.user_request).toBe('u'.repeat(12));
    expect(state.action.content_excerpt).toBe('abcd中');
    expect(Buffer.byteLength(state.action.content_excerpt ?? '')).toBe(7);
    expect(state.action.content_truncated).toBe(true);
  });
  it('enforces final UTF-8 and user caps even when configured redaction expands text', () => {
    const policy = resolvePolicy({
      user_request_max_chars: 6, write_content_max_bytes: 7,
      redaction_patterns: [{ type: 'fixture', pattern: { source: 'X', flags: 'g' }, replacement: '中'.repeat(10) }],
    });
    const state = buildState({ ...action, kind: 'file_write', content_excerpt: 'X' }, { lastUserText: 'X' }, policy);
    expect(state.user_request).toBe('中'.repeat(6));
    expect(state.action.content_excerpt).toBe('中中');
    expect(state.action.content_truncated).toBe(true);
  });
  it('redacts full write credentials before a visibility cap could split the secret', () => {
    const policy = resolvePolicy({ write_content_max_bytes: 35 });
    const state = buildState({ ...action, kind: 'file_write', content_excerpt: 'x'.repeat(15) + ' client_secret=opaque-private-value' }, context, policy);
    expect(state.action.content_excerpt).not.toContain('opaque');
    expect(Buffer.byteLength(state.action.content_excerpt ?? '')).toBeLessThanOrEqual(35);
    expect(state.action.content_truncated).toBe(true);
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
  it.each([
    ['empty string', ''],
    ['empty block array', []],
    ['empty text block', [{ type: 'text', text: '' }]],
    ['tool-result-only message', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'TOOL_RESULT' }]],
  ])('does not resurrect earlier requests after an encoded Anthropic %s', (_label, content) => {
    const request = anthropicAdapter.extractRequest(new TextEncoder().encode(JSON.stringify({
      model: 'claude-test', stream: false, max_tokens: 128,
      messages: [
        { role: 'user', content: 'EARLIER_REQUEST' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] },
        { role: 'user', content },
      ],
    })));
    expect(request).toBeDefined();
    expect(request?.lastUserText).toBe('');
    const state = buildState(action, { ...context, request });
    expect(state.user_request).toBe('');
    expect(JSON.stringify(state)).not.toMatch(/EARLIER_REQUEST|TOOL_RESULT|MODEL_APPROVAL/);
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
  it.each(['refresh_token', 'client_secret'])('redacts embedded unquoted %s assignments throughout state', (name) => {
    const secret = `opaque-private-${name}-value`;
    const assignment = `${name}=${secret}`;
    const request = anthropicAdapter.extractRequest(new TextEncoder().encode(JSON.stringify({
      model: 'claude-test', max_tokens: 128,
      messages: [{ role: 'user', content: `Inspect this inert assignment: ${assignment}` }],
    })));
    expect(request).toBeDefined();
    const stateContext = { ...context, request, git_branch: `fixture/${assignment}` };
    const commandState = buildState({ ...action, text: `echo ${assignment}` }, stateContext);
    const writeState = buildState({
      ...action, kind: 'file_write', paths: ['/project/fixture.txt'],
      content_excerpt: `inert fixture ${assignment}`,
    }, stateContext);
    for (const value of [commandState.action.command, commandState.user_request,
      commandState.environment.git_branch, writeState.action.content_excerpt, writeState.user_request]) {
      expect(value).toContain('[REDACTED:');
      expect(value).not.toContain(secret);
    }
    expect(JSON.stringify([commandState, writeState])).not.toContain(secret);
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
