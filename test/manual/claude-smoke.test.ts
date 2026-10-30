import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { attachCliProcess, createCliProbeSceneController, observedDenialReturnedToModel, observeMixedContentReplay } from './claude-smoke.js';
import { anthropicSceneResponse, type RecordedRequest, type RelayScene } from '../integration/mock-relay.js';
import { captureMixedContentDelivery, type MixedContentDelivery, type MixedContentProbe } from './claude-smoke.js';
import { observedQaClaudeVersion, observeVersionOverrideRewrite, versionOverrideRewriteQaRoute, type VersionOverrideProbeSource, type VersionOverrideRewriteObservation } from './claude-smoke.js';
import { createClaudeDeliveryState } from '../../src/protocols/anthropic/delivery.js';
import { anthropicAdapter } from '../../src/protocols/anthropic/adapter.js';
import { normalizeClaudeCode } from '../../src/gate/normalize/claude-code.js';
import { createAuditRecord } from '../../src/audit/record.js';
import type { Verdict } from '../../src/gate/types.js';
import type { Config } from '../../src/config/schema.js';

const PROBE = 'printf AMP_DENIAL_PROBE';

// These are process-lifecycle regressions, never actual-Claude acceptance.
describe('manual CLI process lifecycle', () => {
  it('settles output overflow without relying on the independent pipe guardian', async () => {
    // Only a bounded, harmless Node child is launched. Keep it alive until the
    // production observer stops it; its output exceeds the actual 2 MiB bound.
    const child = spawn(process.execPath, ['-e', `
      process.stderr.write(Buffer.alloc(4 * 1024 * 1024, 120));
      setInterval(() => {}, 1000);
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    let outputBoundHit = false;
    let exitObserved = false;
    let guardianFired = false;
    const closed = Promise.withResolvers<void>();
    child.once('close', () => closed.resolve());
    child.once('exit', () => { exitObserved = true; });
    // Handle startup failure without an unhandled error, even before attachment.
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    const destroyOwned = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const guarded = Promise.withResolvers<'guardian'>();
    // This real-process integration needs a platform-clock emergency deadline:
    // fake timers cannot drive OS pipe closure or rescue a stalled child wait.
    const guardian = setTimeout(() => {
      guardianFired = true;
      destroyOwned();
      guarded.resolve('guardian');
    }, 2000);
    const lifecycle = attachCliProcess(child, {
      onLine: () => {},
      onOutputBound: () => { outputBoundHit = true; },
      onExitCode: () => {},
      shouldForceKill: () => outputBoundHit,
    });
    let outcome: 'completed' | 'guardian';
    try {
      outcome = await Promise.race([
        lifecycle.completion.then(() => 'completed' as const),
        guarded.promise,
      ]);
    } finally {
      clearTimeout(guardian);
      // The guardian/cleanup never touches a process group, another child, a
      // listener, or any pipe not created by this test. Dispose even on failure.
      lifecycle.dispose();
      destroyOwned();
      const cleanupDeadline = setTimeout(() => {
        closed.reject(new Error('Owned child did not close after pipe destruction and SIGKILL'));
      }, 1000);
      try { await closed.promise; } finally { clearTimeout(cleanupDeadline); }
    }
    expect(outputBoundHit).toBe(true);
    expect(exitObserved).toBe(true);
    expect(guardianFired, 'observer needed independent destruction of its paused output pipes').toBe(false);
    expect(outcome).toBe('completed');
  }, 7000);

  it('settles overflow with pending dual-pipe output after SIGTERM escalation', async () => {
    // No descendants or substitute CLI: one Node child queues at most 9 MiB.
    // TERM deliberately queues fresh data on BOTH already-paused pipes, then
    // leaves normal production SIGKILL escalation to terminate this child.
    const child = spawn(process.execPath, ['-e', `
      let handledTerm = false;
      process.stdout.on('error', () => {});
      process.stderr.on('error', () => {});
      process.on('SIGTERM', () => {
        if (handledTerm) return;
        handledTerm = true;
        process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 121));
        process.stderr.write(Buffer.alloc(3 * 1024 * 1024, 122));
      });
      process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 120));
      setInterval(() => {}, 1000);
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    let outputBoundHit = false;
    let guardianFired = false;
    let exitBeforeGuardian = false;
    let exitSignal: NodeJS.Signals | null = null;
    const closed = Promise.withResolvers<void>();
    child.once('close', () => closed.resolve());
    child.once('exit', (_code, signal) => {
      exitBeforeGuardian = !guardianFired;
      exitSignal = signal;
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    const destroyOwned = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const guarded = Promise.withResolvers<'guardian'>();
    // Real OS pipe/exit events cannot be advanced with fake timers. This is an
    // emergency ceiling, not a sleep: successful completion cancels it early.
    const guardian = setTimeout(() => {
      guardianFired = true;
      destroyOwned();
      guarded.resolve('guardian');
    }, 3500);
    const lifecycle = attachCliProcess(child, {
      onLine: () => {},
      onOutputBound: () => { outputBoundHit = true; },
      onExitCode: () => {},
      shouldForceKill: () => outputBoundHit,
    });
    let outcome: 'completed' | 'guardian';
    try {
      outcome = await Promise.race([
        lifecycle.completion.then(() => 'completed' as const),
        guarded.promise,
      ]);
    } finally {
      clearTimeout(guardian);
      lifecycle.dispose();
      destroyOwned();
      // Even failure cleanup has its own bounded, rejecting wait. No process
      // group, unrelated child, external listener, or other-owned pipe is used.
      const cleanupDeadline = setTimeout(() => {
        closed.reject(new Error('Pending-output child did not close after owned cleanup'));
      }, 1000);
      try { await closed.promise; } finally { clearTimeout(cleanupDeadline); }
    }
    expect(outputBoundHit).toBe(true);
    expect(exitBeforeGuardian, 'normal escalation must terminate the real child before emergency cleanup').toBe(true);
    expect(exitSignal).toBe('SIGKILL');
    expect(guardianFired, 'real child exited but paused pending stdio prevented observer completion').toBe(false);
    expect(outcome).toBe('completed');
  }, 7000);
});

