import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { attachCliProcess, createCliProbeSceneController, observedDenialReturnedToModel } from './claude-smoke.js';
import type { RecordedRequest, RelayScene } from '../integration/mock-relay.js';

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
