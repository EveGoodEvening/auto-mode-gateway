import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { appendFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { appendFile, link, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_ALLOW_PROBE, CODEX_PROBE, admitCodexFixtureArrival, codexProbeScene, isCanonicalCodexFixtureRequest, observeCodexExecutions, observeCodexReplay, readCodexNativeUsers, withCodexRunDeadline, type CodexCapture, type CodexExecutionEvent, type CodexNativeScope, type CodexRecordedRequest } from './codex-smoke.js';

function fixture(control: 'deny' | 'mixed' = 'deny', lite = false) {
  const declaration = { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } };
  const prefix: Record<string, unknown>[] = [{ type: 'message', id: 'msg_prefix_source', role: 'developer', content: [{ type: 'input_text', text: 'native base instructions' }] }];
  if (lite) prefix.push({ type: 'additional_tools', id: 'at_prefix_source', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [declaration] }] });
  prefix.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'probe' }] });
  const request: CodexRecordedRequest = { arrivalId: 'arrival_source', arrivalOrder: 0, url: 'http://fixture/codex/v1/responses', bodyComplete: true, overlap: false, method: 'POST', path: '/codex/v1/responses', headers: new Headers(), body: { input: prefix, tools: lite ? [] : [declaration] } };
  const { item, positiveItem } = codexProbeScene(request, 'call_probe', 'AMP_AFTER_call_probe', control);
  const denial = { type: 'message', id: 'msg_deny', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '[auto-mode-proxy] blocked: destructive=0.95', annotations: [], logprobs: [] }] };
  const marker = { type: 'message', id: 'msg_after', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'AMP_AFTER_call_probe', annotations: [] }] };
  const output: Record<string, unknown>[] = control === 'mixed' ? [denial, positiveItem!, marker] : [denial, marker];
  const order = control === 'mixed' ? [1, 0, 2] : [0, 1];
  const capture: CodexCapture = { control, requestId: request.arrivalId, requestIndex: 0, probeId: 'call_probe', marker: 'AMP_AFTER_call_probe', sourceItem: item, positiveItem, captureComplete: true,
    events: [...order.map((output_index, sequence_number) => ({ type: 'response.output_item.done', output_index, sequence_number, item: output[output_index] })), { type: 'response.completed', sequence_number: order.length, response: { output } }] };
  const replayPrefix = structuredClone(prefix);
  const replay = [...replayPrefix, ...order.map((index) => structuredClone(output[index]!))];
  if (positiveItem) replay.push({ type: 'function_call_output', call_id: positiveItem.call_id, output: 'Chunk ID: owned\nWall time: 0.0010 seconds\nProcess exited with code 0\nOutput:\nAMP_CODEX_ALLOW_PROBE' });
  const next: CodexRecordedRequest = { ...request, arrivalId: 'arrival_next', arrivalOrder: 1, body: { ...request.body, input: replay } };
  return { requests: [request, next], capture, output, replay, offset: prefix.length };
}

const nativeDirectories = new Set<string>();
const NATIVE_BIRTH_ID = 'msg_22222222-2222-7222-8222-222222222222';
const INTERNAL_USER_ID = '44444444-4444-7444-8444-444444444444';
afterEach(async () => { for (const directory of nativeDirectories) await rm(directory, { recursive: true, force: true }); nativeDirectories.clear(); });

async function nativeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amp-native-identity-test-'));
  nativeDirectories.add(directory);
  const threadId = '11111111-1111-7111-8111-111111111111';
  const firstTurnId = '11111111-1111-7111-8111-111111111112';
  const turnId = '11111111-1111-7111-8111-111111111113';
  const prompt = 'AMP_NORMAL_2: reply with a short text only. Do not execute tools.';
  const sessions = join(directory, 'home', '.codex', 'sessions');
  const sessionDirectory = join(sessions, '2026', '10', '28');
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(join(directory, 'workspace'));
  const path = join(sessionDirectory, `rollout-inert-${threadId}.jsonl`);
  const scope: CodexNativeScope = { directory, threadId, model: 'fixture-direct-model', provider: 'amp', mode: '--yolo', turnCount: 2,
    expected: [{ probeId: 'call_probe', requestId: 'arrival_source', turnOrdinal: 2, prompt }] };
  type NativeRecord = { type: string; payload: Record<string, unknown> };
  const meta: NativeRecord = { type: 'session_meta', payload: { id: threadId, session_id: threadId, cli_version: '0.164.0', source: 'exec', originator: 'codex_exec', model_provider: scope.provider, cwd: join(directory, 'workspace') } };
  const task: NativeRecord = { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } };
  const context: NativeRecord = { type: 'turn_context', payload: { turn_id: turnId, cwd: join(directory, 'workspace'), model: scope.model, approval_policy: 'never', approvals_reviewer: 'user' } };
  const input: NativeRecord = { type: 'response_item', payload: { type: 'message', id: NATIVE_BIRTH_ID, role: 'user', content: [{ type: 'input_text', text: prompt }], internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: 1 } } };
  const userEvent: NativeRecord = { type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId,
    item: { type: 'UserMessage', id: INTERNAL_USER_ID, content: [{ type: 'text', text: prompt, text_elements: [] }] } } };
  const modelOutput: NativeRecord = { type: 'response_item', payload: { type: 'message', id: 'msg_native_output', role: 'assistant', content: [{ type: 'output_text', text: 'inert' }] } };
  const records: NativeRecord[] = [meta,
    { type: 'event_msg', payload: { type: 'task_started', turn_id: firstTurnId } },
    { type: 'turn_context', payload: { turn_id: firstTurnId } },
    { type: 'response_item', payload: { type: 'message', id: 'msg_native_prior', role: 'assistant', content: [] } },
    task, context, input, userEvent, modelOutput,
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
  ];
  const save = async () => { const raw = records.map((record) => JSON.stringify(record)).join('\n') + '\n'; await writeFile(path, raw, { mode: 0o600 }); return raw; };
  await save();
  return { directory, sessions, sessionDirectory, path, scope, records, meta, task, context, input, userEvent, modelOutput, save };
}