function request(messages: unknown[]): RecordedRequest {
  return { method: 'POST', path: '/v1/messages', headers: new Headers(), body: { messages } };
}

function history(result: Record<string, unknown>, tool: Record<string, unknown> = {
  type: 'tool_use', id: 'probe_1', name: 'Bash', input: { command: PROBE },
}): RecordedRequest[] {
  return [request([
    { role: 'user', content: `Request exactly ${PROBE}. If denied, acknowledge and do not retry.` },
    { role: 'assistant', content: [tool] },
    { role: 'user', content: [result] },
  ])];
}

describe('manual CLI returned probe denial observation', () => {
  it('does not infer a denial from the original prompt and an innocuous probe result', () => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'probe_1', is_error: false, content: 'AMP_DENIAL_PROBE',
    }))).toBe(false);
  });

  it('does not infer a denial from the original prompt and an unrelated tool result', () => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'read_1', is_error: true, content: 'Permission denied',
    }, { type: 'tool_use', id: 'read_1', name: 'Read', input: { file_path: 'example.txt' } }))).toBe(false);
  });

  it('does not accept denied content with a mismatched probe tool_use_id', () => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'probe_other', is_error: true, content: 'auto-mode-proxy blocked this call',
    }))).toBe(false);
  });

  it('does not accept a correlated error without denial content', () => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'probe_1', is_error: true, content: 'Temporary process error',
    }))).toBe(false);
  });

  it('does not accept denial words from assistant prose beside an innocuous result', () => {
    const requests = history({ type: 'tool_result', tool_use_id: 'probe_1', is_error: false, content: 'OK' });
    const messages = requests[0]!.body.messages as unknown[];
    messages.splice(1, 0, { role: 'assistant', content: 'A different request was denied.' });
    expect(observedDenialReturnedToModel(requests)).toBe(false);
  });

  it('does not accept a successful correlated result even if its content says denied', () => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'probe_1', is_error: false, content: 'denied',
    }))).toBe(false);
  });

  it('does not mistake a different Bash command for the exact harmless probe', () => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'probe_1', is_error: true, content: 'blocked',
    }, { type: 'tool_use', id: 'probe_1', name: 'Bash', input: { command: 'printf unrelated' } }))).toBe(false);
  });

  it.each([
    { content: 'auto-mode-proxy denied the harmless probe' },
    { content: [{ type: 'text', text: 'The requested tool was blocked.' }] },
  ])('observes a correlated probe error with returned denial content: $content', ({ content }) => {
    expect(observedDenialReturnedToModel(history({
      type: 'tool_result', tool_use_id: 'probe_1', is_error: true, content,
    }))).toBe(true);
  });

  it('does not infer a returned denial without a tool result', () => {
    expect(observedDenialReturnedToModel([request([
      { role: 'user', content: 'If denied, acknowledge.' },
    ])])).toBe(false);
  });
});

