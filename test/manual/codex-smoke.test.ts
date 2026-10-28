import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CODEX_ALLOW_PROBE, CODEX_PROBE, codexProbeScene, isCanonicalCodexFixtureRequest, observeCodexExecutions, observeCodexReplay, type CodexCapture, type CodexExecutionEvent, type CodexRecordedRequest } from './codex-smoke.js';

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
  replayPrefix[0]!.id = 'msg_prefix_next';
  if (lite) replayPrefix[1]!.id = 'at_prefix_next';
  const replay = [...replayPrefix, ...order.map((index) => structuredClone(output[index]!))];
  if (positiveItem) replay.push({ type: 'function_call_output', call_id: positiveItem.call_id, output: 'Chunk ID: owned\nWall time: 0.0010 seconds\nProcess exited with code 0\nOutput:\nAMP_CODEX_ALLOW_PROBE' });
  const next: CodexRecordedRequest = { ...request, arrivalId: 'arrival_next', arrivalOrder: 1, body: { ...request.body, input: replay } };
  return { requests: [request, next], capture, output, replay, offset: prefix.length };
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
