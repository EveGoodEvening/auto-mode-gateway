import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createMockDecision, type DecisionMode } from './mock-decision.js';
import { createMockRelay, encodeMockEvent, responsesSceneResponse, startLoopback, type RelayScene } from './mock-relay.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const command = (cmd: string, id = 'review') => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd }), status: 'completed' });
const message = (text: string, id = 'msg_marker') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const review = (cmd = 'npm install'): RelayScene => ({ output: [command(cmd)] });
type Item = Record<string, unknown>;
type Snapshot = { id: string; model: string; output: Item[]; usage: typeof usage };
function events(raw: string): Item[] {
  return raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)) as Item);
}
function terminal(frames: Item[]): Snapshot {
  expect(frames.at(-1)?.type).toBe('response.completed');
  return frames.at(-1)!.response as Snapshot;
}
function assertLifecycle(frames: Item[], output: Item[], completedIndices = output.map((_, index) => index)) {
  const sequences = frames.map(frame => frame.sequence_number);
  expect(sequences.every(value => typeof value === 'number' && Number.isInteger(value))).toBe(true);
  for (let index = 1; index < sequences.length; index++) expect(sequences[index] as number).toBeGreaterThan(sequences[index - 1] as number);
  const starts = frames.filter(frame => frame.type === 'response.output_item.added');
  const ends = frames.filter(frame => frame.type === 'response.output_item.done');
  expect(starts.map(frame => frame.output_index)).toEqual(output.map((_, index) => index));
  expect(ends.map(frame => frame.output_index)).toEqual(completedIndices);
  expect(ends.map(frame => frame.item)).toEqual(completedIndices.map(index => output[index]));
  for (const [index, item] of output.entries()) {
    if (item.type !== 'message') continue;
    const chain = frames.filter(frame => frame.output_index === index);
    expect(chain.map(frame => frame.type)).toEqual([
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    ]);
    const content = item.content as { type: string; text: string }[];
    expect(chain[2]?.delta).toBe(content[0]?.text);
    expect(chain[3]?.text).toBe(content[0]?.text);
    expect(chain[4]?.part).toEqual(content[0]);
    expect((chain[0]?.item as Item).id).toBe(item.id);
    for (const frame of chain.slice(1, -1)) expect(frame.item_id).toBe(item.id);
  }
}
async function setup(options: { scene?: string | RelayScene; mode?: 'enforce' | 'shadow'; auth?: 'vault' | 'passthrough'; decision?: DecisionMode; failover?: boolean; allFail?: boolean; upstreamHandler?: (request: Request) => Response; decisionBarrier?: { entered: PromiseWithResolvers<void>; release: Promise<void>; aborted: PromiseWithResolvers<void> }; providerTimeoutMs?: number; transportReadTimeoutMs?: number; onWritePressure?: (outgoing: HttpBindings['outgoing']) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-responses-integration-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const relay = createMockRelay({ protocol: 'openai-responses', scene: options.scene ?? 'bad' });
  const decision = createMockDecision({ mode: options.decision ?? 'keywords', delayMs: options.decision === 'timeout' ? 200 : undefined });
  const second = createMockDecision({ mode: options.allFail ? '5xx' : 'allow' });
  const relayApp = options.upstreamHandler ? new Hono().post('*', context => options.upstreamHandler!(context.req.raw)) : relay.app;
  const decisionApp = options.decisionBarrier ? new Hono().post('*', async context => {
    const barrier = options.decisionBarrier!;
    context.req.raw.signal.addEventListener('abort', () => barrier.aborted.resolve(), { once: true });
    barrier.entered.resolve();
    await barrier.release;
    return decision.app.fetch(context.req.raw);
  }) : decision.app;
  const upstream = await startLoopback(relayApp); cleanups.push(upstream.close);
  const trusted = await startLoopback(decisionApp); cleanups.push(trusted.close);
  const backup = await startLoopback(second.app); cleanups.push(backup.close);
  const config = configSchema.parse({
    auth: { mode: options.auth ?? 'vault', client_tokens: ['fake-client'] },
    routes: [{ prefix: '/codex', protocol: 'openai-responses', upstream: 'relay', project_dirs: ['/project'] }],
    upstreams: { relay: { base_url: upstream.url, api_key: 'fake-relay' } },
    gate: { mode: options.mode ?? 'enforce', provider_timeout_ms: options.providerTimeoutMs ?? 50, hold_keepalive_ms: 10 },
    ...(options.transportReadTimeoutMs === undefined ? {} : { limits: { upstream_read_timeout_ms: options.transportReadTimeoutMs } }),
    decision: { chain: options.failover || options.allFail ? ['decision', 'backup'] : ['decision'], providers: {
      decision: { kind: 'systemone', base_url: trusted.url, model: 'mock', api_key: 'fake-decision' },
      backup: { kind: 'systemone', base_url: backup.url, model: 'mock', api_key: 'fake-backup' },
    }, second_stage: { base_url: trusted.url, model: 'mock-classifier', api_key: 'fake-classifier' } },
    classifier_reroute: { enabled: true }, audit: { path: join(dir, 'audit.jsonl') }, log_level: 'silent',
  });
  const app = createApp(config);
  cleanups.push(app.flushAudit);
  const gatewayApp = options.onWritePressure ? new Hono<{ Bindings: HttpBindings }>().use('*', async (context, next) => {
    const outgoing = context.env.outgoing;
    const original = outgoing.write;
    const spy = vi.spyOn(outgoing, 'write').mockImplementation((...args) => {
      const writable = Reflect.apply(original, outgoing, args) as boolean;
      if (!writable) options.onWritePressure!(outgoing);
      return writable;
    });
    cleanups.push(async () => { spy.mockRestore(); });
    await next();
  }).route('/', app) : app;
  const gateway = await startLoopback(gatewayApp); cleanups.push(gateway.close);
  const responses: Response[] = [];
  cleanups.push(async () => {
    for (const response of responses) if (response.body && !response.bodyUsed && !response.body.locked) await response.body.cancel();
  });
  async function request(body: Item = {}, headers: Record<string, string> = {}) {
    const response = await fetch(`${gateway.url}/codex/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer fake-client', 'content-type': 'application/json', 'user-agent': 'codex_cli_rs/0.164.0', ...headers },
      body: JSON.stringify({ model: 'mock-codex', store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Install dependencies in project' }] }], ...body }),
    });
    responses.push(response);
    return response;
  }
  return { request, relay, decision, second };
}

function controlledUpstream() {
  const ready = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { feed = controller; controller.enqueue(encoder.encode(': connected\n\n')); },
    cancel() { cancelled.resolve(); },
  });
  return {
    ready: ready.promise, cancelled: cancelled.promise,
    handler(request: Request) {
      request.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      ready.resolve();
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
    send(raw: string) { feed.enqueue(encoder.encode(raw)); },
    close() { feed.close(); },
  };
}
async function sourceEvents(output: Item[]): Promise<Item[]> {
  return events(await responsesSceneResponse({ output }, { method: 'POST', path: '/v1/responses', headers: new Headers(), body: { model: 'mock-codex', stream: true } }).text());
}
function wire(frames: Item[]): string {
  return frames.map(frame => encodeMockEvent(String(frame.type), frame)).join('');
}
async function readThrough(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string, initial = ''): Promise<string> {
  let raw = initial;
  const decoder = new TextDecoder();
  while (!raw.includes(marker)) {
    const next = await reader.read();
    if (next.done) throw new Error('HTTP stream ended before expected marker');
    raw += decoder.decode(next.value, { stream: true });
  }
  return raw;
}
async function failedBody(reader: ReadableStreamDefaultReader<Uint8Array>, initial = ''): Promise<string> {
  let raw = initial;
  let failed = false;
  try {
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      raw += decoder.decode(next.value, { stream: true });
    }
  } catch { failed = true; }
  finally { reader.releaseLock(); }
  expect(failed).toBe(true);
  expect(raw).not.toContain('"type":"function_call"');
  expect(raw).not.toContain('"type":"local_shell_call"');
  expect(raw).not.toContain('"type":"custom_tool_call"');
  return raw;
}
function deadlineTrigger(kind: 'idle' | 'completion' | 'decision') {
  const ready = Promise.withResolvers<() => void>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const live = new Map<unknown, { delay: number | undefined; ordinal: number; fire(): void }>();
  let longTimers = 0;
  const matches = (timer: { delay: number | undefined; ordinal: number }) => (kind === 'idle' && typeof timer.delay === 'number' && timer.delay > 29_000 && timer.delay <= 30_000)
    || (kind === 'completion' && timer.delay === 60_000 && timer.ordinal === 1)
    || (kind === 'decision' && timer.delay === 60_000 && timer.ordinal === 2);
  const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    const invoke = () => { live.delete(timer); Reflect.apply(callback, timer, args); };
    const timer = originalSet(invoke, delay);
    if (delay === 60_000) longTimers++;
    const entry = { delay, ordinal: longTimers, fire() { originalClear(timer); invoke(); } };
    live.set(timer, entry);
    if (matches(entry)) ready.resolve(() => {
      const current = [...live.values()].reverse().find(matches);
      expect(current, 'Only an uncleared, live adapter deadline may fire').toBeDefined();
      current!.fire();
    });
    return timer;
  });
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
    live.delete(timer);
    originalClear(timer);
  });
  cleanups.push(async () => { setSpy.mockRestore(); clearSpy.mockRestore(); });
  return ready.promise;
}

describe('Responses actual HTTP enforcement integration', () => {
  it.each([false, true])('rewrites inert destructive exec_command without leaking execution, stream=%s', async stream => {
    const { request } = await setup();
    const response = await request({ stream });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain('rm -rf ~');
    expect(raw).not.toContain('require_escalated');
    expect(raw).not.toContain('"type":"function_call"');
    const frames = stream ? events(raw) : [];
    const body = stream ? terminal(frames) : JSON.parse(raw) as Snapshot;
    expect(body.output).toHaveLength(1);
    expect(body.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: expect.stringContaining('auto-mode-proxy') }] });
    expect(body.usage).toEqual(usage);
    if (stream) assertLifecycle(frames, body.output);
  });
  it.each([false, true])('keeps partially denied parallel output indices, histories and usage, stream=%s', async stream => {
    const { request, relay } = await setup({ scene: 'parallel' });
    const raw = await (await request({ stream })).text();
    const frames = stream ? events(raw) : [];
    const body = stream ? terminal(frames) : JSON.parse(raw) as Snapshot;
    expect(body.output.map(item => item.type)).toEqual(['message', 'function_call', 'message']);
    expect(body.output[1]).toMatchObject({ call_id: 'good', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) });
    expect(JSON.stringify(body.output[2])).toContain('auto-mode-proxy');
    expect(raw).not.toContain('rm -rf ~');
    expect(body.usage).toEqual(usage);
    if (stream) assertLifecycle(frames, body.output);
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'Install dependencies in project' }] },
      ...body.output, { type: 'function_call_output', call_id: 'good', output: '/project' },
      { role: 'user', content: [{ type: 'input_text', text: 'Continue normally' }] },
    ];
    await (await request({ input })).text();
    // This proves the HTTP replay boundary, not actual Codex client replay behavior.
    expect(relay.requests[1]?.body.input).toEqual(input);
    expect(relay.requests[1]?.body.store).toBe(false);
  });
  it.each([false, true])('preserves tool0-marker1 order after replacing the tool, stream=%s', async stream => {
    const { request } = await setup({ scene: { output: [command('npm run AMP_REVIEW_DENY'), message('AFTER_TOOL_MARKER')] } });
    const raw = await (await request({ stream })).text();
    const frames = stream ? events(raw) : [];
    const body = stream ? terminal(frames) : JSON.parse(raw) as Snapshot;
    expect(body.output.map(item => item.type)).toEqual(['message', 'message']);
    expect(JSON.stringify(body.output[0])).toContain('auto-mode-proxy');
    expect(body.output[1]).toEqual(message('AFTER_TOOL_MARKER'));
    if (stream) assertLifecycle(frames, body.output);
  });
  it('preserves distinct start/index and completion orders when positive1 completes before negative0', async () => {
    const positive = command('pwd', 'positive');
    const { request } = await setup({ scene: {
      interleaveFirstTwo: true,
      output: [command('npm run AMP_REVIEW_DENY', 'negative'), positive, message('AFTER_PARALLEL_MARKER')],
    } });
    const frames = events(await (await request({ stream: true })).text());
    const body = terminal(frames);
    expect(body.output.map(item => item.type)).toEqual(['message', 'function_call', 'message']);
    expect(JSON.stringify(body.output[0])).toContain('auto-mode-proxy');
    expect(body.output[1]).toEqual(positive);
    expect(body.output[2]).toEqual(message('AFTER_PARALLEL_MARKER'));
    expect(body.usage).toEqual(usage);
    // Starts stay 0→1→2, but executable completion order remains 1→0→2.
    // This HTTP observer does not establish actual Codex assistant replay order.
    assertLifecycle(frames, body.output, [1, 0, 2]);
  });
  it.each([false, true])('blocks custom patch and local shell execution over HTTP, stream=%s', async stream => {
    const output = [
      { type: 'custom_tool_call', id: 'ct_patch', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: /outside/unsafe.txt\n+inert fixture\n*** End Patch', status: 'completed' },
      { type: 'local_shell_call', id: 'ls_blocked', call_id: 'local', action: { type: 'exec', command: ['sh', '-c', 'rm -rf ~'] }, status: 'completed' },
    ];
    const { request } = await setup({ scene: { output }, decision: 'deny' });
    const raw = await (await request({ stream })).text();
    const frames = stream ? events(raw) : [];
    const body = stream ? terminal(frames) : JSON.parse(raw) as Snapshot;
    expect(body.output.map(item => item.type)).toEqual(['message', 'message']);
    expect(raw).not.toContain('"type":"custom_tool_call"');
    expect(raw).not.toContain('"type":"local_shell_call"');
    expect(raw).not.toContain('rm -rf ~');
    expect(body.usage).toEqual(usage);
    if (stream) assertLifecycle(frames, body.output);
  });
  it.each([false, true])('shadow is byte-identical to the shared upstream response, stream=%s', async stream => {
    const scene = review();
    const { request, relay } = await setup({ scene, mode: 'shadow', decision: 'timeout' });
    const actual = await (await request({ stream })).text();
    expect(actual).toBe(await responsesSceneResponse(scene, relay.requests[0]!).text());
    expect(actual).toContain('exec_command');
  });
  it.each(['vault', 'passthrough'] as const)('uses correct relay credentials and preserves ordinary request headers, auth=%s', async auth => {
    const { request, relay } = await setup({ scene: 'text', auth });
    await (await request({}, { 'x-api-key': 'private-client-key', 'x-request-id': 'responses-test' })).text();
    const observed = relay.requests[0]!;
    expect(observed.path).toBe('/v1/responses');
    expect(observed.headers.get('authorization')).toBe(`Bearer ${auth === 'vault' ? 'fake-relay' : 'fake-client'}`);
    expect(observed.headers.get('x-api-key')).toBe(auth === 'vault' ? null : 'private-client-key');
    expect(observed.headers.get('x-request-id')).toBe('responses-test');
  });
  it('rejects invalid vault credentials before contacting the relay', async () => {
    const { request, relay, decision } = await setup({ scene: 'text' });
    const response = await request({}, { authorization: 'Bearer invalid-client' });
    expect(response.status).toBe(401);
    await response.text();
    expect(relay.requests).toHaveLength(0);
    expect(decision.requests).toHaveLength(0);
  });
  it('does not reroute an Anthropic classifier fingerprint on a Responses route', async () => {
    const { request, relay, decision, second } = await setup({ scene: 'text' });
    const system = [{ type: 'text', text: 'You are a security monitor for autonomous AI coding agents\nEvaluate.' }];
    const input = [{ role: 'system', content: [{ type: 'input_text', text: system[0]!.text }] }];
    const body = await (await request({ system, input })).json() as Snapshot;
    expect(body.id).toBe('resp_mock');
    expect(relay.requests).toHaveLength(1);
    expect(relay.requests[0]?.body).toMatchObject({ system, input, model: 'mock-codex' });
    expect(decision.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
  });
  it.each(['timeout', '429', '529', '5xx'] as const)('blocks when the whole provider chain fails with %s', async decision => {
    const { request, decision: first, second } = await setup({ scene: review(), decision, allFail: true });
    const body = await (await request()).json() as Snapshot;
    expect(first.requests.length).toBeGreaterThan(0);
    expect(second.requests.length).toBeGreaterThan(0);
    expect(body.output[0]?.type).toBe('message');
    expect(JSON.stringify(body.output)).not.toContain('"type":"function_call"');
    expect(JSON.stringify(body.output)).toContain('auto-mode-proxy');
  });
  it('fails over to a successful trusted provider without altering approved arguments', async () => {
    const scene = review();
    const { request, decision, second } = await setup({ scene, decision: '5xx', failover: true });
    const body = await (await request()).json() as Snapshot;
    expect(body.output).toEqual(scene.output);
    expect(decision.requests.length).toBeGreaterThan(0);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.headers.get('authorization')).toBe('Bearer fake-backup');
  });
  it('caches identical reviewed state but not changed latest user input', async () => {
    const { request, decision } = await setup({ scene: review() });
    await (await request()).text(); await (await request()).text();
    expect(decision.requests).toHaveLength(1);
    await (await request({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'Different request' }] }] })).text();
    expect(decision.requests).toHaveLength(2);
  });
  it.each([false, true])('late duplicate call IDs fail the entire turn without releasing even an allowed call, stream=%s', async stream => {
    const { request } = await setup({ scene: 'duplicate-ids' });
    const response = await request({ stream });
    let raw = '';
    if (stream) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let failed = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          raw += decoder.decode(chunk.value, { stream: true });
        }
      } catch { failed = true; }
      finally { reader.releaseLock(); }
      expect(failed).toBe(true);
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400);
      raw = await response.text();
    }
    expect(raw).not.toContain('"type":"function_call"');
    expect(raw).not.toContain('rm -rf ~');
  });
  it('preserves upstream outage status and retry header without asking for a verdict', async () => {
    const { request, decision } = await setup({ scene: 'error' });
    const response = await request();
    expect(response.status).toBe(529);
    expect(response.headers.get('retry-after')).toBe('0');
    expect(await response.json()).toEqual({ error: { type: 'overloaded_error', message: 'inert mock outage' } });
    expect(decision.requests).toHaveLength(0);
  });
});

describe('Responses controlled actual HTTP safety boundaries', () => {
  it('delivers early text and controls while withholding reasoning, unknown state and execution behind a slow verdict', async () => {
    const upstream = controlledUpstream();
    const release = Promise.withResolvers<void>();
    const barrier = { entered: Promise.withResolvers<void>(), release: release.promise, aborted: Promise.withResolvers<void>() };
    const early = message('EARLY_HTTP_MARKER', 'msg_early');
    const reasoning = { type: 'reasoning', id: 'rs_http', encrypted_content: 'ENCRYPTED_HTTP_MARKER', summary: [] };
    const source = await sourceEvents([early, command('npm run AMP_REVIEW_DENY'), reasoning, message('LATE_HTTP_MARKER')]);
    const firstTool = source.findIndex(frame => frame.type === 'response.output_item.added' && frame.output_index === 1);
    const { request } = await setup({ upstreamHandler: upstream.handler, decisionBarrier: barrier, providerTimeoutMs: 120_000 });
    cleanups.push(async () => { release.resolve(); });
    const response = await request({ stream: true });
    const reader = response.body!.getReader();
    upstream.send(wire(source.slice(0, firstTool)));
    let raw = await readThrough(reader, 'EARLY_HTTP_MARKER');
    expect(raw).not.toContain('response.completed');
    upstream.send(wire(source.slice(firstTool, -1)) + encodeMockEvent('vendor.stateful', { type: 'vendor.stateful', payload: 'UNKNOWN_HTTP_MARKER' }) + ': CONTROL_HTTP_COMMENT\n\n' + encodeMockEvent('ping', { type: 'ping', sequence_number: 10_000, probe: 'CONTROL_HTTP_PING' }));
    await barrier.entered.promise;
    raw = await readThrough(reader, 'CONTROL_HTTP_PING', raw);
    expect(raw).toContain('CONTROL_HTTP_COMMENT');
    expect(raw).not.toContain('ENCRYPTED_HTTP_MARKER');
    expect(raw).not.toContain('UNKNOWN_HTTP_MARKER');
    expect(raw).not.toContain('LATE_HTTP_MARKER');
    expect(raw).not.toContain('"type":"function_call"');
    upstream.send(wire(source.slice(-1)));
    upstream.close();
    release.resolve();
    raw = await readThrough(reader, 'response.completed', raw);
    await reader.cancel();
    const outgoing = events(raw);
    expect(terminal(outgoing).output.map(item => item.type)).toEqual(['message', 'message', 'reasoning', 'message']);
    expect(outgoing.find(frame => frame.type === 'response.output_item.done' && frame.output_index === 2)?.item).toEqual(reasoning);
    expect(raw.indexOf('ENCRYPTED_HTTP_MARKER')).toBeLessThan(raw.indexOf('LATE_HTTP_MARKER'));
    expect(raw.indexOf('LATE_HTTP_MARKER')).toBeLessThan(raw.indexOf('UNKNOWN_HTTP_MARKER'));
    const sequence = outgoing.filter(frame => typeof frame.sequence_number === 'number').map(frame => frame.sequence_number as number);
    for (let index = 1; index < sequence.length; index++) expect(sequence[index]).toBeGreaterThan(sequence[index - 1]!);
  });
  it('rewrites a complete response.incomplete snapshot consistently without changing usage', async () => {
    const source = await sourceEvents([command('npm run AMP_REVIEW_DENY')]);
    const final = source.at(-1)!.response as Item;
    source[source.length - 1] = { ...source.at(-1), type: 'response.incomplete', response: { ...final, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } };
    const { request } = await setup({ upstreamHandler: () => new Response(wire(source), { headers: { 'content-type': 'text/event-stream' } }) });
    const outgoing = events(await (await request({ stream: true })).text());
    expect(outgoing.at(-1)?.type).toBe('response.incomplete');
    const snapshot = outgoing.at(-1)!.response as Snapshot & { incomplete_details: unknown };
    expect(snapshot.output[0]?.type).toBe('message');
    expect(snapshot.usage).toEqual(usage);
    expect(snapshot.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    assertLifecycle(outgoing, snapshot.output);
  });
  it('cancels contradictory incomplete terminal execution without releasing an individually allowed item', async () => {
    const upstream = controlledUpstream();
    const source = await sourceEvents([command('pwd')]);
    source[source.length - 1] = { type: 'response.incomplete', response: { status: 'incomplete', output: [command('npm run DIFFERENT_EXECUTION')], usage } };
    const { request } = await setup({ upstreamHandler: upstream.handler });
    const reader = (await request({ stream: true })).body!.getReader();
    upstream.send(wire(source));
    const raw = await failedBody(reader);
    expect(raw).not.toContain('DIFFERENT_EXECUTION');
    await upstream.cancelled;
  });
  it.each(['aggregate', 'reasoning'] as const)('cancels %s retained-representation overflow even below the raw response cap', async kind => {
    const upstream = controlledUpstream();
    const source = await sourceEvents([command('pwd')]);
    const suffix = kind === 'aggregate'
      ? Array.from({ length: 12 }, () => ({ type: 'vendor.stateful', payload: 'x'.repeat(260_000) }))
      : (await sourceEvents(Array.from({ length: 3 }, (_, index) => ({ type: 'reasoning', id: `rs_${index}`, encrypted_content: 'x'.repeat(250_000), summary: [] })))).filter(frame => frame.type === 'response.output_item.added' || frame.type === 'response.output_item.done').map(frame => ({ ...frame, output_index: Number(frame.output_index) + 1 }));
    const rawSource = wire([...source.slice(0, -1), ...suffix]);
    expect(new TextEncoder().encode(rawSource).byteLength).toBeLessThan(8 * 1024 * 1024);
    const { request } = await setup({ upstreamHandler: upstream.handler });
    const reader = (await request({ stream: true })).body!.getReader();
    upstream.send(rawSource);
    await failedBody(reader);
    await upstream.cancelled;
  });
  it.each(['turn', 'frame'] as const)('fails closed on incomplete %s EOF after a complete allowed execution item', async kind => {
    const upstream = controlledUpstream();
    const source = await sourceEvents([command('pwd')]);
    const { request } = await setup({ upstreamHandler: upstream.handler });
    const reader = (await request({ stream: true })).body!.getReader();
    upstream.send(wire(source.slice(0, -1)) + (kind === 'frame' ? 'event: response.completed\ndata: {"type":"response.completed"' : ''));
    upstream.close();
    await failedBody(reader);
  });
  it.each(['idle', 'completion', 'decision'] as const)('cancels HTTP ingress and withholds execution at the independent %s deadline', async kind => {
    const fire = deadlineTrigger(kind);
    const upstream = controlledUpstream();
    const release = Promise.withResolvers<void>();
    const barrier = { entered: Promise.withResolvers<void>(), release: release.promise, aborted: Promise.withResolvers<void>() };
    const source = await sourceEvents([command('npm install')]);
    const { request } = await setup({ upstreamHandler: upstream.handler, decisionBarrier: barrier, providerTimeoutMs: 120_000, transportReadTimeoutMs: 90_000 });
    cleanups.push(async () => { release.resolve(); });
    const reader = (await request({ stream: true })).body!.getReader();
    const failure = failedBody(reader);
    upstream.send(wire(kind === 'idle' ? source.slice(0, 1) : kind === 'completion' ? source.slice(0, 3) : source));
    if (kind === 'decision') {
      await barrier.entered.promise;
      upstream.close();
    }
    (await fire)();
    await failure;
    if (kind === 'decision') await barrier.aborted.promise;
    else await upstream.cancelled;
  });
  it('aborts pending approval and the actual upstream when the HTTP consumer cancels', async () => {
    const upstream = controlledUpstream();
    const release = Promise.withResolvers<void>();
    const barrier = { entered: Promise.withResolvers<void>(), release: release.promise, aborted: Promise.withResolvers<void>() };
    const source = await sourceEvents([command('npm install')]);
    const { request } = await setup({ upstreamHandler: upstream.handler, decisionBarrier: barrier, providerTimeoutMs: 120_000 });
    cleanups.push(async () => { release.resolve(); });
    const reader = (await request({ stream: true })).body!.getReader();
    upstream.send(wire(source.slice(0, -1)) + ': CANCEL_HTTP_BOUNDARY\n\n');
    const raw = await readThrough(reader, 'CANCEL_HTTP_BOUNDARY');
    await barrier.entered.promise;
    expect(raw).not.toContain('"type":"function_call"');
    await reader.cancel();
    await upstream.cancelled;
    await barrier.aborted.promise;
  });
  it('keeps completion cancellation active while the downstream stops reading under backpressure', async () => {
    const fire = deadlineTrigger('completion');
    const upstream = controlledUpstream();
    const source = await sourceEvents([command('pwd')]);
    const observed = Promise.withResolvers<void>();
    let armed = false;
    let consumerResumed = false;
    const { request } = await setup({ upstreamHandler: upstream.handler, transportReadTimeoutMs: 90_000, onWritePressure(outgoing) {
      if (!armed) return;
      armed = false;
      expect(consumerResumed).toBe(false);
      expect(outgoing.writableNeedDrain).toBe(true);
      // Real write() just returned false; drain has not run. Fire from this observed blocked-write slot.
      fireDeadline!();
      observed.resolve();
    } });
    const reader = (await request({ stream: true })).body!.getReader();
    upstream.send(wire(source.slice(0, 3)) + ': BACKPRESSURE_HTTP_BOUNDARY\n\n');
    const raw = await readThrough(reader, 'BACKPRESSURE_HTTP_BOUNDARY');
    const fireDeadline = await fire;
    armed = true;
    upstream.send(Array.from({ length: 128 }, () => `: ${'b'.repeat(65_000)}\n\n`).join(''));
    await observed.promise;
    await upstream.cancelled;
    expect(consumerResumed).toBe(false);
    consumerResumed = true;
    await failedBody(reader, raw);
  });
});

describe('Responses actual HTTP nonstream and shadow safety', () => {
  it.each(['aggregate', 'reasoning'] as const)('rejects nonstream %s retained representations before approval', async kind => {
    const output = [command('npm install'), kind === 'reasoning'
      ? { type: 'reasoning', id: 'rs_nonstream', encrypted_content: 'x'.repeat(1_500_000), summary: [] }
      : message('x'.repeat(3_000_000))];
    const snapshot = { id: 'resp_budget', object: 'response', status: 'completed', output, usage };
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(8 * 1024 * 1024);
    const { request, decision } = await setup({ upstreamHandler: () => Response.json(snapshot) });
    const response = await request();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('"type":"function_call"');
    expect(decision.requests).toHaveLength(0);
  });
  it('finishes byte-identical shadow HTTP delivery before a hypothetical decision resolves', async () => {
    const release = Promise.withResolvers<void>();
    const barrier = { entered: Promise.withResolvers<void>(), release: release.promise, aborted: Promise.withResolvers<void>() };
    const source = wire(await sourceEvents([command('npm install')]));
    const { request } = await setup({ mode: 'shadow', upstreamHandler: () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }), decisionBarrier: barrier, providerTimeoutMs: 120_000 });
    cleanups.push(async () => { release.resolve(); });
    expect(await (await request({ stream: true })).text()).toBe(source);
    await barrier.entered.promise;
    release.resolve();
  });
});

describe('Responses actual HTTP terminal-copy retention boundaries', () => {
  it.each(['aggregate', 'reasoning'] as const)('accepts the complete %s prefix then cancels when only its matching terminal crosses the ledger', async kind => {
    const upstream = controlledUpstream();
    // Source-derived bounded fixtures: four full text snapshots, or two full reasoning snapshots.
    // Their prefix fits; the parser/decoded/parsed terminal copy alone crosses the selected ledger.
    const payload = 'x'.repeat(kind === 'aggregate' ? 430_000 : 335_000);
    const suffix = kind === 'aggregate' ? message(payload) : { type: 'reasoning', id: 'rs_terminal_copy', encrypted_content: payload, summary: [] };
    const source = await sourceEvents([command('pwd'), suffix]);
    const prefix = wire(source.slice(0, -1));
    const final = wire(source.slice(-1));
    expect(new TextEncoder().encode(prefix + final).byteLength).toBeLessThan(8 * 1024 * 1024);
    const { request } = await setup({ upstreamHandler: upstream.handler });
    const reader = (await request({ stream: true })).body!.getReader();
    upstream.send(prefix);
    upstream.send(encodeMockEvent('ping', { type: 'ping', probe: 'PRETERMINAL_RETENTION_FITS' }));
    const raw = await readThrough(reader, 'PRETERMINAL_RETENTION_FITS');
    // This downstream marker is only reachable after all prefix frames were parsed and retained.
    expect(raw).not.toContain('"type":"function_call"');
    expect(raw).not.toContain('response.completed');
    expect(raw).not.toContain(payload);
    upstream.send(final);
    await failedBody(reader, raw);
    await upstream.cancelled;
  });
});