function sceneRequest(messages: unknown[], tools: unknown[] = [
  { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
]): RecordedRequest {
  const recorded = request(messages);
  recorded.body.tools = tools;
  return recorded;
}

function expectHarmlessProbe(scene: RelayScene): unknown {
  expect(scene.content).toEqual([{
    type: 'tool_use', id: expect.any(String), name: 'Bash', input: { command: PROBE },
  }]);
  return scene.content?.[0]?.id;
}

function expectTextOnly(scene: RelayScene): void {
  expect(scene.content?.length).toBeGreaterThan(0);
  expect(scene.content?.every((block) => block.type === 'text' && typeof block.text === 'string')).toBe(true);
}

describe('manual CLI probe scene controller', () => {
  it('selects the denial probe with wrapped user content and a trailing assistant message', () => {
    const controller = createCliProbeSceneController();
    controller.beginTurn('denial');
    expectHarmlessProbe(controller.sceneForRequest(sceneRequest([
      { role: 'user', content: [{ type: 'text', text: `<system-reminder>Context only</system-reminder>\nSafe denial observation: request exactly ${PROBE}. If denied, acknowledge.` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I will handle that safely.' }] },
    ])));
  });

  it('emits at most one probe through tool-result continuations and repeated requests', () => {
    const controller = createCliProbeSceneController();
    controller.beginTurn('denial');
    const initial = sceneRequest([{ role: 'user', content: `Request ${PROBE} once. If denied, do not retry.` }]);
    const probeId = expectHarmlessProbe(controller.sceneForRequest(initial));
    expectTextOnly(controller.sceneForRequest(sceneRequest([
      ...(initial.body.messages as unknown[]),
      { role: 'assistant', content: [{ type: 'tool_use', id: probeId, name: 'Bash', input: { command: PROBE } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: probeId, is_error: true, content: 'auto-mode-proxy denied this probe' }] },
    ])));
    expectTextOnly(controller.sceneForRequest(initial));
  });

  it('allows a single fresh probe after beginning the next denial turn', () => {
    const controller = createCliProbeSceneController();
    const recorded = sceneRequest([{ role: 'user', content: `Request ${PROBE} once.` }]);
    controller.beginTurn('denial');
    expectHarmlessProbe(controller.sceneForRequest(recorded));
    expectTextOnly(controller.sceneForRequest(recorded));
    controller.beginTurn('denial');
    expectHarmlessProbe(controller.sceneForRequest(recorded));
    expectTextOnly(controller.sceneForRequest(recorded));
  });

  it('keeps normal turns text-only even when history still contains the denial prompt', () => {
    const controller = createCliProbeSceneController();
    const recorded = sceneRequest([
      { role: 'user', content: `Earlier denial observation: request ${PROBE} once. If denied, acknowledge.` },
      { role: 'assistant', content: 'Acknowledged.' },
      { role: 'user', content: 'Normal conversation turn: reply with AMP_NORMAL_TURN_OK. Do not call any tool.' },
    ]);
    controller.beginTurn('normal');
    expectTextOnly(controller.sceneForRequest(recorded));
    expectTextOnly(controller.sceneForRequest(recorded));
  });

  it('does not emit a probe if the request omits its tool declaration', () => {
    const controller = createCliProbeSceneController();
    controller.beginTurn('denial');
    expectTextOnly(controller.sceneForRequest(request([
      { role: 'user', content: `Request ${PROBE} once.` },
    ])));
  });

  it('does not emit a probe when declared tools do not include Bash', () => {
    const controller = createCliProbeSceneController();
    controller.beginTurn('denial');
    expectTextOnly(controller.sceneForRequest(sceneRequest([
      { role: 'user', content: `Request ${PROBE} once.` },
    ], [{ name: 'Read', input_schema: { type: 'object' } }])));
  });
});

function continueProbe(recorded: RecordedRequest, probeId: unknown, result: Record<string, unknown>): RecordedRequest {
  return sceneRequest([
    ...(recorded.body.messages as unknown[]),
    { role: 'assistant', content: [{ type: 'tool_use', id: probeId, name: 'Bash', input: { command: PROBE } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: probeId, ...result }] },
  ]);
}

describe('manual CLI consecutive probe budget', () => {
  it('emits exactly three correlated denied probes and then stops within one human request', () => {
    const controller = createCliProbeSceneController({ consecutiveProbeBudget: 3 });
    controller.beginTurn('denial');
    let recorded = sceneRequest([{ role: 'user', content: `Observe consecutive denials using only ${PROBE}.` }]);
    const ids: unknown[] = [];
    for (let index = 0; index < 3; index++) {
      const id = expectHarmlessProbe(controller.sceneForRequest(recorded));
      ids.push(id);
      recorded = continueProbe(recorded, id, { is_error: true, content: 'auto-mode-proxy denied this harmless probe' });
    }
    expect(new Set(ids).size).toBe(3);
    expectTextOnly(controller.sceneForRequest(recorded));
    expectTextOnly(controller.sceneForRequest(recorded));
  });

  it('does not reissue on the same request or replay an older correlated denial', () => {
    const controller = createCliProbeSceneController({ consecutiveProbeBudget: 3 });
    controller.beginTurn('denial');
    const initial = sceneRequest([{ role: 'user', content: `Request ${PROBE}. If denied, acknowledge.` }]);
    const firstId = expectHarmlessProbe(controller.sceneForRequest(initial));
    expectTextOnly(controller.sceneForRequest(initial));
    const firstDenied = continueProbe(initial, firstId, { is_error: true, content: 'Tool blocked by auto-mode-proxy' });
    const secondId = expectHarmlessProbe(controller.sceneForRequest(firstDenied));
    expect(secondId).not.toBe(firstId);
    expectTextOnly(controller.sceneForRequest(firstDenied));
    expectTextOnly(controller.sceneForRequest(initial));
    const secondDenied = continueProbe(firstDenied, secondId, { is_error: true, content: 'Tool denied' });
    expectHarmlessProbe(controller.sceneForRequest(secondDenied));
  });

  it.each([
    { label: 'missing tool result', result: null },
    { label: 'mismatched tool ID', result: { tool_use_id: 'unrelated', is_error: true, content: 'auto-mode-proxy denied this call' } },
    { label: 'successful result containing denial words', result: { is_error: false, content: 'denied' } },
    { label: 'error without a denial explanation', result: { is_error: true, content: 'Temporary process error' } },
    { label: 'denial content without an error flag', result: { content: 'auto-mode-proxy blocked this call' } },
  ])('does not advance after $label', ({ result }) => {
    const controller = createCliProbeSceneController({ consecutiveProbeBudget: 3 });
    controller.beginTurn('denial');
    const initial = sceneRequest([{ role: 'user', content: `Request ${PROBE}. If denied, acknowledge.` }]);
    const id = expectHarmlessProbe(controller.sceneForRequest(initial));
    const continuation = result === null
      ? sceneRequest([
        ...(initial.body.messages as unknown[]),
        { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: PROBE } }] },
        { role: 'user', content: 'The previous prompt says denied, but no tool result has returned.' },
      ])
      : continueProbe(initial, id, result);
    expectTextOnly(controller.sceneForRequest(continuation));
    expectTextOnly(controller.sceneForRequest(continuation));
  });

  it('filters correlated denial observation to the expected issued probe ID', () => {
    const requests = history({
      type: 'tool_result', tool_use_id: 'probe_1', is_error: true, content: 'auto-mode-proxy denied this probe',
    });
    expect(observedDenialReturnedToModel(requests, 'probe_1')).toBe(true);
    expect(observedDenialReturnedToModel(requests, 'probe_newer')).toBe(false);
  });
});

interface MixedReplayFixture {
  id: string;
  marker: string;
  denial: string;
  tool: Record<string, unknown>;
  result: Record<string, unknown>;
  assistant: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  requests: RecordedRequest[];
  probes: MixedContentProbe[];
  captured: MixedContentDelivery;
  deliveries: Map<string, MixedContentDelivery>;
}

function mixedReplayFixture(delivery: 'native' | 'rewrite'): MixedReplayFixture {
  const id = 'probe_mixed_1';
  const marker = `AMP_TRAILING_TEXT_${id}`;
  const denial = delivery === 'native'
    ? '[auto-mode-proxy] mock-deny; fixed deny decision; risk=0.95'
    : '[auto-mode-proxy] mocked decision. Tool Bash was blocked.';
  const tool = { type: 'tool_use', id, name: 'Bash', input: { command: PROBE } };
  const result: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, is_error: true, content: denial };
  const assistant: Record<string, unknown>[] = [
    delivery === 'native' ? { ...tool } : { type: 'text', text: denial },
    { type: 'text', text: marker },
  ];
  const initialMessages = [{ role: 'user', content: `Safely request ${PROBE} once.` }];
  const messages: Record<string, unknown>[] = [
    ...initialMessages,
    { role: 'assistant', content: assistant },
    delivery === 'native'
      ? { role: 'user', content: [result] }
      : { role: 'user', content: 'Acknowledge the preceding response without any tool.' },
  ];
  const requests = [sceneRequest(initialMessages), sceneRequest(messages)];
  const probes = [{ id, marker, requestIndex: 0 }];
  const texts: Record<number, string> = delivery === 'native' ? { 1: marker } : { 0: denial, 1: marker };
  const captured: MixedContentDelivery = { texts, captureFailed: false };
  if (delivery === 'native') {
    captured.toolUses = { 0: { id, name: tool.name, input: structuredClone(tool.input) } };
    captured.nativeToolResults = { [id]: { type: 'evaluated', outcome: 'flagged', explanation: denial } };
  }
  const deliveries = new Map([[id, captured]]);
  return { id, marker, denial, tool, result, assistant, messages, requests, probes, captured, deliveries };
}

