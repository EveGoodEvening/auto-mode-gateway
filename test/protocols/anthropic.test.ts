import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import scenes from '../fixtures/anthropic/scenes.json' with { type: 'json' };
import { anthropicAdapter, extractAnthropicRequest } from '../../src/protocols/anthropic/adapter.js';
import { extractRequestContext } from '../../src/protocols/request-context.js';
import { transformAnthropicStream } from '../../src/protocols/anthropic/stream.js';
import { transformAnthropicNonstream } from '../../src/protocols/anthropic/nonstream.js';
import { AnthropicResponseError, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES } from '../../src/protocols/anthropic/safety.js';
import type { AdapterOptions, RequestContext } from '../../src/protocols/types.js';

const encoder = new TextEncoder();
const context: RequestContext = { stream: true };
function wire(events: readonly unknown[]): string {
  return events.map(event => {
    if (event === null || typeof event !== 'object' || !('type' in event)) throw new Error('Invalid source fixture');
    return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join('');
}
function source(text: string, chunkSize = 113): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.length);
    },
  }, { highWaterMark: 0 });
}
function options(): AdapterOptions {
  return { signal: new AbortController().signal, onToolCalls: vi.fn(async () => 'allow' as const) };
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}
function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'retry-after': '3' } });
}
function tool(index: number, id: string, input: unknown = {}): unknown {
  return { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'Bash', input } };
}

afterEach(() => vi.useRealTimers());

describe('Anthropic request metadata', () => {
  it('extracts safeguards metadata while preserving the latest tool-result-only user as empty', () => {
    const request = {
      model: 'fixture-model', stream: true, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Bash' }], safeguards: [{ type: 'dangerous_tool_use', classifier_context: { live_cwd: '/fixture', trusted_directories: ['/fixture'] } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Genuine user request' }] },
        { role: 'assistant', content: 'Assistant is not the user' },
        { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Injected tool text' }] }] },
      ],
    };
    const bytes = encoder.encode(JSON.stringify(request));
    const original = bytes.slice();
    expect(extractAnthropicRequest(bytes)).toEqual({ ...request, classifier_context: request.safeguards[0]!.classifier_context, lastUserText: '' });
    expect(anthropicAdapter.extractRequest(bytes)).toEqual(extractRequestContext('anthropic-messages', bytes));
    expect(bytes).toEqual(original);
  });
  it('uses later direct user text and excludes nested tool-result text', () => {
    expect(extractAnthropicRequest(encoder.encode(JSON.stringify({ messages: [
      { role: 'user', content: 'Earlier' },
      { role: 'user', content: [{ type: 'tool_result', content: 'Not user' }, { type: 'text', text: 'Latest' }] },
    ] })))?.lastUserText).toBe('Latest');
  });
  it.each([
    { label: 'empty string', content: '' },
    { label: 'empty blocks', content: [] },
    { label: 'empty text', content: [{ type: 'text', text: '' }] },
    { label: 'tool result', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'TOOL_RESULT' }] }] },
  ])('preserves the latest $label user content', ({ content }) => {
      const bytes = encoder.encode(JSON.stringify({ messages: [
        { role: 'user', content: 'EARLIER_REQUEST' },
        { role: 'user', content },
      ] }));
      expect(extractAnthropicRequest(bytes)?.lastUserText).toBe('');
    },
  );
  it('joins only direct text blocks and does not recurse into result or image objects', () => {
    const bytes = encoder.encode(JSON.stringify({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'first' },
      { type: 'tool_result', content: [{ type: 'text', text: 'TOOL_RESULT' }] },
      { type: 'image', source: { text: 'IMAGE_DATA' } },
      { type: 'input_text', text: 'WRONG_PROTOCOL_TEXT' },
      { type: 'text', text: 'second' },
    ] }] }));
    expect(extractAnthropicRequest(bytes)?.lastUserText).toBe('first\nsecond');
  });
  it.each(['null', '[]', '{', '"text"'])('does not invent metadata for %s', value => {
    expect(extractAnthropicRequest(encoder.encode(value))).toBeUndefined();
  });
});

