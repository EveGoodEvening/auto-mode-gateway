import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import scenes from '../fixtures/anthropic/scenes.json' with { type: 'json' };
import signedReplay from '../fixtures/anthropic/signed-replay.json' with { type: 'json' };
import { anthropicAdapter, extractAnthropicRequest, prepareAnthropicRequest, createClaudeDeliveryState } from '../../src/protocols/anthropic/adapter.js';
import { extractRequestContext } from '../../src/protocols/request-context.js';
import { transformAnthropicStream } from '../../src/protocols/anthropic/stream.js';
import { transformAnthropicNonstream } from '../../src/protocols/anthropic/nonstream.js';
import { AnthropicResponseError, MAX_TOOL_BYTES, MAX_RESPONSE_BYTES } from '../../src/protocols/anthropic/safety.js';
import type { AdapterOptions, RequestContext } from '../../src/protocols/types.js';
import type { Verdict } from '../../src/gate/types.js';

function verdict(outcome: Verdict['outcome'] = 'allow', extra: Partial<Verdict> = {}): Verdict {
  return { outcome, reasons: [outcome === 'allow' ? 'readonly' : 'fixture-deny'], latency_ms: 0, cost_usd: 0, policy_version: 'fixture', ...extra };
}

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
  return { signal: new AbortController().signal, onToolCall: vi.fn(async () => verdict()) };
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
    if (name === 'single') expect(config.onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tool_1', name: 'Bash', input: { command: 'echo fixture' } }), context, expect.any(AbortSignal));
    if (name === 'parallel') {
      expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool_a', input: { path: 'fixture.txt' } }), context, expect.any(AbortSignal));
      expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool_b', input: { command: 'echo fixture' } }), context, expect.any(AbortSignal));
    }
    if (name !== 'single' && name !== 'parallel') expect(config.onToolCall).not.toHaveBeenCalled();
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
    const decision = Promise.withResolvers<Verdict>();
    const config = options();
    config.onToolCall = vi.fn(() => decision.promise);
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
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    decision.resolve(verdict());
    expect(new TextDecoder().decode((await pending).value)).toContain('tool_use');
    await output.cancel();
  });
  it('marks partial JSON unparseable with diagnostics and never calls allow', async () => {
    const config = options();
    await expect(collect(transformAnthropicStream(source(wire(scenes.incomplete)), context, config)))
      .rejects.toMatchObject({ blocked: true, parseStatus: 'unparseable', diagnostic: { command: 'echo fixture' } });
    expect(config.onToolCall).not.toHaveBeenCalled();
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
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it.each([
    [scenes.single[0]],
    scenes.single.slice(0, -1),
    [tool(0, 'x'), { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[]' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }],
    [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }],
  ].map(events => ({ events })))('fails closed for incomplete or invalid execution $events', async ({ events }) => {
    const config = options();
    await expect(collect(transformAnthropicStream(source(wire(events)), context, config))).rejects.toBeInstanceOf(AnthropicResponseError);
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects incomplete SSE frames without leaking possible execution', async () => {
    await expect(collect(transformAnthropicStream(source(wire([scenes.single[0]]).trimEnd()), context, options()))).rejects.toMatchObject({ blocked: true });
  });
  it('holds earlier complete execution through whole-response duplicate detection', async () => {
    const config = options();
    const events = [...scenes.single.slice(0, -2), tool(1, 'tool_1'), { type: 'content_block_stop', index: 1 }, { type: 'message_stop' }];
    await expect(collect(transformAnthropicStream(source(wire(events)), context, config))).rejects.toThrow('Duplicate');
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('does not release any execution if the explicit callback blocks', async () => {
    const config = options();
    config.onToolCall = vi.fn<AdapterOptions['onToolCall']>(async () => verdict('block'));
    const result = await collect(transformAnthropicStream(source(wire(scenes.single)), context, config));
    expect(result).not.toContain('"type":"tool_use"');
    expect(result).toContain('fixture-deny');
    expect(result).toContain('"stop_reason":"end_turn"');
  });
  it('enforces 1 MiB per tool across many small delta frames', async () => {
    const config = options();
    const delta = { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(128 * 1024) } };
    await expect(collect(transformAnthropicStream(source(wire([tool(0, 'large'), ...Array.from({ length: 9 }, () => delta)]), 65536), context, config))).rejects.toThrow('1 MiB');
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('enforces 8 MiB total held frames and arguments', async () => {
    const events: unknown[] = [];
    for (let index = 0; index < 12; index++) events.push(tool(index, `tool_${index}`, { text: 'x'.repeat(750 * 1024) }), { type: 'content_block_stop', index });
    events.push({ type: 'message_stop' });
    const config = options();
    await expect(collect(transformAnthropicStream(source(wire(events), 65536), context, config))).rejects.toThrow('8 MiB');
    expect(config.onToolCall).not.toHaveBeenCalled();
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
    expect(config.onToolCall).not.toHaveBeenCalled();
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
    expect(config.onToolCall).not.toHaveBeenCalled();
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
    const decision = Promise.withResolvers<Verdict>();
    const config = options();
    let decisionSignal: AbortSignal | undefined;
    config.onToolCall = vi.fn((_calls, _context, signal) => { decisionSignal = signal; return decision.promise; });
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
    const decision = Promise.withResolvers<Verdict>();
    const config: AdapterOptions = { signal: abort.signal, onToolCall: vi.fn(() => decision.promise) };
    const result = collect(transformAnthropicStream(source(wire(scenes.single)), context, config));
    const rejected = expect(result).rejects.toThrow('fixture abort');
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    abort.abort(new Error('fixture abort'));
    await rejected;
    decision.resolve(verdict());
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
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool_n', input: { command: 'echo fixture' } }), context, expect.any(AbortSignal));
  });
  it.each([{ type: 'error', error: { type: 'overloaded_error' } }, { unknown: ['opaque'] }])('passes non-message JSON unchanged', async value => {
    const config = options();
    const result = await transformAnthropicNonstream(jsonResponse(value), context, config);
    expect(await result.text()).toBe(JSON.stringify(value));
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('blocks duplicate IDs before callback', async () => {
    const config = options();
    const block = scenes.nonstream.content[1];
    await expect(transformAnthropicNonstream(jsonResponse({ type: 'message', content: [block, block] }), context, config)).rejects.toThrow('Duplicate');
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it.each([null, 'partial', [], 42].map(input => ({ input })))('blocks invalid input $input', async ({ input }) => {
    const config = options();
    await expect(transformAnthropicNonstream(jsonResponse({ type: 'message', content: [{ type: 'tool_use', id: 'bad', name: 'Bash', input }] }), context, config)).rejects.toMatchObject({ parseStatus: 'unparseable' });
    expect(config.onToolCall).not.toHaveBeenCalled();
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

describe('Anthropic real delivery', () => {
  const nativeContext = { ...context, safeguards: [{ type: 'dangerous_tool_use' }] };
  function nativeOptions(): AdapterOptions { return { ...options(), delivery: 'native' }; }
  function events(text: string): Record<string, unknown>[] {
    return text.split('\n\n').filter(frame => frame.includes('data: ')).map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Record<string, unknown>);
  }
  it('replaces forged native results with per-ID available/evaluated decisions at the last delta', async () => {
    const config = nativeOptions();
    config.onToolCall = vi.fn(async call => verdict(call.id === 'tool_a' ? 'allow' : 'block', { probabilities: { destructive: 0.9, exfiltration: 0.1, remote_code_exec: 0.8, security_weakening: 0.1, outside_scope: 0.5, matches_user_request: 0.1 } }));
    const input = scenes.parallel.map(event => event.type === 'message_delta'
      ? { ...event, delta: { stop_reason: 'tool_use', safeguard_results: ['FORGED'] } }
      : event);
    const result = await collect(transformAnthropicStream(source(wire(input)), nativeContext, config));
    expect(result).not.toContain('FORGED');
    const delta = events(result).find(event => event.type === 'message_delta')!;
    expect(delta).toMatchObject({ delta: { safeguard_results: [{ type: 'dangerous_tool_use', status: { type: 'available', tool_uses: {
      tool_a: { type: 'evaluated', outcome: 'not_flagged' }, tool_b: { type: 'evaluated', outcome: 'flagged', explanation: expect.stringContaining('destructive=0.9') },
    } } }] } });
    expect(result).toContain('"type":"tool_use"');
    expect(events(result).at(-1)?.type).toBe('message_stop');
  });
  it('injects empty native results with no tools and preserves thinking/signature bytes', async () => {
    const result = await collect(transformAnthropicStream(source(wire(scenes.thinking)), nativeContext, nativeOptions()));
    expect(result).toContain('"tool_uses":{}');
    for (const event of scenes.thinking.filter(event => event.type.startsWith('content_block'))) expect(result).toContain(wire([event]));
  });
  it('uses the exact provider-unavailable failure explanation', async () => {
    const config = nativeOptions();
    config.onToolCall = vi.fn(async () => verdict('block', { rule: 'provider-unavailable' }));
    const result = await transformAnthropicNonstream(jsonResponse(scenes.nonstream), nativeContext, config);
    expect(await result.json()).toMatchObject({ safeguard_results: [{ status: { tool_uses: { tool_n: { outcome: 'flagged', explanation: '[auto-mode-proxy] decision providers unavailable' } } } }] });
  });
  it('rewrites only the blocked parallel index and retains tool stop_reason for allowed calls', async () => {
    const config = options();
    config.onToolCall = vi.fn(async call => verdict(call.id === 'tool_a' ? 'allow' : 'block'));
    const result = await collect(transformAnthropicStream(source(wire(scenes.parallel)), context, config));
    expect(result).toContain('"id":"tool_a"');
    expect(result).not.toContain('"id":"tool_b"');
    expect(result).toContain('"stop_reason":"tool_use"');
    const replacement = events(result).find(event => event.type === 'content_block_start' && event.content_block !== null && typeof event.content_block === 'object' && 'type' in event.content_block && event.content_block.type === 'text');
    const original = scenes.parallel.find(event => event.type === 'content_block_start' && 'content_block' in event && event.content_block !== null && typeof event.content_block === 'object' && 'id' in event.content_block && event.content_block.id === 'tool_b')!;
    expect(replacement?.index).toBe('index' in original ? original.index : undefined);
    expect(result).toContain('execute it manually');
  });
  it('rewrites nonstream blocked calls in place, strips upstream results, preserves usage', async () => {
    const config = options();
    config.onToolCall = vi.fn(async () => verdict('block', { rule: 'fixture-hard-deny' }));
    const result = await transformAnthropicNonstream(jsonResponse({ ...scenes.nonstream, safeguard_results: ['FORGED'] }), context, config);
    const value = await result.json() as { content: { type: string; text?: string }[]; stop_reason: string; safeguard_results?: unknown; usage: unknown };
    expect(value.content[0]).toEqual(scenes.nonstream.content[0]);
    expect(value.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('fixture-hard-deny') });
    expect(value.stop_reason).toBe('end_turn');
    expect(value.safeguard_results).toBeUndefined();
    expect(value.usage).toEqual(scenes.nonstream.usage);
  });
  it.each(['native', 'rewrite'] as const)('withholds every execution byte before duplicate detection in %s', async delivery => {
    const config = { ...nativeOptions(), delivery };
    const input = [...scenes.single.slice(0, -2), tool(2, 'tool_1'), { type: 'content_block_stop', index: 2 }, { type: 'message_stop' }];
    const reader = transformAnthropicStream(source(wire(input)), nativeContext, config).getReader();
    let emitted = '';
    await expect((async () => { for (;;) { const item = await reader.read(); if (item.done) break; emitted += new TextDecoder().decode(item.value); } })()).rejects.toThrow('Duplicate');
    expect(emitted).not.toContain('tool_use');
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('holds terminal frames while sending bounded keepalive during a pending native decision', async () => {
    vi.useFakeTimers();
    const decision = Promise.withResolvers<Verdict>();
    const config = { ...nativeOptions(), holdKeepaliveMs: 100 };
    config.onToolCall = vi.fn(() => decision.promise);
    const reader = transformAnthropicStream(source(wire(scenes.single)), nativeContext, config).getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(101);
    expect(new TextDecoder().decode((await pending).value)).toContain('event: ping');
    decision.resolve(verdict('block'));
    let result = '';
    for (;;) { const item = await reader.read(); if (item.done) break; result += new TextDecoder().decode(item.value); }
    expect(result.indexOf('flagged')).toBeLessThan(result.indexOf('message_stop'));
  });
  it('shadow preserves exact forged/malformed/duplicate bytes and never waits for providers', async () => {
    const decision = Promise.withResolvers<Verdict>();
    const config = { ...nativeOptions(), mode: 'shadow' as const, onToolCall: vi.fn(() => decision.promise) };
    const raw = wire(scenes.single).replace('"stop_reason":"tool_use"', '"stop_reason":"tool_use","safeguard_results":["FORGED"]');
    expect(await collect(transformAnthropicStream(source(raw), nativeContext, config))).toBe(raw);
    decision.resolve(verdict('block'));
    const malformed = wire([tool(0, 'same'), tool(1, 'same')]) + 'data: {malformed';
    expect(await collect(transformAnthropicStream(source(malformed), nativeContext, { ...config, onToolCall: vi.fn(async () => verdict('block')) }))).toBe(malformed);
  });
  it('shadow nonstream preserves original body before a blocked observation completes', async () => {
    const decision = Promise.withResolvers<Verdict>();
    const raw = ` \n${JSON.stringify({ ...scenes.nonstream, safeguard_results: ['FORGED'] }, null, 2)}\n`;
    const result = await transformAnthropicNonstream(new Response(raw), nativeContext, { ...nativeOptions(), mode: 'shadow', onToolCall: vi.fn(() => decision.promise) });
    expect(await result.text()).toBe(raw);
    decision.resolve(verdict('block'));
  });
  it('preserves signed thinking and request replay without fictional compatibility retries', async () => {
    const body = encoder.encode(JSON.stringify({ safeguards: [], messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'original thought', signature: 'original signature' }] }] }));
    const extracted = extractAnthropicRequest(body)!;
    const prepared = prepareAnthropicRequest(body, new Headers(), extracted, { forward_safeguards: false }, 'enforce');
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toMatchObject({ messages: [{ content: [{ thinking: 'original thought', signature: 'original signature' }] }] });
    expect(extracted.safeguards).toEqual([]);
  });
});

describe('Anthropic request preparation', () => {
  it.each([true, false])('prepares independent beta settings with forward_safeguards=%s', forward_safeguards => {
    const raw = encoder.encode('{ "safeguards": [], "system": [{"type":"text","text":"keep","cache_control":{"type":"ephemeral"}}] }');
    const request = extractAnthropicRequest(raw)!;
    for (const strip_beta of [true, false]) {
      const headers = new Headers({ 'anthropic-beta': 'other-beta, dangerous-tool-use-2026-09-03, third-beta' });
      const prepared = prepareAnthropicRequest(raw, headers, request, { forward_safeguards, strip_beta }, 'enforce');
      expect(prepared.headers.get('anthropic-beta')).toBe(strip_beta ? 'other-beta,third-beta' : headers.get('anthropic-beta'));
      expect('safeguards' in JSON.parse(new TextDecoder().decode(prepared.body))).toBe(forward_safeguards);
      expect(request.safeguards).toEqual([]);
      expect(headers.get('anthropic-beta')).toContain('dangerous-tool-use');
      const shadow = prepareAnthropicRequest(raw, headers, request, { forward_safeguards, strip_beta }, 'shadow');
      expect(shadow.body).toBe(raw);
      expect(shadow.headers).toBe(headers);
    }
  });
});

describe('Claude scoped auto fallback', () => {
  const optedIn = { ...context, safeguards: [] };
  const scope = { identity: 'hashed-client', route: '/cc', session: 'explicit-session', version: '2.1.311' };
  it('selects opt-in first, explicit route next, exact version next, then observed fallback', () => {
    const state = createClaudeDeliveryState();
    expect(state.select(optedIn, scope, {})).toBe('native');
    expect(state.select(context, scope, { claude_delivery: 'native' })).toBe('rewrite');
    state.nativeDelivered(scope);
    expect(state.observeRequest(scope, true)).toBe(true);
    expect(state.select(optedIn, scope, {})).toBe('rewrite');
    expect(state.select(optedIn, scope, { claude_delivery_by_version: { '2.1.311': 'native' } })).toBe('native');
    expect(state.select(optedIn, scope, { claude_delivery: 'rewrite', claude_delivery_by_version: { '2.1.311': 'native' } })).toBe('rewrite');
  });
  it.each(['identity', 'route', 'session', 'version'] as const)('isolates %s and never guesses missing metadata', field => {
    const state = createClaudeDeliveryState();
    state.nativeDelivered(scope);
    expect(state.observeRequest({ ...scope, [field]: 'different' }, true)).toBe(false);
    expect(state.select(optedIn, { ...scope, [field]: 'different' }, {})).toBe('native');
    state.nativeDelivered({ ...scope, [field]: undefined } as typeof scope);
    expect(state.observeRequest({ ...scope, [field]: undefined } as typeof scope, true)).toBe(false);
  });
  it('requires next actual classifier within 30 seconds without an intervening model request', () => {
    let now = 0;
    const state = createClaudeDeliveryState(() => now);
    state.nativeDelivered(scope);
    now = 30_001;
    expect(state.observeRequest(scope, true)).toBe(false);
    state.nativeDelivered(scope);
    expect(state.observeRequest(scope, false)).toBe(false);
    expect(state.observeRequest(scope, true)).toBe(false);
    expect(state.select(optedIn, scope, {})).toBe('native');
  });
  it('expires evidence after 30 minutes and evicts at 1024 sessions', () => {
    let now = 0;
    const state = createClaudeDeliveryState(() => now);
    state.nativeDelivered(scope);
    state.observeRequest(scope, true);
    now = 30 * 60_000;
    expect(state.select(optedIn, scope, {})).toBe('native');
    state.nativeDelivered(scope);
    state.observeRequest(scope, true);
    for (let index = 0; index < 1024; index++) state.nativeDelivered({ ...scope, session: `session-${index}` });
    expect(state.select(optedIn, scope, {})).toBe('native');
  });
});

it('retains signed nonstream thinking and exact prior-turn replay while rewriting only the blocked tool', async () => {
  const config = options();
  config.onToolCall = vi.fn(async () => verdict('block'));
  const result = await transformAnthropicNonstream(jsonResponse(signedReplay.response), context, config);
  const value = await result.json() as { content: unknown[] };
  expect(value.content[0]).toEqual(signedReplay.response.content[0]);
  expect(value.content[1]).toMatchObject({ type: 'text' });
  const body = encoder.encode(JSON.stringify(signedReplay.request));
  const prepared = prepareAnthropicRequest(body, new Headers(), extractAnthropicRequest(body)!, { forward_safeguards: false }, 'enforce');
  expect(JSON.parse(new TextDecoder().decode(prepared.body)).messages).toEqual(signedReplay.request.messages);
});

it('shadow delivers responses beyond the observation cap unchanged without invoking a provider', async () => {
  const raw = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
  const config = { ...options(), mode: 'shadow' as const };
  expect(await collect(transformAnthropicStream(source(raw, 65536), context, config))).toBe(raw);
  expect(config.onToolCall).not.toHaveBeenCalled();
});

it('honors explicit native over exact-version rewrite and excludes inherited version properties', () => {
  const state = createClaudeDeliveryState();
  const request = { ...context, safeguards: [] };
  const scope = { identity: 'client', route: '/cc', session: 'session', version: '2.1.311' };
  expect(state.select(request, scope, { claude_delivery: 'native', claude_delivery_by_version: { '2.1.311': 'rewrite' } })).toBe('native');
  expect(state.select(request, { ...scope, version: 'toString' }, { claude_delivery_by_version: {} })).toBe('native');
});

it.each([true, false])('records native evidence only after actual output consumption, stream=%s', async stream => {
  const onNativeDelivered = vi.fn();
  const config = { ...options(), delivery: 'native' as const, onNativeDelivered };
  const request = { ...context, safeguards: [] };
  const response = stream
    ? await anthropicAdapter.transformResponse(new Response(wire(scenes.single), { headers: { 'content-type': 'text/event-stream' } }), request, config)
    : await transformAnthropicNonstream(jsonResponse(scenes.nonstream), request, config);
  expect(onNativeDelivered).not.toHaveBeenCalled();
  await response.text();
  expect(onNativeDelivered).toHaveBeenCalledOnce();
  const shadow = stream
    ? await anthropicAdapter.transformResponse(new Response(wire(scenes.single), { headers: { 'content-type': 'text/event-stream' } }), request, { ...config, mode: 'shadow' })
    : await transformAnthropicNonstream(jsonResponse(scenes.nonstream), request, { ...config, mode: 'shadow' });
  await shadow.text();
  expect(onNativeDelivered).toHaveBeenCalledOnce();
});

it.each([true, false])('registers bounded shadow observation before response completion without waiting, stream=%s', async stream => {
  const decision = Promise.withResolvers<Verdict>();
  const observations: Promise<void>[] = [];
  const config: AdapterOptions = {
    ...options(), mode: 'shadow', onToolCall: vi.fn(() => decision.promise),
    trackObservation(work) { observations.push(work); },
  };
  const input = stream ? wire(scenes.single) : JSON.stringify(scenes.nonstream);
  const response = stream
    ? await anthropicAdapter.transformResponse(new Response(input, { headers: { 'content-type': 'text/event-stream' } }), context, config)
    : await transformAnthropicNonstream(jsonResponse(scenes.nonstream), context, config);
  expect(await response.text()).toBe(input);
  expect(observations).toHaveLength(1);
  let settled = false;
  void observations[0]!.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  decision.resolve(verdict('block'));
  await Promise.all(observations);
  expect(settled).toBe(true);
});