function nativeWireFixture(scope: CodexNativeScope) {
  const result = fixture();
  result.capture.expectedNextTurnPrompt = 'AMP_NORMAL_2: reply with a short text only. Do not execute tools.';
  for (const request of result.requests) {
    request.body.model = scope.model;
    request.headers.set('thread-id', scope.threadId); request.headers.set('session-id', scope.threadId);
  }
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: 'AMP_NORMAL_2: reply with a short text only. Do not execute tools.' }];
  const user: Record<string, unknown> = { type: 'message', id: NATIVE_BIRTH_ID, role: 'user', content };
  result.replay.push(user);
  return { ...result, user, content };
}

async function loadNative(scope: CodexNativeScope, alreadyCaptured = 0) {
  let charged = alreadyCaptured;
  const identities = await withCodexRunDeadline((run) => readCodexNativeUsers(scope, run, (bytes) => {
    if (bytes > 8 * 1024 * 1024 - charged) throw new Error('Shared capture bound');
    charged += bytes;
  }));
  return { identities, charged };
}

describe('installed Codex replay evidence boundaries', () => {
  it.each([
    ['ingress', '/codex/v1/responses', 'POST', true],
    ['ingress', '/codex/v1/responses?fixture=1', 'POST', true],
    ['ingress', '/codex/v1/%72esponses', 'POST', false],
    ['ingress', '/codex/v1/respon%73es', 'POST', false],
    ['ingress', '/codex/v1/responses/', 'POST', false],
    ['ingress', '/codex/v1/responses', 'GET', false],
    ['relay', '/v1/responses', 'POST', true],
    ['relay', '/v1/%72esponses', 'POST', false],
    ['relay', '/v1/responses/', 'POST', false],
  ] as const)('does not let Hono-decoded %s %s consume a scene (%s)', async (hop, path, method, allowed) => {
    const app = new Hono();
    let consumed = 0;
    app.all('*', (context) => {
      if (!isCanonicalCodexFixtureRequest(context.req.raw, hop)) return context.json({ admitted: false }, 400);
      consumed++;
      return context.json({ admitted: true });
    });
    const response = await app.fetch(new Request(`http://fixture${path}`, { method }));
    expect(response.status).toBe(allowed ? 200 : 400);
    expect(consumed).toBe(allowed ? 1 : 0);
  });
  it.each(['deny', 'mixed'] as const)('requires exact native typed immediate %s replay, preserving source completion order', (control) => {
    const { requests, capture } = fixture(control);
    expect(observeCodexReplay(requests, capture).passed).toBe(true);
  });
  it.each(['msg', 'at'] as const)('rejects changed stable %s developer prefix identity', (prefix) => {
    const { requests, capture, replay } = fixture('deny', true);
    replay[prefix === 'msg' ? 0 : 1]!.id = `${prefix}_different`;
    expect(observeCodexReplay(requests, capture)).toEqual({ passed: false, reason: 'original_prefix_changed' });
  });
  it.each(['deny', 'mixed'] as const)('accounts for the entire %s immediate replay tail', (control) => {
    for (const tail of ['duplicate-denial', 'duplicate-marker', 'message', 'reasoning', 'developer', 'user']) {
      const { requests, capture, replay, offset } = fixture(control);
      replay.push(tail === 'duplicate-denial' ? structuredClone(replay[offset]!)
        : tail === 'duplicate-marker' ? structuredClone(replay[offset + (control === 'mixed' ? 2 : 1)]!)
        : tail === 'reasoning' ? { type: 'reasoning', summary: [] }
        : { type: 'message', role: tail === 'developer' ? 'developer' : tail === 'user' ? 'user' : 'assistant', content: [{ type: 'input_text', text: 'unexplained' }] });
      expect(observeCodexReplay(requests, capture).passed, tail).toBe(false);
    }
  });
  it('accepts only the independently bound exact next normal-turn user item after denial', async () => {
    const native = await nativeFixture();
    const { identities } = await loadNative(native.scope);
    const { requests, capture, replay, user, content } = nativeWireFixture(native.scope);
    const identity = identities.get(capture.probeId);
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
    expect(observeCodexReplay(requests, capture, identity).passed).toBe(true);
    content[0]!.text = 'different prompt';
    expect(observeCodexReplay(requests, capture, identity).passed).toBe(false);
    content[0]!.text = capture.expectedNextTurnPrompt;
    replay.push(structuredClone(user));
    expect(observeCodexReplay(requests, capture, identity).passed).toBe(false);
  });
  it('does not accept a next-turn user tail for a positive-result continuation', () => {
    const { requests, capture, replay } = fixture('mixed');
    capture.expectedNextTurnPrompt = 'normal';
    replay.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'normal' }] });
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
  });
  it.each([
    ['/codex/v1/%72esponses', 'POST', 'Bearer private-fixture'],
    ['/codex/v1/respon%73es', 'POST', 'Bearer private-fixture'],
    ['/codex/v1/responses/', 'POST', 'Bearer private-fixture'],
    ['/codex/v1/responses', 'GET', 'Bearer private-fixture'],
    ['/codex/v1/responses', 'POST', 'Bearer wrong-fixture'],
    ['/codex/v1/responses', 'POST', ''],
  ])('production admission rejects %s %s before recording arrivals', async (path, method, authorization) => {
    const requests: CodexRecordedRequest[] = [];
    const bodies: string[] = [];
    let bodyReads = 0;
    const app = new Hono();
    app.use('*', async (context, next) => {
      const record = admitCodexFixtureArrival(context.req.raw, 'private-fixture', requests, bodies, false);
      if (typeof record === 'number') return context.json({ error: 'rejected' }, record);
      await next();
    });
    app.all('*', async (context) => { bodyReads++; await context.req.raw.text(); return context.json({ admitted: true }); });
    for (let index = 0; index < 33; index++) {
      const response = await app.fetch(new Request(`http://fixture${path}`, { method, headers: { authorization } }));
      expect(response.status).toBe(401);
    }
    expect(requests).toEqual([]);
    expect(bodies).toEqual([]);
    expect(bodyReads).toBe(0);
    const accepted = await app.fetch(new Request('http://fixture/codex/v1/responses', { method: 'POST', headers: { authorization: 'Bearer private-fixture' } }));
    expect(accepted.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ arrivalOrder: 0, overlap: false, url: 'http://fixture/codex/v1/responses' });
    expect(bodies).toEqual(['']);
    expect(bodyReads).toBe(1);
  });
  it('production admission preserves authenticated overlap before body completion', async () => {
    const requests: CodexRecordedRequest[] = [];
    const bodies: string[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = false;
    const app = new Hono();
    app.use('*', async (context, next) => {
      const record = admitCodexFixtureArrival(context.req.raw, 'private-fixture', requests, bodies, active);
      if (typeof record === 'number') return context.json({ error: 'rejected' }, record);
      if (record.overlap) return context.json({ error: 'overlap' }, 401);
      active = true; entered.resolve();
      try { await next(); } finally { active = false; }
    });
    app.all('*', async (context) => { await release.promise; await context.req.raw.text(); requests[0]!.bodyComplete = true; return context.json({ admitted: true }); });
    const request = () => new Request('http://fixture/codex/v1/responses', { method: 'POST', headers: { authorization: 'Bearer private-fixture' } });
    const first = app.fetch(request());
    await entered.promise;
    const second = await app.fetch(request());
    expect(second.status).toBe(401);
    expect(requests.map((record) => [record.arrivalOrder, record.overlap, record.bodyComplete])).toEqual([[0, false, false], [1, true, false]]);
    expect(bodies).toEqual(['', '']);
    release.resolve();
    expect((await first).status).toBe(200);
  });
  it.each(['missing', 'incomplete', 'wrong-id', 'unsafe-command', 'unseen-argument', 'encrypted-argument', 'wrong-source', 'terminal-mismatch'] as const)('rejects %s evidence', (failure) => {
    const { requests, capture } = fixture();
    if (failure === 'missing') capture.events = [];
    if (failure === 'incomplete') capture.captureComplete = false;
    if (failure === 'wrong-id') capture.sourceItem.call_id = 'different';
    if (failure === 'unsafe-command') capture.sourceItem.arguments = JSON.stringify({ cmd: 'inert-not-allowlisted' });
    if (failure === 'unseen-argument') capture.sourceItem.arguments = JSON.stringify({ cmd: CODEX_PROBE, sandbox_permissions: 'require_escalated' });
    if (failure === 'encrypted-argument') capture.sourceItem.encrypted_function_args = ['opaque'];
    if (failure === 'wrong-source') requests[0]!.body.tools = [];
    if (failure === 'terminal-mismatch') capture.events[0]!.item = { type: 'message', content: [] };
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
  });
  it.each(['wrong-arrival-id', 'reordered-body-completion', 'overlap', 'unfinished-body', 'later-request', 'duplicate-id', 'wrong-next-route', 'encoded-next-url', 'wrong-next-method'] as const)('rejects ambiguous arrival evidence: %s', (failure) => {
    const { requests, capture } = fixture();
    if (failure === 'wrong-arrival-id') capture.requestId = 'different';
    if (failure === 'reordered-body-completion') requests.reverse();
    if (failure === 'overlap') requests[1]!.overlap = true;
    if (failure === 'unfinished-body') requests[1]!.bodyComplete = false;
    if (failure === 'later-request') requests.splice(1, 0, { ...requests[0]!, arrivalId: 'intervening', arrivalOrder: 1, body: { input: [] } });
    if (failure === 'duplicate-id') requests[1] = { ...requests[1]!, arrivalId: requests[0]!.arrivalId };
    if (failure === 'wrong-next-route') requests[1] = { ...requests[1]!, path: '/metadata', url: 'http://fixture/metadata' };
    if (failure === 'encoded-next-url') requests[1] = { ...requests[1]!, url: 'http://fixture/codex/v1/%72esponses' };
    if (failure === 'wrong-next-method') requests[1]!.method = 'GET';
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
  });
  it.each(['reversed', 'changed-reason', 'user-between', 'reasoning-between', 'part-type', 'message-type', 'flattened', 'lost-annotations', 'lost-status', 'lost-phase', 'lost-prefixed-id', 'negative-result', 'prefix-changed'] as const)('never filters or flattens an invalid original replay: %s', (failure) => {
    const { requests, capture, replay, offset } = fixture();
    const denial = replay[offset]!;
    if (failure === 'reversed') [replay[offset], replay[offset + 1]] = [replay[offset + 1]!, replay[offset]!];
    if (failure === 'changed-reason') denial.content = [{ type: 'output_text', text: '[auto-mode-proxy] blocked differently' }];
    if (failure === 'user-between') replay.splice(offset + 1, 0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'intervening' }] });
    if (failure === 'reasoning-between') replay.splice(offset + 1, 0, { type: 'reasoning', summary: [] });
    if (failure === 'part-type') (denial.content as Record<string, unknown>[])[0]!.type = 'input_text';
    if (failure === 'message-type') denial.type = 'agent_message';
    if (failure === 'flattened') denial.content = (denial.content as { text: string }[])[0]!.text;
    if (failure === 'lost-annotations') delete (denial.content as Record<string, unknown>[])[0]!.annotations;
    if (failure === 'lost-status') delete denial.status;
    if (failure === 'lost-phase') delete denial.phase;
    if (failure === 'lost-prefixed-id') delete denial.id;
    if (failure === 'negative-result') replay.push({ type: 'function_call_output', call_id: capture.probeId, output: 'AMP_DENIAL_PROBE' });
    if (failure === 'prefix-changed') replay[0]!.content = [{ type: 'input_text', text: 'different instructions' }];
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
  });
  it('allows only source-proven custom-provider metadata omissions', () => {
    const { requests, capture, output, replay, offset } = fixture();
    output[0]!.encrypted_content = 'opaque metadata';
    output[0]!.internal_chat_message_metadata_passthrough = { turn_id: 'owned' };
    output[0]!.id = 'legacy';
    delete replay[offset]!.id;
    expect(observeCodexReplay(requests, capture).passed).toBe(true);
  });
  it('rejects executable delivery even when the terminal snapshot is safe', () => {
    const { requests, capture } = fixture();
    for (const event of capture.events) event.sequence_number = Number(event.sequence_number) + 1;
    capture.events.unshift({ type: 'response.output_item.added', sequence_number: 0, item: capture.sourceItem });
    expect(observeCodexReplay(requests, capture)).toEqual({ passed: false, reason: 'execution_delivered' });
  });
  it('rejects reversed outgoing sequence despite matching snapshots', () => {
    const { requests, capture } = fixture(); capture.events[1]!.sequence_number = 0;
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
  });
  it('resolves Responses-lite exec_command only from actual additional_tools declarations', () => {
    const { requests, capture } = fixture('mixed', true);
    expect(capture.sourceItem).toMatchObject({ name: 'exec_command', namespace: 'functions' });
    expect(observeCodexReplay(requests, capture).passed).toBe(true);
  });
  it('rejects the actual741 code-mode-only declaration names instead of inventing exec_command', () => {
    const { requests } = fixture('deny', true);
    const request = requests[0]!;
    request.body.model = 'gpt-6.1-sol';
    delete request.body.tools;
    // Sanitized recorded names/types only; no captured headers/history are imported.
    const additional = (request.body.input as Record<string, unknown>[])[1]!;
    additional.tools = [
      { type: 'namespace', name: 'functions', tools: [
        { type: 'custom', name: 'exec' },
        ...['wait', 'request_user_input', 'request_user_input_async'].map((name) => ({ type: 'function', name })),
      ] },
      { type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'sleep' }] },
      { type: 'namespace', name: 'collaboration', tools: ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'].map((name) => ({ type: 'function', name })) },
    ];
    expect(() => codexProbeScene(request, 'inert', 'marker')).toThrow('Codex exec_command declaration missing, ambiguous or unsupported');
  });
  it.each(['absent', 'ambiguous', 'dotted-alias', 'invented-top-namespace'] as const)('does not invent a declaration for %s', (failure) => {
    const { requests } = fixture('deny', failure === 'ambiguous');
    const source = requests[0]!;
    if (failure === 'absent') source.body.tools = [];
    if (failure === 'ambiguous') source.body.tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } }];
    if (failure === 'dotted-alias') (source.body.tools as Record<string, unknown>[])[0]!.name = 'functions.exec_command';
    if (failure === 'invented-top-namespace') source.body.tools = [{ type: 'namespace', name: 'functions', tools: source.body.tools }];
    expect(() => codexProbeScene(source, 'id', 'marker')).toThrow();
  });
  it.each(['index-repaired-replay', 'wrong-done-order', 'negative-leak', 'wrong-positive-call', 'wrong-result-call', 'echo-only-result', 'missing-result'] as const)('rejects unsafe interleaved evidence: %s', (failure) => {
    const { requests, capture, replay, offset } = fixture('mixed');
    if (failure === 'index-repaired-replay') [replay[offset], replay[offset + 1]] = [replay[offset + 1]!, replay[offset]!];
    if (failure === 'wrong-done-order') { capture.events[0]!.output_index = 0; capture.events[1]!.output_index = 1; }
    if (failure === 'negative-leak') replay.push(capture.sourceItem);
    if (failure === 'wrong-positive-call') replay[offset]!.call_id = 'different';
    if (failure === 'wrong-result-call') replay[offset + 3]!.call_id = 'different';
    if (failure === 'echo-only-result') replay[offset + 3]!.output = 'AMP_CODEX_ALLOW_PROBE';
    if (failure === 'missing-result') replay.splice(offset + 3, 1);
    expect(observeCodexReplay(requests, capture).passed).toBe(false);
  });
  it('counts one native terminal success rather than its in-progress snapshot', () => {
    const item = { id: 'item_1', type: 'command_execution', command: `/bin/bash -lc '${CODEX_ALLOW_PROBE}'`, aggregated_output: 'AMP_CODEX_ALLOW_PROBE', exit_code: 0, status: 'completed' };
    const progress = { ...item, aggregated_output: '', exit_code: null, status: 'in_progress' };
    const events: CodexExecutionEvent[] = [
      { eventType: 'item.started', turnKind: 'mixed', item: progress },
      { eventType: 'item.updated', turnKind: 'mixed', item: progress },
      { eventType: 'item.updated', turnKind: 'mixed', item: { ...progress, aggregated_output: 'AMP_CODEX_' } },
      { eventType: 'item.completed', turnKind: 'mixed', item },
    ];
    expect(observeCodexExecutions(events, '/bin/bash')).toEqual({ passed: true, positiveSuccessful: 1, negativeExecutions: 0, unexpectedExecutions: 0 });
  });
  it.each(['negative-turn', 'extra-executor', 'wrong-exit', 'wrong-output', 'extra-command', 'duplicate-execution', 'duplicate-terminal', 'changed-progress-command', 'changed-progress-turn', 'progress-after-terminal', 'unknown-event', 'wrong-progress-status', 'wrong-terminal-status', 'empty-id', 'missing'] as const)('does not count %s as authorized positive execution', (failure) => {
    const event: CodexExecutionEvent = { eventType: 'item.completed', turnKind: 'mixed', item: { id: 'item_1', type: 'command_execution', command: `/bin/bash -lc '${CODEX_ALLOW_PROBE}'`, aggregated_output: 'AMP_CODEX_ALLOW_PROBE', exit_code: 0, status: 'completed' } };
    const events = [event];
    if (failure === 'negative-turn') event.turnKind = 'deny';
    if (failure === 'extra-executor') event.item.command = `/inert/other-shell -lc '${CODEX_ALLOW_PROBE}'`;
    if (failure === 'wrong-exit') event.item.exit_code = 1;
    if (failure === 'wrong-output') event.item.aggregated_output = 'a model repeated AMP_CODEX_ALLOW_PROBE';
    if (failure === 'extra-command') event.item.command = `/bin/bash -lc '${CODEX_ALLOW_PROBE}; printf inert'`;
    if (failure === 'duplicate-execution') events.push({ ...event, item: { ...event.item, id: 'item_2' } });
    if (failure === 'duplicate-terminal') events.push({ ...event, item: { ...event.item } });
    if (failure === 'changed-progress-command') events.unshift({ ...event, eventType: 'item.started', item: { ...event.item, command: `/bin/bash -lc '${CODEX_ALLOW_PROBE}; printf inert'`, status: 'in_progress', exit_code: null } });
    if (failure === 'changed-progress-turn') events.unshift({ ...event, eventType: 'item.started', turnKind: 'allow', item: { ...event.item, status: 'in_progress', exit_code: null } });
    if (failure === 'progress-after-terminal') events.push({ ...event, eventType: 'item.updated', item: { ...event.item, status: 'in_progress', exit_code: null } });
    if (failure === 'unknown-event') event.eventType = 'item.unknown';
    if (failure === 'wrong-progress-status') events.unshift({ ...event, eventType: 'item.started', item: { ...event.item, exit_code: null } });
    if (failure === 'wrong-terminal-status') event.item.status = 'in_progress';
    if (failure === 'empty-id') event.item.id = '';
    if (failure === 'missing') events.length = 0;
    expect(observeCodexExecutions(events, '/bin/bash').passed).toBe(false);
  });
});