describe('Anthropic transparent stream', () => {
  it.each(['text', 'thinking', 'single', 'parallel', 'ping', 'error'] as const)('replays %s source bytes exactly', async name => {
    const input = wire(scenes[name]);
    const config = options();
    expect(await collect(transformAnthropicStream(source(input), context, config))).toBe(input);
    if (name === 'single') expect(config.onToolCalls).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'tool_1', name: 'Bash', input: { command: 'echo fixture' } }),
    ], context, expect.any(AbortSignal));
    if (name === 'parallel') expect(config.onToolCalls).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'tool_a', input: { path: 'fixture.txt' } }),
      expect.objectContaining({ id: 'tool_b', input: { command: 'echo fixture' } }),
    ]), context, expect.any(AbortSignal));
    if (name !== 'single' && name !== 'parallel') expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('preserves source CRLF, comments, id/retry, multiline data and unknown events', async () => {
    const input = await readFile(new URL('../fixtures/anthropic/raw.sse', import.meta.url), 'utf8');
    expect(await collect(transformAnthropicStream(source(input, 1), context, options()))).toBe(input);
  });
  it.each([1, 2, 7, 31, 4096])('handles execution fragments split every %i bytes', async size => {
    const input = wire(scenes.single);
    expect(await collect(transformAnthropicStream(source(input, size), context, options()))).toBe(input);
  });
  it('passes text/thinking/ping immediately while all execution remains private pending explicit approval', async () => {
    const decision = Promise.withResolvers<'allow' | 'block'>();
    const config = options();
    config.onToolCalls = vi.fn(() => decision.promise);
    const output = transformAnthropicStream(source(wire([
      scenes.single[0], { ...scenes.text[2], index: 1 }, { ...scenes.thinking[1], index: 2 }, scenes.ping[0], ...scenes.single.slice(1),
    ])), context, config).getReader();
    const emitted: string[] = [];
    for (let i = 0; i < 3; i++) emitted.push(new TextDecoder().decode((await output.read()).value));
    expect(emitted.join('')).not.toContain('tool_use');
    expect(emitted.join('')).toContain('text_delta');
    expect(emitted.join('')).toContain('thinking_delta');
    expect(emitted.join('')).toContain('ping');
    const pending = output.read();
    await vi.waitFor(() => expect(config.onToolCalls).toHaveBeenCalledOnce());
    decision.resolve('allow');
    expect(new TextDecoder().decode((await pending).value)).toContain('tool_use');
    await output.cancel();
  });
  it('marks partial JSON unparseable with diagnostics and never calls allow', async () => {
    const config = options();
    await expect(collect(transformAnthropicStream(source(wire(scenes.incomplete)), context, config)))
      .rejects.toMatchObject({ blocked: true, parseStatus: 'unparseable', diagnostic: { command: 'echo fixture' } });
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('rejects complete tool_use in message_start content without execution bytes or approval', async () => {
    const config = options();
    const input = wire([
      { type: 'message_start', message: { id: 'msg_snapshot', type: 'message', content: [
        { type: 'tool_use', id: 'snapshot_tool', name: 'Read', input: { path: 'fixture.txt' } },
      ] } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
    const output = transformAnthropicStream(source(input), context, config).getReader();
    const emitted: string[] = [];
    const result = (async () => {
      for (;;) {
        const { done, value } = await output.read();
        if (done) return;
        emitted.push(new TextDecoder().decode(value));
      }
    })();
    await expect(result).rejects.toBeInstanceOf(AnthropicResponseError);
    expect(emitted.join('')).not.toContain('tool_use');
    expect(emitted.join('')).not.toContain('snapshot_tool');
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it.each([
    [scenes.single[0]],
    scenes.single.slice(0, -1),
    [tool(0, 'x'), { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[]' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }],
    [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }],
  ].map(events => ({ events })))('fails closed for incomplete or invalid execution $events', async ({ events }) => {
    const config = options();
    await expect(collect(transformAnthropicStream(source(wire(events)), context, config))).rejects.toBeInstanceOf(AnthropicResponseError);
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('rejects incomplete SSE frames without leaking possible execution', async () => {
    await expect(collect(transformAnthropicStream(source(wire([scenes.single[0]]).trimEnd()), context, options()))).rejects.toMatchObject({ blocked: true });
  });
  it('holds earlier complete execution through whole-response duplicate detection', async () => {
    const config = options();
    const events = [...scenes.single.slice(0, -2), tool(1, 'tool_1'), { type: 'content_block_stop', index: 1 }, { type: 'message_stop' }];
    await expect(collect(transformAnthropicStream(source(wire(events)), context, config))).rejects.toThrow('Duplicate');
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('does not release any execution if the explicit callback blocks', async () => {
    const config = options();
    config.onToolCalls = vi.fn<AdapterOptions['onToolCalls']>(async () => 'block');
    await expect(collect(transformAnthropicStream(source(wire(scenes.single)), context, config))).rejects.toThrow('blocked');
  });
  it('enforces 1 MiB per tool across many small delta frames', async () => {
    const config = options();
    const delta = { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(128 * 1024) } };
    await expect(collect(transformAnthropicStream(source(wire([tool(0, 'large'), ...Array.from({ length: 9 }, () => delta)]), 65536), context, config))).rejects.toThrow('1 MiB');
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('enforces 8 MiB total held frames and arguments', async () => {
    const events: unknown[] = [];
    for (let index = 0; index < 12; index++) events.push(tool(index, `tool_${index}`, { text: 'x'.repeat(750 * 1024) }), { type: 'content_block_stop', index });
    events.push({ type: 'message_stop' });
    const config = options();
    await expect(collect(transformAnthropicStream(source(wire(events), 65536), context, config))).rejects.toThrow('8 MiB');
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('counts six initial tool inputs alongside raw frames toward the 8 MiB aggregate before approval', async () => {
    const initialInput = { text: 'x'.repeat(750 * 1024) };
    const parameterBytes = encoder.encode(JSON.stringify(initialInput)).byteLength;
    const events: unknown[] = [];
    for (let index = 0; index < 6; index++) {
      const start = tool(index, `initial_${index}`, initialInput);
      expect(encoder.encode(wire([start])).byteLength).toBeLessThan(MAX_TOOL_BYTES);
      events.push(start, { type: 'content_block_stop', index });
    }
    events.push({ type: 'message_stop' });
    const input = wire(events);
    const rawBytes = encoder.encode(input).byteLength;
    expect(parameterBytes).toBeLessThan(MAX_TOOL_BYTES);
    expect(rawBytes).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(rawBytes + 6 * parameterBytes).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const config = options();
    await expect(collect(transformAnthropicStream(source(input, 65536), context, config))).rejects.toThrow('8 MiB');
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('cancels upstream immediately when downstream disconnects', async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(wire(scenes.ping))); }, cancel }, { highWaterMark: 0 });
    const output = transformAnthropicStream(upstream, context, options()).getReader();
    await output.read();
    await output.cancel('fixture disconnect');
    expect(cancel).toHaveBeenCalled();
  });
  it('cancels idle byte reads at 30 seconds without execution release', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const config = options();
    const output = transformAnthropicStream(new ReadableStream<Uint8Array>({ cancel }), context, config);
    const result = collect(output);
    const rejected = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('enforces 60 second completion even with regular upstream ping bytes', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { upstreamController = controller; controller.enqueue(encoder.encode(wire([scenes.single[0]]))); }, cancel }, { highWaterMark: 0 });
    const output = transformAnthropicStream(upstream, context, options()).getReader();
    const first = output.read();
    await vi.advanceTimersByTimeAsync(0);
    upstreamController!.enqueue(encoder.encode(wire(scenes.ping)));
    await first;
    for (let index = 0; index < 2; index++) {
      const read = output.read();
      await vi.advanceTimersByTimeAsync(20_000);
      upstreamController!.enqueue(encoder.encode(wire(scenes.ping)));
      await read;
    }
    const final = output.read();
    const rejected = expect(final).rejects.toThrow('completion deadline');
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it('aborts callback signal on the whole decision deadline without releasing execution', async () => {
    vi.useFakeTimers();
    const decision = Promise.withResolvers<'allow' | 'block'>();
    const config = options();
    let decisionSignal: AbortSignal | undefined;
    config.onToolCalls = vi.fn((_calls, _context, signal) => { decisionSignal = signal; return decision.promise; });
    const result = collect(transformAnthropicStream(source(wire(scenes.single)), context, config));
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_001);
    await rejected;
    expect(decisionSignal?.aborted).toBe(true);
  });
  it('measures idle by bytes, not completed SSE frames', async () => {
    vi.useFakeTimers();
    let input: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { input = controller; } });
    const result = collect(transformAnthropicStream(upstream, context, options()));
    input!.enqueue(encoder.encode('event: ping\ndata: '));
    await vi.advanceTimersByTimeAsync(20_000);
    input!.enqueue(encoder.encode('{"type":'));
    await vi.advanceTimersByTimeAsync(20_000);
    input!.enqueue(encoder.encode('"ping"}\n\n'));
    input!.close();
    expect(await result).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
  it('cancels execution on an external abort while awaiting a verdict', async () => {
    const abort = new AbortController();
    const decision = Promise.withResolvers<'allow' | 'block'>();
    const config: AdapterOptions = { signal: abort.signal, onToolCalls: vi.fn(() => decision.promise) };
    const result = collect(transformAnthropicStream(source(wire(scenes.single)), context, config));
    const rejected = expect(result).rejects.toThrow('fixture abort');
    await vi.waitFor(() => expect(config.onToolCalls).toHaveBeenCalledOnce());
    abort.abort(new Error('fixture abort'));
    await rejected;
    decision.resolve('allow');
  });
  it('blocks conflicting SSE execution event names', async () => {
    const raw = `event: content_block_start\ndata: ${JSON.stringify({ type: 'ping', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'Bash', input: {} } })}\n\n`;
    await expect(collect(transformAnthropicStream(source(raw), context, options()))).rejects.toThrow('Conflicting');
  });
});

describe('Anthropic nonstream', () => {
  it('extracts complete calls and preserves original whitespace, usage and headers', async () => {
    const raw = ` \n${JSON.stringify(scenes.nonstream, null, 2)}\n`;
    const config = options();
    const result = await transformAnthropicNonstream(new Response(raw, { headers: { 'content-type': 'application/json', 'retry-after': '3' } }), context, config);
    expect(await result.text()).toBe(raw);
    expect(result.headers.get('retry-after')).toBe('3');
    expect(config.onToolCalls).toHaveBeenCalledWith([expect.objectContaining({ id: 'tool_n', input: { command: 'echo fixture' } })], context, expect.any(AbortSignal));
  });
  it.each([{ type: 'error', error: { type: 'overloaded_error' } }, { unknown: ['opaque'] }])('passes non-message JSON unchanged', async value => {
    const config = options();
    const result = await transformAnthropicNonstream(jsonResponse(value), context, config);
    expect(await result.text()).toBe(JSON.stringify(value));
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('blocks duplicate IDs before callback', async () => {
    const config = options();
    const block = scenes.nonstream.content[1];
    await expect(transformAnthropicNonstream(jsonResponse({ type: 'message', content: [block, block] }), context, config)).rejects.toThrow('Duplicate');
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it.each([null, 'partial', [], 42].map(input => ({ input })))('blocks invalid input $input', async ({ input }) => {
    const config = options();
    await expect(transformAnthropicNonstream(jsonResponse({ type: 'message', content: [{ type: 'tool_use', id: 'bad', name: 'Bash', input }] }), context, config)).rejects.toMatchObject({ parseStatus: 'unparseable' });
    expect(config.onToolCalls).not.toHaveBeenCalled();
  });
  it('rejects >1 MiB complete tool input', async () => {
    await expect(transformAnthropicNonstream(jsonResponse({ type: 'message', content: [{ type: 'tool_use', id: 'big', name: 'Bash', input: { text: 'x'.repeat(MAX_TOOL_BYTES) } }] }), context, options())).rejects.toThrow('1 MiB');
  });
  it('bounds complete intercepted JSON at 8 MiB', async () => {
    await expect(transformAnthropicNonstream(jsonResponse({ type: 'message', content: [{ type: 'text', text: 'x'.repeat(MAX_RESPONSE_BYTES) }] }), context, options())).rejects.toThrow('8 MiB');
  });
  it('fails malformed nonstream JSON closed', async () => {
    await expect(transformAnthropicNonstream(new Response('{"type":"message","content":['), context, options())).rejects.toMatchObject({ blocked: true, parseStatus: 'unparseable' });
  });
  it('enforces nonstream idle deadline and cancels source', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = transformAnthropicNonstream(response, context, options());
    const rejected = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it('enforces nonstream completion deadline despite regular bytes', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let input: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { input = controller; }, cancel }));
    const result = transformAnthropicNonstream(response, context, options());
    const rejected = expect(result).rejects.toThrow('deadline');
    for (let index = 0; index < 3; index++) {
      input!.enqueue(encoder.encode(' '));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it('requires supported MIME even for direct adapter calls', async () => {
    await expect(anthropicAdapter.transformResponse(new Response(JSON.stringify(scenes.nonstream), { headers: { 'content-type': 'text/plain' } }), context, options())).rejects.toThrow('media type');
  });
});
