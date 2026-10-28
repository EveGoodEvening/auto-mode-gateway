import { afterEach, describe, expect, it, vi } from 'vitest';
import scenes from '../fixtures/chat/scenes.json' with { type: 'json' };
import { chatAdapter } from '../../src/protocols/openai-chat/adapter.js';
import { transformChatStream } from '../../src/protocols/openai-chat/stream.js';
import { MAX_TOOL_BYTES, record } from '../../src/protocols/openai-chat/safety.js';
import type { AdapterOptions, RequestContext } from '../../src/protocols/types.js';
import type { Verdict } from '../../src/gate/types.js';

type Event = Record<string, unknown>;
const encoder = new TextEncoder();
const context: RequestContext = { stream: true };
function verdict(outcome: Verdict['outcome'] = 'allow'): Verdict { return { outcome, reasons: ['inert fixture'], latency_ms: 0, cost_usd: 0, policy_version: 'fixture' }; }
function options(): AdapterOptions { return { signal: new AbortController().signal, onToolCall: vi.fn(async () => verdict()) }; }
function source(text: string, split = 31): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text); let cursor = 0;
  return new ReadableStream({ pull(controller) {
    if (cursor >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(cursor, cursor + split)); cursor += split;
  } }, { highWaterMark: 0 });
}
function wire(events: readonly Event[], done = true): string { return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''); }
function chunk(delta: Event, finish_reason: string | null = null): Event { return { id: 'chat_boundary', choices: [{ index: 0, delta, finish_reason }] }; }
function tool(id = 'one', index = 0, args = '{}'): Event { return { index, id, type: 'function', function: { name: 'run_command', arguments: args } }; }
function events(text: string): Event[] {
  return text.split(/\r?\n/u).filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]').map(line => {
    const value: unknown = JSON.parse(line.slice(5)); if (!record(value)) throw new Error('Invalid output'); return value;
  });
}
function choices(text: string): Event[] { return events(text).flatMap(event => Array.isArray(event.choices) ? event.choices.filter(record) : []); }
function deltas(text: string): Event[] { return choices(text).flatMap(choice => record(choice.delta) ? [choice.delta] : []); }
async function collect(input: readonly Event[], config = options(), done = true): Promise<string> { return new Response(transformChatStream(source(wire(input, done)), context, config)).text(); }
async function failure(input: readonly Event[], config = options(), done = true, split = 113): Promise<{ text: string; error: unknown }> {
  const reader = transformChatStream(source(wire(input, done), split), context, config).getReader(); let text = '';
  try { for (;;) { const item = await reader.read(); if (item.done) return { text, error: undefined }; text += new TextDecoder().decode(item.value); } }
  catch (error) { return { text, error }; }
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'x-fixture': 'preserved' } }); }
afterEach(() => vi.useRealTimers());