describe('native identity production reader', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('controlled FILE-I/O smoke binds producer identity and hashes the exact parsed native bytes', async () => {
    const native = await nativeFixture();
    native.modelOutput.payload.content = [{ type: 'output_text', text: 'inert '.repeat(12 * 1024) }];
    await native.save();
    const original = await readFile(native.path);
    const { identities, charged } = await loadNative(native.scope);
    const identity = identities.get('call_probe');
    expect(identity?.inputId).toBe(NATIVE_BIRTH_ID);
    expect(identity?.inputId).not.toBe(INTERNAL_USER_ID);
    expect(identity?.source).toEqual({ path: native.path, bytes: original.byteLength, sha256: createHash('sha256').update(original).digest('hex') });
    expect(identity!.taskRecordIndex < identity!.contextRecordIndex && identity!.contextRecordIndex < identity!.inputRecordIndex && identity!.inputRecordIndex < identity!.userEventRecordIndex).toBe(true);
    expect(charged).toBeGreaterThan(original.byteLength);
    expect(await readFile(native.path)).toEqual(original);
    const wire = nativeWireFixture(native.scope);
    expect(observeCodexReplay(wire.requests, wire.capture, identity).passed).toBe(true);
  });

  it.each(['session-thread', 'session-provider', 'session-cwd', 'session-version', 'missing-session', 'duplicate-session', 'context-turn', 'context-model', 'context-cwd', 'context-mode', 'duplicate-context', 'missing-input', 'wrong-prompt', 'wrong-user-metadata', 'wrong-ui-thread', 'wrong-ui-turn', 'wrong-ui-prompt', 'wrong-ui-kind', 'missing-ui', 'duplicate-ui', 'duplicate-input', 'duplicate-input-new-id', 'id-collision', 'input-after-ui', 'model-before-input', 'relay-shaped-late-user', 'malformed-birth-id'] as const)('fails closed for native lineage/provenance: %s', async (failure) => {
    const native = await nativeFixture();
    if (failure === 'session-thread') native.meta.payload.id = '99999999-9999-7999-8999-999999999999';
    if (failure === 'session-provider') native.meta.payload.model_provider = 'other';
    if (failure === 'session-cwd') native.meta.payload.cwd = '/outside-owned-workspace';
    if (failure === 'session-version') native.meta.payload.cli_version = 'unverified';
    if (failure === 'missing-session') native.records.splice(native.records.indexOf(native.meta), 1);
    if (failure === 'duplicate-session') native.records.push(structuredClone(native.meta));
    if (failure === 'context-turn') native.context.payload.turn_id = '99999999-9999-7999-8999-999999999999';
    if (failure === 'context-model') native.context.payload.model = 'other';
    if (failure === 'context-cwd') native.context.payload.cwd = '/outside-owned-workspace';
    if (failure === 'context-mode') native.context.payload.approval_policy = 'on-request';
    if (failure === 'duplicate-context') native.records.splice(native.records.indexOf(native.context), 0, structuredClone(native.context));
    if (failure === 'missing-input') native.records.splice(native.records.indexOf(native.input), 1);
    if (failure === 'wrong-prompt') native.input.payload.content = [{ type: 'input_text', text: 'other' }];
    if (failure === 'wrong-user-metadata') native.input.payload.internal_chat_message_metadata_passthrough = { turn_id: '99999999-9999-7999-8999-999999999999' };
    if (failure === 'wrong-ui-thread') native.userEvent.payload.thread_id = '99999999-9999-7999-8999-999999999999';
    if (failure === 'wrong-ui-turn') native.userEvent.payload.turn_id = '99999999-9999-7999-8999-999999999999';
    if (failure === 'wrong-ui-prompt' || failure === 'wrong-ui-kind') native.userEvent.payload.item = { type: failure === 'wrong-ui-kind' ? 'AgentMessage' : 'UserMessage', id: INTERNAL_USER_ID, content: [{ type: 'text', text: 'other', text_elements: [] }] };
    if (failure === 'missing-ui') native.records.splice(native.records.indexOf(native.userEvent), 1);
    if (failure === 'duplicate-ui') native.records.splice(native.records.indexOf(native.userEvent), 0, structuredClone(native.userEvent));
    if (failure === 'duplicate-input' || failure === 'duplicate-input-new-id') {
      const duplicate = structuredClone(native.input);
      if (failure === 'duplicate-input-new-id') duplicate.payload.id = 'msg_66666666-6666-7666-8666-666666666666';
      native.records.push(duplicate);
    }
    if (failure === 'id-collision') native.modelOutput.payload.id = NATIVE_BIRTH_ID;
    if (failure === 'input-after-ui') {
      native.records.splice(native.records.indexOf(native.input), 1);
      native.records.push(native.input);
    }
    if (failure === 'model-before-input') native.records.splice(native.records.indexOf(native.input), 0, structuredClone(native.modelOutput));
    if (failure === 'relay-shaped-late-user') {
      native.records.splice(native.records.indexOf(native.input), 1);
      native.records.splice(native.records.indexOf(native.userEvent), 1);
      native.records.push(native.input, native.userEvent);
    }
    if (failure === 'malformed-birth-id') native.input.payload.id = 'msg_not_a_native_uuid';
    await native.save();
    await expect(loadNative(native.scope)).rejects.toThrow();
  });

  it.each(['late-ui', 'late-context', 'same-prompt-other-turn'] as const)('rejects ambiguity discovered after the valid input window: %s', async (failure) => {
    const native = await nativeFixture();
    native.scope.turnCount = 3;
    const otherTurn = '77777777-7777-7777-8777-777777777777';
    native.records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: otherTurn } }, { type: 'turn_context', payload: { turn_id: otherTurn } });
    if (failure === 'late-context') native.records.push(structuredClone(native.context));
    else {
      const duplicate = structuredClone(native.userEvent);
      if (failure === 'same-prompt-other-turn') duplicate.payload.turn_id = otherTurn;
      native.records.push(duplicate);
    }
    await native.save();
    await expect(loadNative(native.scope)).rejects.toThrow();
  });

  it.each(['duplicate-plan', 'wrong-planned-turn', 'wrong-planned-prompt', 'wrong-owned-thread'] as const)('rejects inconsistent independently supplied provenance: %s', async (failure) => {
    const native = await nativeFixture();
    if (failure === 'duplicate-plan') native.scope.expected = [native.scope.expected[0]!, { ...native.scope.expected[0]! }];
    if (failure === 'wrong-planned-turn') native.scope.expected[0]!.turnOrdinal = 1;
    if (failure === 'wrong-planned-prompt') native.scope.expected[0]!.prompt = 'copied or unrelated prompt';
    if (failure === 'wrong-owned-thread') native.scope.threadId = '99999999-9999-7999-8999-999999999999';
    await expect(loadNative(native.scope)).rejects.toThrow();
  });

  it('never treats a prompt-only caller as native identity even when its user tail is missing', async () => {
    const native = await nativeFixture();
    const wire = nativeWireFixture(native.scope);
    wire.replay.pop();
    expect(observeCodexReplay(wire.requests, wire.capture).passed).toBe(false);
  });

  it('allows non-model native control interleaving without assuming adjacent record indices', async () => {
    const native = await nativeFixture();
    native.records.splice(native.records.indexOf(native.userEvent), 0, { type: 'event_msg', payload: { type: 'token_count' } });
    await native.save();
    const { identities } = await loadNative(native.scope);
    const identity = identities.get('call_probe')!;
    expect(identity.userEventRecordIndex - identity.inputRecordIndex).toBeGreaterThan(1);
    expect(identity.inputId).toBe(NATIVE_BIRTH_ID);
  });

  it.each(['wire-id', 'missing-wire-id', 'missing-tail', 'prefix-id', 'done-id', 'extra-wire-field', 'changed-prompt', 'extra-part', 'extra-message', 'extra-reasoning', 'extra-developer', 'duplicate-tail', 'prefix-collision', 'wrong-thread-header', 'wrong-model', 'forged-proof', 'forged-source-hash'] as const)('preserves complete wire identity/content/count checks: %s', async (failure) => {
    const native = await nativeFixture();
    const { identities } = await loadNative(native.scope);
    const wire = nativeWireFixture(native.scope);
    let identity = identities.get(wire.capture.probeId)!;
    if (failure === 'wire-id') wire.user.id = 'msg_66666666-6666-7666-8666-666666666666';
    if (failure === 'missing-wire-id') delete wire.user.id;
    if (failure === 'missing-tail') wire.replay.pop();
    if (failure === 'prefix-id') wire.replay[0]!.id = 'msg_changed_prefix';
    if (failure === 'done-id') wire.replay[wire.offset]!.id = 'msg_changed_done';
    if (failure === 'extra-wire-field') wire.user.status = 'completed';
    if (failure === 'changed-prompt') wire.content[0]!.text = 'other';
    if (failure === 'extra-part') wire.content.push({ type: 'input_text', text: 'extra' });
    if (failure === 'extra-message') wire.replay.push({ type: 'message', role: 'assistant', content: [] });
    if (failure === 'extra-reasoning') wire.replay.push({ type: 'reasoning', summary: [] });
    if (failure === 'extra-developer') wire.replay.push({ type: 'message', role: 'developer', content: [] });
    if (failure === 'duplicate-tail') wire.replay.push(structuredClone(wire.user));
    if (failure === 'prefix-collision') {
      (wire.requests[0]!.body.input as Record<string, unknown>[])[0]!.id = NATIVE_BIRTH_ID;
      wire.replay[0]!.id = NATIVE_BIRTH_ID;
    }
    if (failure === 'wrong-thread-header') wire.requests[1]!.headers.set('thread-id', '99999999-9999-7999-8999-999999999999');
    if (failure === 'wrong-model') wire.requests[1]!.body.model = 'other';
    if (failure === 'forged-proof') identity = { ...identity };
    if (failure === 'forged-source-hash') identity = { ...identity, source: { ...identity.source, sha256: 'untrusted' } };
    expect(observeCodexReplay(wire.requests, wire.capture, identity).passed).toBe(false);
  });

  it.each(['missing-file', 'duplicate-file', 'file-link', 'directory-link', 'hard-link', 'path-traversal', 'too-many-entries', 'file-cap', 'shared-cap', 'truncated-record', 'malformed-json', 'invalid-utf8', 'changed-size', 'changed-path', 'mid-read-truncation'] as const)('confines and bounds actual native FILE-I/O: %s', async (failure) => {
    const native = await nativeFixture();
    const original = await readFile(native.path);
    let scope = native.scope;
    if (failure === 'missing-file') await unlink(native.path);
    if (failure === 'duplicate-file') await writeFile(join(native.sessionDirectory, `rollout-duplicate-${scope.threadId}.jsonl`), original);
    if (failure === 'file-link' || failure === 'directory-link' || failure === 'hard-link') {
      const outside = await mkdtemp(join(tmpdir(), 'amp-native-outside-test-')); nativeDirectories.add(outside);
      const outsideFile = join(outside, 'outside.jsonl'); await writeFile(outsideFile, original);
      if (failure === 'directory-link') {
        await rename(native.sessions, join(native.directory, 'old-sessions'));
        await symlink(outside, native.sessions, 'dir');
      } else {
        await unlink(native.path);
        if (failure === 'file-link') await symlink(outsideFile, native.path);
        else await link(outsideFile, native.path);
      }
    }
    if (failure === 'path-traversal') scope = { ...scope, directory: scope.directory + '/.' };
    if (failure === 'too-many-entries') for (let index = 0; index < 33; index++) await mkdir(join(native.sessions, String(5000 + index)));
    if (failure === 'file-cap') await truncate(native.path, 8 * 1024 * 1024 + 1);
    if (failure === 'truncated-record') await writeFile(native.path, original.subarray(0, original.length - 1));
    if (failure === 'malformed-json') await appendFile(native.path, '{invalid}\n');
    if (failure === 'invalid-utf8') await appendFile(native.path, Buffer.from([0xff, 10]));
    if (failure === 'changed-size' || failure === 'changed-path' || failure === 'mid-read-truncation') {
      await expect(withCodexRunDeadline((run) => readCodexNativeUsers(scope, run, (cost) => {
        if (cost !== original.byteLength + 1) return;
        if (failure === 'changed-size') appendFileSync(native.path, '{}\n');
        if (failure === 'mid-read-truncation') truncateSync(native.path, 0);
        if (failure === 'changed-path') { renameSync(native.path, native.path + '.old'); writeFileSync(native.path, original); }
      }))).rejects.toThrow();
    } else await expect(loadNative(scope, failure === 'shared-cap' ? 8 * 1024 * 1024 - 1 : 0)).rejects.toThrow();
  });

  it('aborts an owned real file before further read/parse and closes it on expiry', async () => {
    const native = await nativeFixture();
    const original = await readFile(native.path);
    vi.useFakeTimers();
    let expiredAtPreflight = false;
    const result = withCodexRunDeadline((run) => readCodexNativeUsers(native.scope, run, (cost) => {
      if (cost === original.byteLength + 1) { expiredAtPreflight = true; vi.advanceTimersByTime(240_000); }
    }));
    await expect(result).rejects.toThrow();
    expect(expiredAtPreflight).toBe(true);
    expect(await readFile(native.path)).toEqual(original);
  });
});