function expectReplayRejected(delivery: 'native' | 'rewrite', fixture: MixedReplayFixture): void {
  const observed = observeMixedContentReplay(delivery, fixture.requests, fixture.probes, fixture.deliveries);
  expect(observed.passed).toBe(false);
  expect(observed.failures.some((failure) => failure.probeId === fixture.id)).toBe(true);
}

describe('manual CLI mixed content replay observer', () => {
  it.each(['native', 'rewrite'] as const)('accepts the actual next-request %s replay correlated to captured delivery', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    const observed = observeMixedContentReplay(delivery, fixture.requests, fixture.probes, fixture.deliveries);
    expect(observed.passed).toBe(true);
    expect(observed.verifiedProbes).toBe(1);
    expect(observed.failures).toEqual([]);
  });

  it('compares the complete emitted native input rather than a fixed command-only fixture', () => {
    const fixture = mixedReplayFixture('native');
    fixture.captured.toolUses![0]!.input = { command: PROBE, run_in_background: false, options: { timeout_ms: 2500 } };
    fixture.assistant[0]!.input = { options: { timeout_ms: 2500 }, run_in_background: false, command: PROBE };
    expect(observeMixedContentReplay('native', fixture.requests, fixture.probes, fixture.deliveries).passed).toBe(true);
  });

  it.each(['native', 'rewrite'] as const)('retains unrelated earlier history when validating the exact %s owner', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    fixture.messages.splice(1, 0,
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier unrelated assistant text' }] },
      { role: 'user', content: 'Earlier unrelated follow-up' });
    expect(observeMixedContentReplay(delivery, fixture.requests, fixture.probes, fixture.deliveries).passed).toBe(true);
  });

  it.each([
    { label: 'wrong tool ID', change: (f: MixedReplayFixture) => { f.assistant[0]!.id = 'different_probe'; } },
    { label: 'wrong Bash command', change: (f: MixedReplayFixture) => { f.assistant[0]!.input = { command: 'printf unrelated' }; } },
    { label: 'added background execution input despite unchanged command', change: (f: MixedReplayFixture) => { f.assistant[0]!.input = { command: PROBE, run_in_background: true }; } },
    { label: 'missing marker', change: (f: MixedReplayFixture) => { f.assistant.pop(); } },
    { label: 'marker preceding the tool', change: (f: MixedReplayFixture) => { f.assistant.reverse(); } },
    { label: 'successful correlated result', change: (f: MixedReplayFixture) => { f.result.is_error = false; } },
    { label: 'mismatched result ID', change: (f: MixedReplayFixture) => { f.result.tool_use_id = 'other_probe'; } },
    { label: 'error without denial explanation', change: (f: MixedReplayFixture) => { f.result.content = 'Temporary process error'; } },
    { label: 'duplicated probe tool', change: (f: MixedReplayFixture) => { f.assistant.push({ ...f.tool }); } },
    { label: 'marker associated with another assistant turn', change: (f: MixedReplayFixture) => {
      f.assistant.pop();
      f.messages.splice(2, 0, { role: 'assistant', content: [{ type: 'text', text: f.marker }] });
    } },
  ])('rejects native replay with $label', ({ change }) => {
    const fixture = mixedReplayFixture('native');
    change(fixture);
    expectReplayRejected('native', fixture);
  });

  it.each([
    { label: 'different denial text', change: (f: MixedReplayFixture) => { f.assistant[0]!.text = 'Another request was denied, not this captured response'; } },
    { label: 'unrelated typed block between exact denial and marker', change: (f: MixedReplayFixture) => { f.assistant.splice(1, 0, { type: 'thinking', thinking: 'Unrelated intervening stateful content' }); } },
    { label: 'unrelated text block between exact denial and marker', change: (f: MixedReplayFixture) => { f.assistant.splice(1, 0, { type: 'text', text: 'Unrelated intervening assistant text' }); } },
    { label: 'altered denial block retaining the captured denial substring', change: (f: MixedReplayFixture) => { f.assistant[0]!.text = `Unrelated prefix ${f.denial}`; } },
    { label: 'altered marker block retaining the exact marker token', change: (f: MixedReplayFixture) => { f.assistant[1]!.text = `${f.marker} unrelated suffix`; } },
    { label: 'missing marker', change: (f: MixedReplayFixture) => { f.assistant.pop(); } },
    { label: 'marker before denial', change: (f: MixedReplayFixture) => { f.assistant.reverse(); } },
    { label: 'surviving emitted tool call', change: (f: MixedReplayFixture) => { f.assistant.push({ ...f.tool }); } },
    { label: 'surviving emitted tool result', change: (f: MixedReplayFixture) => { f.messages[2]!.content = [f.result]; } },
    { label: 'successful emitted result', change: (f: MixedReplayFixture) => {
      f.result.is_error = false;
      f.messages[2]!.content = [f.result];
    } },
    { label: 'denial and marker in separate assistant turns', change: (f: MixedReplayFixture) => {
      f.assistant.pop();
      f.messages.splice(2, 0, { role: 'assistant', content: [{ type: 'text', text: f.marker }] });
    } },
  ])('rejects rewrite replay with $label', ({ change }) => {
    const fixture = mixedReplayFixture('rewrite');
    change(fixture);
    expectReplayRejected('rewrite', fixture);
  });

  // Actual349 preserved two adjacent original text blocks. Diagnostic text
  // joining is not evidence of an SDK serialization/coalescing allowance.
  it.each(['', '\n'])('rejects unsupported rewrite block coalescing with separator %j', (separator) => {
    const fixture = mixedReplayFixture('rewrite');
    fixture.assistant.splice(0, 2, { type: 'text', text: fixture.denial + separator + fixture.marker });
    expectReplayRejected('rewrite', fixture);
  });

  it.each(['native', 'rewrite'] as const)('rejects %s replay when only a later request is correct', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    fixture.requests.splice(1, 0, sceneRequest([{ role: 'user', content: 'Unrelated immediate next request' }]));
    expectReplayRejected(delivery, fixture);
  });

  it.each(['native', 'rewrite'] as const)('rejects %s replay when the marker appears only in the original user prompt', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    fixture.assistant.pop();
    fixture.messages[0]!.content = `Original user prompt mentions ${fixture.marker}, not an assistant replay.`;
    expectReplayRejected(delivery, fixture);
  });

  it.each(['native', 'rewrite'] as const)('rejects %s replay without captured delivered-response evidence', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    fixture.deliveries.clear();
    expectReplayRejected(delivery, fixture);
  });

  it.each(['native', 'rewrite'] as const)('rejects %s replay after delivered-response capture failure', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    fixture.captured.captureFailed = true;
    expectReplayRejected(delivery, fixture);
  });

  it.each(['native', 'rewrite'] as const)('rejects %s replay with a different captured marker', (delivery) => {
    const fixture = mixedReplayFixture(delivery);
    fixture.captured.texts[1] = 'AMP_TRAILING_TEXT_other_probe';
    expectReplayRejected(delivery, fixture);
  });

  it('rejects rewrite denial replay that differs from actual captured proxy text', () => {
    const fixture = mixedReplayFixture('rewrite');
    fixture.captured.texts[0] = '[auto-mode-proxy] A different actual reason. Tool Bash was blocked.';
    expectReplayRejected('rewrite', fixture);
  });

  it('rejects rewrite replay even when a non-proxy denial string matches the captured text', () => {
    const fixture = mixedReplayFixture('rewrite');
    fixture.captured.texts[0] = 'An unrelated request was denied.';
    fixture.assistant[0]!.text = fixture.captured.texts[0];
    expectReplayRejected('rewrite', fixture);
  });

  it('rejects rewrite replay even when captured proxy text lacks a block explanation', () => {
    const fixture = mixedReplayFixture('rewrite');
    fixture.captured.texts[0] = '[auto-mode-proxy] The request completed normally.';
    fixture.assistant[0]!.text = fixture.captured.texts[0];
    expectReplayRejected('rewrite', fixture);
  });
});

