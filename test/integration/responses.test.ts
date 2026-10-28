import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { createMockDecision, type DecisionMode } from './mock-decision.js';
import { createMockRelay, responsesSceneResponse, startLoopback, type RelayScene } from './mock-relay.js';

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
async function setup(options: { scene?: string | RelayScene; mode?: 'enforce' | 'shadow'; auth?: 'vault' | 'passthrough'; decision?: DecisionMode; failover?: boolean; allFail?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-responses-integration-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const relay = createMockRelay({ protocol: 'openai-responses', scene: options.scene ?? 'bad' });
  const decision = createMockDecision({ mode: options.decision ?? 'keywords', delayMs: options.decision === 'timeout' ? 200 : undefined });
  const second = createMockDecision({ mode: options.allFail ? '5xx' : 'allow' });
  const upstream = await startLoopback(relay.app); cleanups.push(upstream.close);
  const trusted = await startLoopback(decision.app); cleanups.push(trusted.close);
  const backup = await startLoopback(second.app); cleanups.push(backup.close);
  const config = configSchema.parse({
    auth: { mode: options.auth ?? 'vault', client_tokens: ['fake-client'] },
    routes: [{ prefix: '/codex', protocol: 'openai-responses', upstream: 'relay', project_dirs: ['/project'] }],
    upstreams: { relay: { base_url: upstream.url, api_key: 'fake-relay' } },
    gate: { mode: options.mode ?? 'enforce', provider_timeout_ms: 50, hold_keepalive_ms: 10 },
    decision: { chain: options.failover || options.allFail ? ['decision', 'backup'] : ['decision'], providers: {
      decision: { kind: 'systemone', base_url: trusted.url, model: 'mock', api_key: 'fake-decision' },
      backup: { kind: 'systemone', base_url: backup.url, model: 'mock', api_key: 'fake-backup' },
    }, second_stage: { base_url: trusted.url, model: 'mock-classifier', api_key: 'fake-classifier' } },
    classifier_reroute: { enabled: true }, audit: { path: join(dir, 'audit.jsonl') }, log_level: 'silent',
  });
  const app = createApp(config);
  cleanups.push(app.flushAudit);
  const gateway = await startLoopback(app); cleanups.push(gateway.close);
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