describe('Codex production whole-run deadline and shutdown', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(['setup', 'post-child capture', 'HTTP completion', 'audit flush', 'evidence write', 'child close'])('bounds stalled %s without a client launch', async (phase) => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    let settled = false;
    const result = withCodexRunDeadline(async (run) => {
      signal = run.signal;
      run.onShutdown(() => { events.push('listener/socket shutdown initiated'); });
      run.onShutdown(() => { events.push('owned child stop initiated'); });
      run.onShutdown(() => { events.push('capture reader cancellation initiated'); });
      events.push(phase); entered.resolve();
      await run.step(() => stalled.promise);
      events.push('FORBIDDEN later turn/mode');
      return true;
    }).then(() => { settled = true; return 'success'; }, () => { settled = true; return 'failure'; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(signal?.aborted).toBe(true);
    expect(events).toEqual([phase, 'listener/socket shutdown initiated', 'owned child stop initiated', 'capture reader cancellation initiated']);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('failure');
    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).not.toContain('FORBIDDEN later turn/mode');
  });

  it('actively cancels a real stalled capture reader before shutdown joins', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const stalledPull = Promise.withResolvers<void>();
    const events: string[] = [];
    const result = withCodexRunDeadline(async (run) => {
      const stream = new ReadableStream<Uint8Array>({
        pull() { entered.resolve(); return stalledPull.promise; },
        cancel() { events.push('reader cancelled'); },
      });
      const reader = stream.getReader();
      run.onShutdown(() => reader.cancel());
      run.onShutdown(() => { events.push('socket shutdown initiated'); });
      await run.step(() => reader.read());
      events.push('FORBIDDEN continuation');
    }).then(() => 'success', () => 'failure');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(events).toEqual(['reader cancelled', 'socket shutdown initiated']);
    expect(await result).toBe('failure');
    stalledPull.resolve();
  });

  it.each(['listener close', 'audit drain', 'child reap'])('never reports success when %s remains unconfirmed during normal teardown', async (resource) => {
    vi.useFakeTimers();
    const stalled = Promise.withResolvers<void>();
    const initiated = Promise.withResolvers<void>();
    const events: string[] = [];
    let settled = false;
    const result = withCodexRunDeadline(async (run) => {
      run.onShutdown(() => { events.push(resource); initiated.resolve(); return stalled.promise; });
      run.onShutdown(() => { events.push('other sockets stopped despite stalled cleanup'); });
      return resource;
    }).then(() => { settled = true; return 'success'; }, () => { settled = true; return 'failure'; });
    await initiated.promise;
    expect(events).toEqual([resource, 'other sockets stopped despite stalled cleanup']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('failure');
    stalled.resolve();
  });

  it('closes late asynchronous startup and prevents post-deadline spawning', async () => {
    vi.useFakeTimers();
    const startup = Promise.withResolvers<{ close(): Promise<void> }>();
    const entered = Promise.withResolvers<void>();
    const events: string[] = [];
    const result = withCodexRunDeadline(async (run) => {
      entered.resolve();
      await run.step(() => startup.promise.then((listener) => {
        run.onShutdown(() => listener.close());
        return listener;
      }));
      run.check();
      events.push('FORBIDDEN child spawn');
    }).then(() => 'success', () => 'failure');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(245_000);
    expect(await result).toBe('failure');
    startup.resolve({ close: async () => { events.push('late listener closed'); } });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['late listener closed']);
  });

  it('waits for confirmed teardown before returning successful evidence', async () => {
    const events: string[] = [];
    const result = await withCodexRunDeadline(async (run) => {
      run.onShutdown(async () => { events.push('listener closed'); });
      run.onShutdown(async () => { events.push('audit drained'); });
      return { passed: true };
    });
    expect(events).toEqual(['listener closed', 'audit drained']);
    expect(result).toEqual({ passed: true });
  });
});