describe('Chat indexed execution boundary', () => {
  it('aggregates index/id/name/argument fragments while splitting mixed text exactly once', async () => {
    const config = options(); const text = await collect(scenes.single, config);
    expect(config.onToolCall).toHaveBeenCalledOnce();
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'call_one', name: 'run_command', input: { cmd: 'printf inert' } }), context, expect.any(AbortSignal));
    expect(deltas(text).filter(delta => delta.content === 'before')).toHaveLength(1);
    expect(deltas(text).filter(delta => delta.content === 'during')).toHaveLength(1);
    expect(deltas(text).filter(delta => delta.reasoning_content === 'think')).toHaveLength(1);
    expect(events(text).filter(event => event.usage !== undefined)).toHaveLength(1);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });
  it('preserves byte-identical allowed tool-only frames and noncanonical indices', async () => {
    const input = scenes.multiple; const config = options();
    expect(await collect(input, config)).toBe(wire(input));
    expect(config.onToolCall).toHaveBeenCalledTimes(2);
  });
  it('drops only the denied index, explains before finish, retains remaining tool finish', async () => {
    const config = { ...options(), onToolCall: vi.fn(async (call: { id: string }) => verdict(call.id === 'deny' ? 'block' : 'allow')) };
    const text = await collect(scenes.multiple, config);
    const fragments = deltas(text).flatMap(delta => Array.isArray(delta.tool_calls) ? delta.tool_calls : []);
    expect(fragments).toEqual([expect.objectContaining({ index: 1, id: 'allow' })]);
    expect(text).not.toContain('"id":"deny"');
    expect(deltas(text).filter(delta => typeof delta.content === 'string' && delta.content.includes('was blocked'))).toHaveLength(1);
    expect(choices(text).at(-1)?.finish_reason).toBe('tool_calls');
    expect(text.indexOf('was blocked')).toBeLessThan(text.lastIndexOf('"finish_reason":"tool_calls"'));
  });
  it('changes finish to stop only when every call is removed', async () => {
    const text = await collect(scenes.single, { ...options(), onToolCall: async () => verdict('block') });
    expect(deltas(text).some(delta => delta.tool_calls !== undefined)).toBe(false);
    expect(choices(text).at(-1)?.finish_reason).toBe('stop');
    expect(events(text).filter(event => event.usage !== undefined)).toHaveLength(1);
  });
  it('delivers early and mixed nonexecution text before finish or a pending decision', async () => {
    const feed = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { feed.resolve(controller); } });
    const controller = await feed.promise; const config = options();
    const reader = transformChatStream(upstream, context, config).getReader();
    controller.enqueue(encoder.encode(wire([chunk({ content: 'early' })], false)));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('early');
    controller.enqueue(encoder.encode(wire([chunk({ content: 'mixed', reasoning_content: 'reason', tool_calls: [tool()] })], false)));
    const mixed = new TextDecoder().decode((await reader.read()).value);
    expect(mixed).toContain('mixed'); expect(mixed).toContain('reason'); expect(mixed).not.toContain('tool_calls');
    expect(config.onToolCall).not.toHaveBeenCalled(); await reader.cancel();
  });
  it('rejects late duplicate IDs before any callback or executable output', async () => {
    const config = options(); const result = await failure([chunk({ tool_calls: [tool('same', 0), tool('same', 8)] }), chunk({}, 'tool_calls')], config);
    expect(result.error).toBeDefined(); expect(result.text).not.toContain('tool_calls'); expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it.each([
    [chunk({ tool_calls: [tool('one', 0, '{')] }), chunk({}, 'tool_calls')],
    [chunk({ tool_calls: [tool()] }), chunk({}, 'length')],
    [chunk({ function_call: { name: 'run_command', arguments: '{}' } }), chunk({}, 'stop')],
    [{ choices: [{ index: 0, delta: {} }, { index: 1, delta: { tool_calls: [tool()] } }] }],
    [chunk({ tool_calls: [{ ...tool(), type: 'custom' }] }), chunk({}, 'tool_calls')],
    [chunk({ tool_calls: [{ ...tool(), function: { name: 'run_command', arguments: '{}', input: 'concealed' } }] }), chunk({}, 'tool_calls')],
    [chunk({ tool_calls: [tool()] }), chunk({}, 'tool_calls'), chunk({ tool_calls: [tool('late')] })],
  ].map(input => ({ input })))('fails closed malformed/unsupported execution %#', async ({ input }) => {
    const result = await failure(input); expect(result.error).toBeDefined(); expect(result.text).not.toContain('"tool_calls"');
  });
  it('fails on missing finish, missing DONE, and incomplete final SSE frame', async () => {
    expect((await failure([chunk({ tool_calls: [tool()] })], options(), false)).error).toBeDefined();
    expect((await failure([chunk({ tool_calls: [tool()] }), chunk({}, 'tool_calls')], options(), false)).error).toBeDefined();
    await expect(new Response(transformChatStream(source('data: {"choices":'), context, options())).text()).rejects.toThrow();
  });
  it('rejects per-tool oversize without releasing an executable fragment', async () => {
    const result = await failure([chunk({ tool_calls: [tool('one', 0, ' '.repeat(MAX_TOOL_BYTES))] }), chunk({}, 'tool_calls')]);
    expect(result.error).toBeDefined(); expect(result.text).not.toContain('tool_calls');
  });
  it('cancels pending upstream reads and a pending real decision', async () => {
    const decisionStarted = Promise.withResolvers<AbortSignal>(); const cancellation = new AbortController();
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(wire([chunk({ tool_calls: [tool()] }), chunk({}, 'tool_calls')], false))); }, cancel() { cancelled = true; } });
    const reader = transformChatStream(upstream, context, { signal: cancellation.signal, onToolCall: async (_call, _context, signal) => { decisionStarted.resolve(signal); return new Promise<Verdict>(() => {}); } }).getReader();
    const pending = reader.read(); const rejected = expect(pending).rejects.toThrow();
    const decisionSignal = await decisionStarted.promise; cancellation.abort(new Error('fixture cancel')); await rejected;
    expect(decisionSignal.aborted).toBe(true); expect(cancelled).toBe(true);
  });
  it('enforces completion deadline despite nonexecution suffix traffic', async () => {
    vi.useFakeTimers();
    const feed = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        feed.resolve(controller);
        controller.enqueue(encoder.encode(wire([chunk({ content: 'early' }), chunk({ tool_calls: [tool()] })], false)));
      },
      cancel() { cancelled = true; },
    });
    const controller = await feed.promise;
    const config = options();
    const early = Promise.withResolvers<void>();
    const firstSuffix = Promise.withResolvers<void>();
    const secondSuffix = Promise.withResolvers<void>();
    const reader = transformChatStream(upstream, context, config).getReader();
    let text = '';
    let settled = false;
    const pending = (async () => {
      for (;;) {
        const item = await reader.read();
        if (item.done) return;
        text += new TextDecoder().decode(item.value);
        if (text.includes('early')) early.resolve();
        if (text.includes('suffix one')) firstSuffix.resolve();
        if (text.includes('suffix two')) secondSuffix.resolve();
      }
    })();
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(pending).rejects.toThrow();
    await early.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    controller.enqueue(encoder.encode(wire([chunk({ content: 'suffix one' })], false)));
    await firstSuffix.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    controller.enqueue(encoder.encode(wire([chunk({ content: 'suffix two' })], false)));
    await secondSuffix.promise;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false); expect(cancelled).toBe(false);
    expect(text).not.toContain('"tool_calls"'); expect(config.onToolCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(cancelled).toBe(true); expect(text).not.toContain('"tool_calls"'); expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects aggregate retained execution independently of the individual-tool cap', async () => {
    const input = Array.from({ length: 14 }, (_, index) => chunk({ tool_calls: [tool(`call_${index}`, index, JSON.stringify({ payload: 'x'.repeat(160_000) }))] }));
    input.push(chunk({}, 'tool_calls'));
    const config = options(); const result = await failure(input, config, true, 16_384);
    expect(result.error).toBeDefined(); expect(result.text).not.toContain('"tool_calls"'); expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('enforces retained mixed reasoning independently of the aggregate cap', async () => {
    const input = Array.from({ length: 8 }, (_, index) => chunk({ reasoning_content: 'r'.repeat(300_000), tool_calls: [tool(`call_${index}`, index)] }));
    input.push(chunk({}, 'tool_calls'));
    const config = options(); const result = await failure(input, config, true, 16_384);
    expect(result.error).toBeDefined(); expect(result.text).not.toContain('"tool_calls"'); expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('bounds a stalled whole-turn decision after complete input', async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const config = { ...options(), onToolCall: async () => { started.resolve(); return new Promise<Verdict>(() => {}); } };
    const pending = collect([chunk({ tool_calls: [tool()] }), chunk({}, 'tool_calls')], config);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0); await started.promise;
    await vi.advanceTimersByTimeAsync(60_001); await rejected;
  });
  it('keeps shadow byte-identical/nonblocking while observing hypothetical deny', async () => {
    const pending = Promise.withResolvers<Verdict>(); const observations: Promise<void>[] = [];
    const config = { ...options(), mode: 'shadow' as const, onToolCall: vi.fn(async () => pending.promise), trackObservation: (work: Promise<void>) => observations.push(work) };
    const text = await collect(scenes.single, config); expect(text).toBe(wire(scenes.single));
    pending.resolve(verdict('block')); await Promise.all(observations); expect(config.onToolCall).toHaveBeenCalledOnce();
  });
});