describe('manual CLI authoritative native mixed denial', () => {
  it('accepts the exact per-ID flagged proxy explanation preserved in the returned tool result', () => {
    const fixture = mixedReplayFixture('native');
    expect(fixture.captured.nativeToolResults?.[fixture.id]).toEqual({
      type: 'evaluated', outcome: 'flagged', explanation: fixture.denial,
    });
    const observed = observeMixedContentReplay('native', fixture.requests, fixture.probes, fixture.deliveries);
    expect(observed).toEqual({ passed: true, verifiedProbes: 1, failures: [] });
  });

  it.each([
    { label: 'missing complete emitted tool capture', change: (f: MixedReplayFixture) => { delete f.captured.toolUses; } },
    { label: 'different emitted tool identity', change: (f: MixedReplayFixture) => { f.captured.toolUses![0]!.id = 'different_emitted_probe'; } },
    { label: 'different emitted tool name', change: (f: MixedReplayFixture) => { f.captured.toolUses![0]!.name = 'Read'; } },
    { label: 'changed emitted non-command input field', change: (f: MixedReplayFixture) => { f.captured.toolUses![0]!.input = { command: PROBE, run_in_background: true }; } },
    { label: 'missing native result capture', change: (f: MixedReplayFixture) => { delete f.captured.nativeToolResults; } },
    { label: 'native result for a different probe ID', change: (f: MixedReplayFixture) => {
      f.captured.nativeToolResults = { different_probe: { type: 'evaluated', outcome: 'flagged', explanation: f.denial } };
    } },
    { label: 'not_flagged native outcome', change: (f: MixedReplayFixture) => { f.captured.nativeToolResults![f.id]!.outcome = 'not_flagged'; } },
    { label: 'non-evaluated native result', change: (f: MixedReplayFixture) => { f.captured.nativeToolResults![f.id]!.type = 'unavailable'; } },
    { label: 'missing native explanation', change: (f: MixedReplayFixture) => { delete f.captured.nativeToolResults![f.id]!.explanation; } },
    { label: 'empty native explanation', change: (f: MixedReplayFixture) => { f.captured.nativeToolResults![f.id]!.explanation = ''; } },
    { label: 'whitespace-only native explanation', change: (f: MixedReplayFixture) => { f.captured.nativeToolResults![f.id]!.explanation = '   '; } },
    { label: 'non-proxy explanation even when replay matches', change: (f: MixedReplayFixture) => {
      f.captured.nativeToolResults![f.id]!.explanation = 'Permission denied';
      f.result.content = 'Permission denied';
    } },
    { label: 'generic Permission denied tool result', change: (f: MixedReplayFixture) => { f.result.content = 'Permission denied'; } },
    { label: 'different proxy denial tool result', change: (f: MixedReplayFixture) => {
      f.result.content = '[auto-mode-proxy] A different decision blocked another operation';
    } },
    { label: 'different captured authoritative explanation', change: (f: MixedReplayFixture) => {
      f.captured.nativeToolResults![f.id]!.explanation = '[auto-mode-proxy] A different authoritative decision blocked this operation';
    } },
  ])('rejects $label even with correct call ID, command, marker, and error flag', ({ change }) => {
    const fixture = mixedReplayFixture('native');
    change(fixture);
    expectReplayRejected('native', fixture);
  });
});