describe('Chat nonstream and adapter parity', () => {
  it('retains all original bytes on allow and applies actual partial decisions on deny', async () => {
    const original = JSON.stringify(scenes.nonstream);
    const allowed = await chatAdapter.transformResponse(json(scenes.nonstream), { stream: false }, options());
    expect(await allowed.text()).toBe(original); expect(allowed.headers.get('x-fixture')).toBe('preserved');
    const config = { ...options(), onToolCall: vi.fn(async (call: { id: string }) => verdict(call.id === 'deny' ? 'block' : 'allow')) };
    const denied = await chatAdapter.transformResponse(json(scenes.nonstream), { stream: false }, config);
    const value: unknown = await denied.json();
    expect(value).toMatchObject({ choices: [{ message: { reasoning_content: 'think', tool_calls: [{ id: 'allow' }] }, finish_reason: 'tool_calls' }], usage: scenes.nonstream.usage });
    expect(JSON.stringify(value)).toContain('was blocked'); expect(config.onToolCall).toHaveBeenCalledTimes(2);
  });
  it('removes all nonstream calls and changes finish to stop', async () => {
    const response = await chatAdapter.transformResponse(json(scenes.nonstream), { stream: false }, { ...options(), onToolCall: async () => verdict('block') });
    const value: unknown = await response.json(); expect(value).toMatchObject({ choices: [{ finish_reason: 'stop' }] }); expect(JSON.stringify(value)).not.toContain('"tool_calls"');
  });
  it('rejects multiple choices, duplicate IDs and malformed nonstream tools', async () => {
    for (const value of [
      { choices: [...scenes.nonstream.choices, ...scenes.nonstream.choices] },
      { choices: [{ index: 0, message: { tool_calls: [tool('same'), tool('same')] }, finish_reason: 'tool_calls' }] },
      { choices: [{ index: 0, message: { tool_calls: [{ id: 'one', type: 'function', function: { name: 'run', arguments: '{' } }] }, finish_reason: 'tool_calls' }] },
    ]) await expect(chatAdapter.transformResponse(json(value), { stream: false }, options())).rejects.toThrow();
  });
  it('caps nonstream reasoning representations below the ordinary aggregate cap', async () => {
    const value = { choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'r'.repeat(900_000) }, finish_reason: 'stop' }] };
    const config = options();
    await expect(chatAdapter.transformResponse(json(value), { stream: false }, config)).rejects.toThrow('resource limit');
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('accounts escaped reasoning fields with last-duplicate JSON semantics', async () => {
    const prefix = '{"choices":[{"index":0,"message":{"role":"assistant",';
    const suffix = '},"finish_reason":"stop"}]}';
    const large = JSON.stringify('r'.repeat(900_000));
    const escaped = `"reasoning_\\u0063ontent":${large}`;
    await expect(chatAdapter.transformResponse(new Response(prefix + escaped + suffix, { headers: { 'content-type': 'application/json' } }), { stream: false }, options())).rejects.toThrow('resource limit');
    const original = prefix + escaped + ',"reasoning_content":""' + suffix;
    const response = await chatAdapter.transformResponse(new Response(original, { headers: { 'content-type': 'application/json' } }), { stream: false }, options());
    expect(await response.text()).toBe(original);
  });
  it('rejects unsupported MIME and extracts the existing Chat request context', async () => {
    await expect(chatAdapter.transformResponse(new Response('opaque', { headers: { 'content-type': 'text/plain' } }), context, options())).rejects.toThrow('media type');
    expect(chatAdapter.extractRequest(encoder.encode(JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'hello' }] })))).toMatchObject({ model: 'fixture', stream: true, lastUserText: 'hello' });
  });
});