describe('manual CLI authoritative native SSE capture', () => {
  it('captures the evaluated flagged per-ID explanation from the actual terminal safeguard_results delta', async () => {
    const id = 'probe_native_capture';
    const marker = `AMP_TRAILING_TEXT_${id}`;
    const explanation = '[auto-mode-proxy] mock-deny; fixed deny decision; risk=0.95';
    const nativeToolResults = { [id]: { type: 'evaluated', outcome: 'flagged', explanation } };
    const events = [
      { type: 'message_start', message: { id: 'message_native_capture', type: 'message', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: PROBE }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: marker } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: {
        stop_reason: 'tool_use',
        safeguard_results: [{ type: 'dangerous_tool_use', status: { type: 'available', tool_uses: nativeToolResults } }],
      } },
      { type: 'message_stop' },
    ];
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const captured = await captureMixedContentDelivery(response.clone());
    expect(captured).toEqual({ texts: { 1: marker }, captureFailed: false, nativeToolResults, toolUses: { 0: { id, name: 'Bash', input: { command: PROBE } } } });
    expect(await response.text()).toBe(body);
  });

  function toolInputEvents(): Record<string, unknown>[] {
    return [
      { type: 'message_start', message: { id: 'input_capture', type: 'message', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'probe_input_capture', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: PROBE }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'AMP_TRAILING_TEXT_probe_input_capture' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ];
  }
  function captureEvents(events: Record<string, unknown>[]) {
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return captureMixedContentDelivery(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  }

  it('reconstructs all emitted input fields across JSON deltas before publishing closed tool authority', async () => {
    const events = toolInputEvents();
    const input = { command: PROBE, options: { timeout_ms: 5000 }, run_in_background: false };
    const json = JSON.stringify(input);
    const split = Math.floor(json.length / 2);
    events.splice(2, 1,
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, split) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(split) } });
    const captured = await captureEvents(events);
    expect(captured.captureFailed).toBe(false);
    expect(captured.toolUses).toEqual({ 0: { id: 'probe_input_capture', name: 'Bash', input } });
  });

  it('preserves a complete start input when no JSON deltas are emitted', async () => {
    const events = toolInputEvents();
    const input = { command: PROBE, options: { timeout_ms: 5000 } };
    events[1]!.content_block = { type: 'tool_use', id: 'probe_input_capture', name: 'Bash', input };
    events.splice(2, 1);
    const captured = await captureEvents(events);
    expect(captured.captureFailed).toBe(false);
    expect(captured.toolUses).toEqual({ 0: { id: 'probe_input_capture', name: 'Bash', input } });
  });

  it.each([
    { label: 'missing start input', change: (events: Record<string, unknown>[]) => { events[1]!.content_block = { type: 'tool_use', id: 'probe_input_capture', name: 'Bash' }; } },
    { label: 'missing tool stop', change: (events: Record<string, unknown>[]) => { events.splice(3, 1); } },
    { label: 'delta without tool start', change: (events: Record<string, unknown>[]) => { events.splice(1, 1); } },
    { label: 'delta after tool stop', change: (events: Record<string, unknown>[]) => { events.splice(4, 0, { ...events[2]! }); } },
    { label: 'duplicate closed block index', change: (events: Record<string, unknown>[]) => { events.splice(4, 0, { ...events[1]! }); } },
    { label: 'duplicate emitted tool ID at another index', change: (events: Record<string, unknown>[]) => { events.splice(4, 0, { ...events[1]!, index: 2 }); } },
    { label: 'malformed streamed JSON', change: (events: Record<string, unknown>[]) => { events[2]!.delta = { type: 'input_json_delta', partial_json: '{"command":' }; } },
    { label: 'non-object streamed input', change: (events: Record<string, unknown>[]) => { events[2]!.delta = { type: 'input_json_delta', partial_json: '[]' }; } },
    { label: 'conflicting start input and streamed input', change: (events: Record<string, unknown>[]) => { events[1]!.content_block = { type: 'tool_use', id: 'probe_input_capture', name: 'Bash', input: { command: 'inert conflicting fixture' } }; } },
  ])('does not grant capture authority after $label', async ({ change }) => {
    const events = toolInputEvents();
    change(events);
    expect((await captureEvents(events)).captureFailed).toBe(true);
  });
});

describe('manual CLI mixed content delivered SSE capture', () => {
  it('captures text starts and deltas by actual content-block index', async () => {
    const marker = 'AMP_TRAILING_TEXT_probe_capture';
    const denial = '[auto-mode-proxy] mocked decision. Tool Bash was blocked.';
    const events = [
      { type: 'message_start', message: { id: 'message_capture', type: 'message', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '[auto-mode-proxy]' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' mocked decision. Tool Bash was blocked.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'AMP_TRAILING_' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'TEXT_probe_capture' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ];
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const captured = await captureMixedContentDelivery(response.clone());
    expect(captured).toEqual({ texts: { 0: denial, 1: marker }, captureFailed: false });
    // Observe a delivered clone, leaving the actual client response readable.
    expect(await response.text()).toBe(body);
  });

  it('does not report JSON response bodies as successful streaming capture', async () => {
    const response = Response.json({ content: [{ type: 'text', text: 'AMP_TRAILING_TEXT_probe_capture' }] });
    expect((await captureMixedContentDelivery(response)).captureFailed).toBe(true);
  });
});

interface VersionOverrideQaFixture {
  input: VersionOverrideRewriteObservation;
  sources: Map<string, VersionOverrideProbeSource>;
  captures: Map<string, MixedContentDelivery>;
  auditRecords: Record<string, unknown>[];
  requests: RecordedRequest[];
}

async function versionOverrideQaFixture(): Promise<VersionOverrideQaFixture> {
  const route = versionOverrideRewriteQaRoute();
  const selector = createClaudeDeliveryState();
  const scenes = createCliProbeSceneController({ mixedContent: true });
  const history: unknown[] = [];
  const requests: RecordedRequest[] = [];
  const sources = new Map<string, VersionOverrideProbeSource>();
  const captures = new Map<string, MixedContentDelivery>();
  const auditRecords: Record<string, unknown>[] = [];
  for (let index = 0; index < 3; index++) {
    const user = { role: 'user', content: `Request one fixed harmless QA probe ${index + 1}.` };
    const request = sceneRequest([...history, user]);
    request.headers.set('user-agent', 'claude-cli/2.1.311 (unit-fixture)');
    request.body.stream = true;
    // Synthetic unit data models the observed client dropping safeguards after
    // its first rewrite; later requests must NOT count as override hits.
    if (index === 0) request.body.safeguards = [{ type: 'dangerous_tool_use' }];
    requests.push(request);
    scenes.beginTurn('denial');
    const scene = scenes.sceneForRequest(request);
    const probe = scenes.mixedProbes.at(-1)!;
    const tool = scene.content?.[0];
    if (!tool || tool.type !== 'tool_use') throw new Error('Expected the real safe QA scene');
    sources.set(probe.id, { userAgent: request.headers.get('user-agent'), safeguards: Object.hasOwn(request.body, 'safeguards') });
    const context = anthropicAdapter.extractRequest(new TextEncoder().encode(JSON.stringify(request.body)))!;
    const delivery = selector.select(context, { route: '/cc', version: observedQaClaudeVersion(request.headers.get('user-agent')) ?? undefined }, route);
    const verdict: Verdict = { outcome: 'block', reasons: ['QA fixed deny'], latency_ms: 0, cost_usd: null, policy_version: 'qa-loopback' };
    const transformed = await anthropicAdapter.transformResponse(anthropicSceneResponse({ ...scene, stream: true }, request), context, {
      signal: new AbortController().signal, mode: 'enforce', delivery, onToolCall: async () => verdict,
    });
    const captured = await captureMixedContentDelivery(transformed.clone(), { includeStructure: true });
    await transformed.text();
    captures.set(probe.id, captured);
    auditRecords.push(createAuditRecord({
      action: normalizeClaudeCode({ id: probe.id, name: 'Bash', input: tool.input, raw: tool }, { workdir: '/qa-project' }),
      verdict, route: '/cc', protocol: 'anthropic-messages', agent_hint: 'claude-code/2.1.311', delivery: delivery === 'rewrite' ? 'rewrite' : 'safeguard',
    }));
    history.push(user, { role: 'assistant', content: [
      { type: 'text', text: captured.texts[0] }, { type: 'text', text: captured.texts[1] },
    ] });
    const continuation = { role: 'user', content: `Harmless continuation ${index + 1}; use no tool.` };
    const next = sceneRequest([...history, continuation]);
    requests.push(next);
    scenes.beginTurn('normal');
    const normal = scenes.sceneForRequest(next);
    history.push(continuation, { role: 'assistant', content: normal.content });
  }
  return { input: { route, probes: scenes.mixedProbes, sources, deliveries: captures, auditRecords,
    strictRewriteReplay: observeMixedContentReplay('rewrite', requests, scenes.mixedProbes, captures) },
  sources, captures, auditRecords, requests };
}

describe('manual CLI exact-version override rewrite QA', () => {
  it('uses the existing auto-route exact selector, not an explicit rewrite route or unknown-version downgrade', () => {
    const route = versionOverrideRewriteQaRoute();
    expect(route).toEqual({ claude_delivery: 'auto', claude_delivery_by_version: { '2.1.311': 'rewrite' } });
    const selector = createClaudeDeliveryState();
    const context = { stream: true, safeguards: [{ type: 'dangerous_tool_use' }] };
    expect(selector.select(context, { route: '/cc', version: '2.1.311' }, route)).toBe('rewrite');
    expect(selector.select(context, { route: '/cc', version: '2.1.310' }, route)).toBe('native');
    expect(selector.select(context, { route: '/cc' }, route)).toBe('native');
    expect(selector.select(context, { route: '/cc', version: '2.1.311' }, { ...route, claude_delivery: 'native' })).toBe('native');
  });

  it.each([
    { header: 'claude-cli/2.1.311 (external,cli)', version: '2.1.311' },
    { header: 'claude-code/2.1.311', version: '2.1.311' },
    { header: 'claude-cli/2.1.311-rc.1', version: '2.1.311-rc.1' },
    { header: 'claude-cli/2.1.311garbage', version: null },
    { header: 'model/claude-sonnet-5', version: null },
    { header: null, version: null },
  ])('extracts only observed user-agent version metadata: $header', ({ header, version }) => {
    expect(observedQaClaudeVersion(header)).toBe(version);
  });

  it('proves one genuine override hit and all three strict rewrites without inventing later opt-ins', async () => {
    const fixture = await versionOverrideQaFixture();
    expect(fixture.input.strictRewriteReplay).toEqual({ passed: true, verifiedProbes: 3, failures: [] });
    const observed = observeVersionOverrideRewrite(fixture.input);
    expect(observed.passed).toBe(true);
    expect(observed.configuration).toEqual(versionOverrideRewriteQaRoute());
    expect(observed.provenOverrideHits).toBe(1);
    expect(observed.verifiedRewriteProbes).toBe(3);
    expect(observed.noOptInRewriteProbes).toBe(2);
    expect(observed.probes.map((probe) => probe.selectedBy)).toEqual(['exact_version_override', 'no_original_safeguards', 'no_original_safeguards']);
    expect(observed.probes.every((probe) => probe.observedAgentVersion === '2.1.311' && probe.rewriteAuditBlock && probe.auditServerVersionMatches && probe.capturedRewriteOnly)).toBe(true);
    expect(observed.failures).toEqual([]);
  });

  it.each(['native', 'rewrite'] as const)('cannot call an explicit %s route an exact-version override hit', async (delivery) => {
    const fixture = await versionOverrideQaFixture();
    fixture.input.route = { ...fixture.input.route, claude_delivery: delivery };
    expect(observeVersionOverrideRewrite(fixture.input).passed).toBe(false);
  });

  const invalidOverrideTables: { label: string; overrides: NonNullable<Config['routes'][number]['claude_delivery_by_version']> }[] = [
    { label: 'wrong exact version', overrides: { '2.1.310': 'rewrite' as const } },
    { label: 'wrong selected delivery', overrides: { '2.1.311': 'native' as const } },
    { label: 'broader unrequested version scope', overrides: { '2.1.311': 'rewrite' as const, '2.1.310': 'rewrite' as const } },
  ];
  it.each(invalidOverrideTables)('rejects $label', async ({ overrides }) => {
    const fixture = await versionOverrideQaFixture();
    fixture.input.route = { claude_delivery: 'auto', claude_delivery_by_version: overrides };
    expect(observeVersionOverrideRewrite(fixture.input).passed).toBe(false);
  });

  it.each([null, 'claude-cli/2.1.310', 'claude-cli/2.1.311-rc.1'])('fails an actual source version mismatch even when audits claim the target version: %s', async (userAgent) => {
    const fixture = await versionOverrideQaFixture();
    const id = fixture.input.probes[0]!.id;
    fixture.sources.set(id, { userAgent, safeguards: true });
    expect(observeVersionOverrideRewrite(fixture.input).passed).toBe(false);
  });

  it('fails when every rewrite is explained by missing client opt-in, not the override', async () => {
    const fixture = await versionOverrideQaFixture();
    for (const probe of fixture.input.probes) fixture.sources.set(probe.id, { userAgent: 'claude-cli/2.1.311', safeguards: false });
    const observed = observeVersionOverrideRewrite(fixture.input);
    expect(observed.passed).toBe(false);
    expect(observed.provenOverrideHits).toBe(0);
    expect(observed.failures.some((failure) => failure.reason === 'no_genuine_opt_in_version_override_hit')).toBe(true);
  });

  it.each(['missing', 'wrong-version', 'native-delivery', 'wrong-command', 'duplicate'] as const)('rejects %s per-probe audit provenance despite otherwise valid strict replay', async (kind) => {
    const fixture = await versionOverrideQaFixture();
    const first = fixture.auditRecords[0]!;
    if (kind === 'missing') fixture.auditRecords.shift();
    if (kind === 'wrong-version') first.agent_hint = 'claude-code/2.1.310';
    if (kind === 'native-delivery') first.delivery = 'safeguard';
    if (kind === 'wrong-command') first.action = { raw: { type: 'tool_use', id: fixture.input.probes[0]!.id, name: 'Bash', input: { command: 'printf unrelated' } } };
    if (kind === 'duplicate') fixture.auditRecords.push(first);
    expect(observeVersionOverrideRewrite(fixture.input).passed).toBe(false);
  });

  it.each(['missing-sequence', 'truncated', 'tool-start', 'argument-delta', 'native-result'] as const)('rejects %s wire evidence rather than inferring rewrite from audit totals', async (kind) => {
    const fixture = await versionOverrideQaFixture();
    const captured = fixture.captures.get(fixture.input.probes[0]!.id)!;
    if (kind === 'missing-sequence') delete captured.blockSequence;
    if (kind === 'truncated') captured.omittedSequenceEvents = 1;
    if (kind === 'tool-start') captured.blockSequence!.push({ event: 'start', index: 0, kind: 'tool_use' });
    if (kind === 'argument-delta') captured.blockSequence!.push({ event: 'delta', index: 0, kind: 'input_json_delta' });
    if (kind === 'native-result') captured.nativeToolResults = {};
    expect(observeVersionOverrideRewrite(fixture.input).passed).toBe(false);
  });

  it('requires the unchanged original strict rewrite observer for every marker/replay', async () => {
    const fixture = await versionOverrideQaFixture();
    const target = fixture.input.probes[2]!;
    const next = fixture.requests[target.requestIndex + 1]!;
    const messages = next.body.messages;
    if (!Array.isArray(messages)) throw new Error('Expected generated replay messages');
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !('content' in message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block && typeof block === 'object' && 'text' in block && block.text === target.marker) block.text = 'CORRUPTED_OWN_MARKER';
      }
    }
    fixture.input.strictRewriteReplay = observeMixedContentReplay('rewrite', fixture.requests, fixture.input.probes, fixture.captures);
    expect(fixture.input.strictRewriteReplay.passed).toBe(false);
    expect(observeVersionOverrideRewrite(fixture.input).passed).toBe(false);
  });
});
