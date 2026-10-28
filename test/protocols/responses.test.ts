import { afterEach, describe, expect, it, vi } from 'vitest';
import scenes from '../fixtures/responses/scenes.json' with { type: 'json' };
import interleavedFixture from '../fixtures/responses/interleaved.json' with { type: 'json' };
import { responsesAdapter } from '../../src/protocols/openai-responses/adapter.js';
import { transformResponsesStream } from '../../src/protocols/openai-responses/stream.js';
import { transformResponsesNonstream } from '../../src/protocols/openai-responses/nonstream.js';
import { MAX_TOOL_BYTES, MAX_RESPONSE_BYTES, MAX_REASONING_BYTES, record } from '../../src/protocols/openai-responses/safety.js';
import type { AdapterOptions, RequestContext } from '../../src/protocols/types.js';
import type { Verdict } from '../../src/gate/types.js';

type Event = Record<string, unknown>;
const interleaved: Event[] = interleavedFixture;
const context: RequestContext = { stream: true };
const encoder = new TextEncoder();
function verdict(outcome: Verdict['outcome'] = 'allow'): Verdict {
  return { outcome, reasons: [outcome === 'allow' ? 'fixture-allow' : 'fixture-deny'], latency_ms: 0, cost_usd: 0, policy_version: 'fixture' };
}
function options(): AdapterOptions { return { signal: new AbortController().signal, onToolCall: vi.fn(async () => verdict()) }; }
function wire(events: readonly Event[]): string {
  return events.map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join('');
}
function source(text: string, split = 113): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let cursor = 0;
  return new ReadableStream({ pull(controller) {
    if (cursor === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(cursor, cursor + split)); cursor = Math.min(cursor + split, bytes.length);
  } }, { highWaterMark: 0 });
}
function execution(item: unknown): boolean { return record(item) && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(item.type)); }
function eventsFor(output: Event[], status: 'completed' | 'incomplete' = 'completed'): Event[] {
  return [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    ...output.flatMap((item, output_index) => {
      const initial = { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : item.type === 'custom_tool_call' ? { input: '' } : item.type === 'message' ? { content: [] } : {}) };
      return [
        { type: 'response.output_item.added', output_index, item: initial },
        ...(item.type === 'function_call' ? [
          { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments },
          { type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: item.arguments },
        ] : item.type === 'custom_tool_call' ? [
          { type: 'response.custom_tool_call_input.delta', output_index, item_id: item.id, delta: item.input },
          { type: 'response.custom_tool_call_input.done', output_index, item_id: item.id, input: item.input },
        ] : []),
        { type: 'response.output_item.done', output_index, item: structuredClone(item) },
      ];
    }),
    { type: `response.${status}`, response: { id: 'resp_fixture', status, output: structuredClone(output), usage: scenes.usage, ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } },
  ];
}
function parsed(text: string): Event[] {
  return text.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => {
    const value: unknown = JSON.parse(line.slice(5));
    if (!record(value)) throw new Error('Invalid outgoing event');
    return value;
  });
}
async function collect(events: Event[], config = options(), split = 113): Promise<string> {
  return new Response(transformResponsesStream(source(wire(events), split), context, config)).text();
}
function jsonResponse(output: Event[], status = 'completed'): Response {
  return new Response(JSON.stringify({ id: 'resp_fixture', status, output, usage: scenes.usage }), { headers: { 'content-type': 'application/json', 'x-fixture': 'preserved' } });
}
async function captureFailure(events: Event[], config = options()): Promise<{ text: string; error: unknown }> {
  const reader = transformResponsesStream(source(wire(events)), context, config).getReader();
  let text = '';
  try { for (;;) { const item = await reader.read(); if (item.done) return { text, error: undefined }; text += new TextDecoder().decode(item.value); } }
  catch (error) { return { text, error }; }
}
function responseValue(value: unknown): Event & { output: Event[] } {
  if (!record(value) || !Array.isArray(value.output) || !value.output.every(record)) throw new Error('Invalid terminal output');
  return { ...value, output: value.output };
}
function terminalOutput(events: Event[]): Event[] { return responseValue(events.at(-1)!.response).output; }
function itemAt(events: Event[], index: number): Event {
  const item = events[index]?.item;
  if (!record(item)) throw new Error('Invalid output item');
  return item;
}
afterEach(() => vi.useRealTimers());

describe('Responses execution approval boundary', () => {
  it.each(['exec', 'patch', 'local', 'stdin', 'codeExec', 'codeWait'] as const)('approves complete %s before emitting its first execution event', async name => {
    const config = options();
    const output = [scenes[name]];
    const text = await collect(eventsFor(output), config, 7);
    expect(text).toBe(wire(eventsFor(output)));
    expect(config.onToolCall).toHaveBeenCalledOnce();
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: scenes[name].call_id }), context, expect.any(AbortSignal));
    if (name === 'exec') expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: 'exec_command', input: { cmd: 'printf fixture', sandbox_permissions: 'require_escalated', justification: 'inert fixture' } }), context, expect.any(AbortSignal));
    if (name === 'patch') expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: 'apply_patch', input: scenes.patch.input }), context, expect.any(AbortSignal));
    if (name === 'local') expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: 'local_shell', input: { action: scenes.local.action } }), context, expect.any(AbortSignal));
  });
  it('gates a completed-only execution item and generates a full replacement chain without an upstream added event', async () => {
    const input = eventsFor([scenes.exec]).filter(event => event.type === 'response.created' || event.type === 'response.output_item.done' || event.type === 'response.completed');
    const config = { ...options(), onToolCall: vi.fn(async () => verdict('block')) };
    const output = parsed(await collect(input, config));
    expect(config.onToolCall).toHaveBeenCalledOnce();
    expect(output.filter(event => event.output_index === 0).map(event => event.type)).toEqual(['response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done']);
    expect(terminalOutput(output)[0]).toMatchObject({ type: 'message', id: 'msg_amp_0' });
  });
  it('begins decision at output_item.done, but withholds added/parameters until terminal uniqueness', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const config = options();
    const events = eventsFor([scenes.exec, scenes.text]);
    const reader = transformResponsesStream(upstream, context, config).getReader();
    feed.enqueue(encoder.encode(wire(events.slice(0, 5))));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('response.created');
    const pending = reader.read();
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    feed.enqueue(encoder.encode(wire(events.slice(5)).replace(/"sequence_number":(\d+)/gu, (_match, value: string) => `"sequence_number":${Number(value) + 5}`)));
    feed.close();
    expect(new TextDecoder().decode((await pending).value)).toContain('response.output_item.added');
    await reader.cancel();
  });
  it.each(['completed', 'incomplete'] as const)('rewrites partial parallel blocks in %s output with full message lifecycle and untouched usage', async status => {
    const config = { ...options(), onToolCall: vi.fn(async (call: { id: string }) => verdict(call.id === scenes.exec.call_id ? 'block' : 'allow')) };
    const input = [scenes.exec, scenes.text, scenes.patch, scenes.reasoning, scenes.local];
    const output = parsed(await collect(eventsFor(input, status), config));
    const terminal = responseValue(output.at(-1)!.response);
    expect(terminal.usage).toEqual(scenes.usage);
    expect(terminal.status).toBe(status);
    expect(terminal.output.slice(1)).toEqual(input.slice(1));
    expect(terminal.output[0]).toMatchObject({ type: 'message', id: 'msg_amp_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: expect.stringContaining('fixture-deny'), annotations: [] }] });
    const chain = output.filter(event => event.output_index === 0);
    expect(chain.map(event => event.type)).toEqual(['response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done']);
    expect(chain.at(-1)!.item).toEqual(terminal.output[0]);
    const starts = output.filter(event => event.type === 'response.output_item.added');
    expect(starts.map(event => event.output_index)).toEqual([0, 1, 2, 3, 4]);
    const numbers = output.map(event => event.sequence_number as number);
    expect(numbers.every((number, index) => index === 0 || number > numbers[index - 1]!)).toBe(true);
    expect(output.filter(event => execution(event.item)).every(event => event.output_index !== 0)).toBe(true);
  });
  it('preserves raw interleaved allowed starts and completions without sorting indices', async () => {
    const text = await collect(interleaved);
    expect(text).toBe(wire(interleaved));
    const output = parsed(text);
    expect(output.filter(event => event.type === 'response.output_item.added').map(event => event.output_index)).toEqual([0, 1, 2]);
    expect(output.filter(event => event.type === 'response.output_item.done').map(event => event.output_index)).toEqual([1, 0, 2]);
    expect(terminalOutput(output).map(item => item.id)).toEqual(['fc_left', 'fc_right', 'msg_trailing']);
  });
  it.each(['call_left', 'call_right'])('preserves interleaved start and completion partial order when blocking %s', async denied => {
    const config = { ...options(), onToolCall: vi.fn(async (call: { id: string }) => verdict(call.id === denied ? 'block' : 'allow')) };
    const text = await collect(interleaved, config);
    const output = parsed(text);
    const deniedIndex = denied === 'call_left' ? 0 : 1;
    const allowedIndex = 1 - deniedIndex;
    expect(output.filter(event => event.type === 'response.output_item.added').map(event => event.output_index)).toEqual([0, 1, 2]);
    expect(output.filter(event => event.type === 'response.output_item.done').map(event => event.output_index)).toEqual([1, 0, 2]);
    const chain = output.filter(event => event.output_index === deniedIndex);
    expect(chain.map(event => event.type)).toEqual(['response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done']);
    const delivered = terminalOutput(output);
    expect(chain.at(-1)!.item).toEqual(delivered[deniedIndex]);
    expect(delivered[deniedIndex]).toMatchObject({ type: 'message', id: 'msg_amp_0' });
    expect(delivered[allowedIndex]).toEqual(terminalOutput(interleaved)[allowedIndex]);
    expect(delivered[2]).toEqual(terminalOutput(interleaved)[2]);
    expect(responseValue(output.at(-1)!.response).usage).toEqual(responseValue(interleaved.at(-1)!.response).usage);
    const allowedEvents = output.filter(event => event.output_index === allowedIndex).map(event => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'sequence_number')));
    expect(allowedEvents).toEqual(interleaved.filter(event => event.output_index === allowedIndex));
    const numbers = output.map(event => event.sequence_number as number);
    expect(numbers.every((number, index) => index === 0 || number > numbers[index - 1]!)).toBe(true);
    expect(text).not.toContain(denied === 'call_left' ? 'printf left_fixture' : 'printf right_fixture');
  });
  it('does not collide generated blocked-message IDs with legitimate message IDs', async () => {
    const input = [{ ...scenes.text, id: 'msg_amp_0' }, scenes.exec];
    const config = { ...options(), onToolCall: vi.fn(async () => verdict('block')) };
    const output = parsed(await collect(eventsFor(input), config));
    expect(terminalOutput(output).map(item => item.id)).toEqual(['msg_amp_0', 'msg_amp_1']);
  });
  it('rejects late duplicate call IDs after mixed decisions without any execution release', async () => {
    const config = { ...options(), onToolCall: vi.fn(async (call: { name: string }) => verdict(call.name === 'exec_command' ? 'allow' : 'block')) };
    const result = await captureFailure(eventsFor([scenes.exec, { ...scenes.patch, call_id: scenes.exec.call_id }]), config);
    expect(result.error).toBeDefined();
    expect(parsed(result.text).some(event => execution(event.item))).toBe(false);
    expect(result.text).not.toContain('printf fixture');
  });
  it.each([
    { label: 'done arguments', mutate: (events: Event[]) => { itemAt(events, 4).arguments = '{"cmd":"different fixture"}'; } },
    { label: 'done name', mutate: (events: Event[]) => { itemAt(events, 4).name = 'other'; } },
    { label: 'done call identity', mutate: (events: Event[]) => { itemAt(events, 4).call_id = 'different'; } },
    { label: 'done item identity', mutate: (events: Event[]) => { itemAt(events, 4).id = 'different'; } },
    { label: 'parameter identity', mutate: (events: Event[]) => { events[2]!.item_id = 'different'; } },
    { label: 'parameter done', mutate: (events: Event[]) => { events[3]!.arguments = '{"cmd":"different fixture"}'; } },
    { label: 'terminal arguments', mutate: (events: Event[]) => { terminalOutput(events)[0]!.arguments = '{"cmd":"different fixture"}'; } },
    { label: 'terminal call identity', mutate: (events: Event[]) => { terminalOutput(events)[0]!.call_id = 'different'; } },
    { label: 'terminal namespace', mutate: (events: Event[]) => { terminalOutput(events)[0]!.namespace = 'different_execution_namespace'; } },
    { label: 'terminal encrypted arguments', mutate: (events: Event[]) => { terminalOutput(events)[0]!.encrypted_function_args = ['opaque-different-fixture']; } },
    { label: 'terminal incomplete status', mutate: (events: Event[]) => { terminalOutput(events)[0]!.status = 'in_progress'; } },
    { label: 'terminal type', mutate: (events: Event[]) => { terminalOutput(events)[0]!.type = 'message'; } },
  ])('rejects contradictory $label without releasing approved executable data', async ({ mutate }) => {
    const events = structuredClone(eventsFor([scenes.exec]));
    // Each snapshot must be independent; mutation never edits the approved source by alias.
    mutate(events);
    const result = await captureFailure(events);
    expect(result.error).toBeDefined();
    expect(parsed(result.text).some(event => execution(event.item))).toBe(false);
  });
  it.each(['response.created', 'response.in_progress', 'response.completed', 'response.incomplete'])('rejects untracked %s execution snapshots without forwarding them', async type => {
    const status = type === 'response.incomplete' ? 'incomplete' : type === 'response.completed' ? 'completed' : 'in_progress';
    const result = await captureFailure([{ type, response: { status, output: [scenes.exec], usage: scenes.usage } }]);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('printf fixture');
  });
  it.each(['arguments', 'name', 'call_id'])('rejects missing %s without calling approval', async field => {
    const item: Event = { ...scenes.exec };
    delete item[field];
    const config = options();
    const result = await captureFailure(eventsFor([item]), config);
    expect(result.error).toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
    expect(result.text).not.toContain('function_call');
  });
  it('accepts client-optional execution status and item ID rather than inventing a required wire grammar', async () => {
    const item: Event = { ...scenes.exec };
    delete item.id; delete item.status;
    const config = options();
    expect(await collect(eventsFor([item]), config)).toContain('printf fixture');
    expect(config.onToolCall).toHaveBeenCalledOnce();
  });
  it('accepts nullable optional function fields and preserves namespace in the authoritative raw call', async () => {
    const item = { ...scenes.exec, id: null, status: null, namespace: 'functions' };
    const config = options();
    expect(await collect(eventsFor([item]), config)).toContain('printf fixture');
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: 'exec_command', raw: item }), context, expect.any(AbortSignal));
  });
  it('uses the accepted legacy local-shell item identity when call_id is absent', async () => {
    const item: Event = { ...scenes.local };
    delete item.call_id;
    const config = options();
    expect(await collect(eventsFor([item]), config)).toContain('local_shell_call');
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, name: 'local_shell' }), context, expect.any(AbortSignal));
  });
  it.each(['[]', 'null', '"fixture"'])('passes complete client-accepted JSON arguments %s to the gate without inventing an object-only schema', async argumentsText => {
    const config = { ...options(), onToolCall: vi.fn(async () => verdict('block')) };
    const text = await collect(eventsFor([{ ...scenes.exec, name: 'fixture_generic_tool', arguments: argumentsText }]), config);
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ input: JSON.parse(argumentsText) as unknown }), context, expect.any(AbortSignal));
    expect(text).toContain('fixture-deny');
    expect(parsed(text).some(event => execution(event.item))).toBe(false);
  });
  it.each([
    { label: 'custom input', item: scenes.patch, field: 'input', changed: 'different inert patch' },
    { label: 'local shell action', item: scenes.local, field: 'action', changed: { type: 'exec', command: ['printf', 'different fixture'] } },
  ])('rejects contradictory terminal $label without releasing its initial snapshot', async ({ item, field, changed }) => {
    const events = eventsFor([item]);
    terminalOutput(events)[0]![field] = changed;
    const result = await captureFailure(events);
    expect(result.error).toBeDefined();
    expect(parsed(result.text).some(event => execution(event.item))).toBe(false);
  });
  it('rejects a nonempty added argument snapshot that disagrees with completed arguments', async () => {
    const events = eventsFor([scenes.exec]);
    const added = itemAt(events, 1);
    added.arguments = '{"cmd":"different fixture"}';
    const result = await captureFailure(events);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
  });
  it('rejects duplicate output item IDs independently of unique call IDs', async () => {
    const result = await captureFailure(eventsFor([scenes.exec, { ...scenes.patch, id: scenes.exec.id }]));
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
    expect(result.text).not.toContain('custom_tool_call');
  });
  it.each(['client', undefined, 'unknown'])('fails closed unsupported tool-search mode %s across initial, added, done and terminal snapshots', async executionMode => {
    const item = { ...scenes.search, execution: executionMode };
    for (const input of [
      [{ type: 'response.created', response: { status: 'in_progress', output: [item] } }],
      eventsFor([item]),
      [{ type: 'response.output_item.done', output_index: 0, item }],
      [{ type: 'response.completed', response: { status: 'completed', output: [item] } }],
    ]) {
      const config = options();
      const result = await captureFailure(input, config);
      expect(result.error).toBeDefined();
      expect(result.text).not.toContain('tool_search_call');
      expect(config.onToolCall).not.toHaveBeenCalled();
    }
    const config = options();
    await expect(transformResponsesNonstream(jsonResponse([item]), context, config)).rejects.toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects client-side tool search added or terminal snapshots after a prior execution barrier', async () => {
    const base = eventsFor([scenes.exec]);
    for (const suffix of [
      [{ type: 'response.output_item.added', output_index: 1, item: scenes.search }],
      [{ type: 'response.completed', response: { status: 'completed', output: [scenes.exec, scenes.search] } }],
    ]) {
      const result = await captureFailure([...base.slice(0, 5), ...suffix]);
      expect(result.error).toBeDefined();
      expect(result.text).not.toContain('function_call');
      expect(result.text).not.toContain('tool_search_call');
    }
  });
  it('does not invent a client execution path for server-side tool search', async () => {
    const item = { ...scenes.search, execution: 'server' };
    const config = options();
    expect(await collect(eventsFor([item]), config)).toBe(wire(eventsFor([item])));
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
});

describe('Responses immediate text and raw shadow', () => {
  it('rejects renumbering that would create an untracked executable frame without approval', async () => {
    const injected = `data:${JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', name: 'f', arguments: '{}', call_id: 'c' } })}\n\n`;
    const raw = `data: ${JSON.stringify({ type: 'ping', sequence_number: 100 })}\n\n`
      + `data: ${JSON.stringify({ type: `v\n\n${injected}`, sequence_number: 0 })}\n\n`;
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(raw)); }, cancel });
    const config = { ...options(), onToolCall: vi.fn(async () => verdict('block')) };
    const reader = transformResponsesStream(upstream, context, config).getReader();
    try {
      expect(parsed(new TextDecoder().decode((await reader.read()).value)).map(event => event.type)).toEqual(['ping']);
      await expect(reader.read()).rejects.toBeDefined();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    expect(config.onToolCall).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });
  it('preserves a legitimate unknown event through required sequence renumbering', async () => {
    const config = options();
    const output = parsed(await collect([
      { type: 'ping', sequence_number: 100 }, { type: 'vendor.fixture', sequence_number: 0, marker: 'kept' },
      { type: 'response.completed', sequence_number: 101, response: { status: 'completed', output: [] } },
    ], config));
    expect(output.find(event => event.type === 'vendor.fixture')).toMatchObject({ marker: 'kept' });
    expect(output[0]).toEqual({ type: 'ping', sequence_number: 100 });
    let previous = -1;
    for (const event of output) {
      const sequence = event.sequence_number;
      if (typeof sequence !== 'number') throw new Error('Missing outgoing sequence number');
      expect(Number.isSafeInteger(sequence)).toBe(true);
      expect(sequence).toBeGreaterThan(previous);
      previous = sequence;
    }
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('does not impose a reasoning-sized cap on a large single transport chunk of pure text', async () => {
    const input: Event[] = Array.from({ length: 128 }, () => ({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_large_plain', content_index: 0, delta: 'x'.repeat(40_000) }));
    input.push({ type: 'response.completed', response: { status: 'completed', output: [] } });
    const raw = wire(input);
    const length = encoder.encode(raw).byteLength;
    expect(length).toBeGreaterThan(MAX_REASONING_BYTES);
    expect(length).toBeLessThan(MAX_RESPONSE_BYTES);
    const config = options();
    expect(await new Response(transformResponsesStream(source(raw, length), context, config)).text()).toBe(raw);
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it.each(['custom_tool_call', 'local_shell_call'])('preserves fully escaped %s types, split Unicode and multiline data without losing approval tracking', async type => {
    const item = type === 'custom_tool_call' ? { ...scenes.patch, name: 'fixture_utf8', input: 'inert🌍' }
      : { ...scenes.local, action: { ...scenes.local.action, command: ['printf', 'inert🌍'] } };
    const escaped = [...type].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const raw = eventsFor([item]).map((event, sequence_number) => {
      const json = JSON.stringify({ sequence_number, ...event }).replaceAll(`"${type}"`, `"${escaped}"`);
      const split = json.indexOf(',');
      return `event: ${String(event.type)}\r\nid: utf8_${sequence_number}\r\ndata: ${json.slice(0, split + 1)}\r\ndata: ${json.slice(split + 1)}\r\n\r\n`;
    }).join('');
    const config = options();
    expect(await new Response(transformResponsesStream(source(raw, 1), context, config)).text()).toBe(raw);
    expect(config.onToolCall).toHaveBeenCalledOnce();
    expect(config.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ raw: item }), context, expect.any(AbortSignal));
  });
  it('delivers pure/early text immediately without waiting for turn completion', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const reader = transformResponsesStream(input, context, options()).getReader();
    const first = wire([{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_early', content_index: 0, delta: 'EARLY_MARKER' }]);
    feed.enqueue(encoder.encode(first));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
    await reader.cancel();
  });
  it('keeps an early message immediate and later mixed item order stable while approval is pending', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const decision = Promise.withResolvers<Verdict>();
    const config = { ...options(), onToolCall: vi.fn(() => decision.promise) };
    const early = { ...scenes.text, id: 'msg_early', content: [{ type: 'output_text', text: 'EARLY_MARKER', annotations: [] }] };
    const events = eventsFor([early, scenes.exec, scenes.text]);
    const reader = transformResponsesStream(input, context, config).getReader();
    feed.enqueue(encoder.encode(wire(events.slice(0, 3))));
    let text = '';
    for (let index = 0; index < 3; index++) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toBe(wire(events.slice(0, 3)));
    feed.enqueue(encoder.encode(wire(events.slice(3)))); feed.close();
    const pending = reader.read();
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    decision.resolve(verdict('block'));
    text += new TextDecoder().decode((await pending).value);
    for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    const output = parsed(text);
    expect(output.filter(event => event.type === 'response.output_item.added').map(event => event.output_index)).toEqual([0, 1, 2]);
    expect(terminalOutput(output)).toEqual([early, expect.objectContaining({ type: 'message', id: 'msg_amp_0' }), scenes.text]);
  });
  it('keeps reasoning and trailing text in arrival order behind first execution without stripping encrypted content', async () => {
    const input = [scenes.exec, scenes.reasoning, scenes.text, scenes.patch];
    const output = parsed(await collect(eventsFor(input)));
    expect(output.filter(event => event.type === 'response.output_item.added').map(event => {
      if (!record(event.item)) throw new Error('Invalid outgoing item');
      return event.item.id;
    })).toEqual(input.map(item => item.id));
    expect(terminalOutput(output)).toEqual(input);
    expect(output.find(event => event.type === 'response.output_item.done' && event.output_index === 1)!.item).toEqual(scenes.reasoning);
  });
  it('passes comments and control-only ping immediately, holds unknown stateful data and renumbers released sequences', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const config = options();
    const reader = transformResponsesStream(input, context, config).getReader();
    const events = eventsFor([scenes.exec, scenes.text]);
    feed.enqueue(encoder.encode(wire(events.slice(0, 5))));
    let text = new TextDecoder().decode((await reader.read()).value);
    const pending = reader.read();
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    const comment = ': immediate-control\r\n\r\n';
    feed.enqueue(encoder.encode(comment + wire([{ type: 'ping', sequence_number: 100 }])));
    expect(new TextDecoder().decode((await pending).value)).toBe(comment);
    text += comment;
    const ping = new TextDecoder().decode((await reader.read()).value);
    expect(parsed(ping)[0]!.type).toBe('ping');
    text += ping;
    const heldRead = reader.read();
    let settled = false;
    void heldRead.then(() => { settled = true; });
    feed.enqueue(encoder.encode(wire([{ type: 'vendor.stateful', sequence_number: 101, marker: 'STATEFUL_SUFFIX' }])));
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    feed.enqueue(encoder.encode(wire(events.slice(5))));
    feed.close();
    text += new TextDecoder().decode((await heldRead).value);
    for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    const output = parsed(text);
    expect(output.filter(event => event.type === 'response.output_item.added').map(event => event.output_index)).toEqual([0, 1]);
    expect(output.findIndex(event => event.type === 'vendor.stateful')).toBeGreaterThan(output.findIndex(event => event.type === 'response.output_item.done' && event.output_index === 0));
    const numbers = output.map(event => event.sequence_number as number);
    expect(numbers.every((number, index) => index === 0 || number > numbers[index - 1]!)).toBe(true);
  });
  it('preserves comments, CRLF, id/retry, multiline data and unknown events byte-for-byte when unchanged', async () => {
    const raw = ': fixture-comment\r\nid: fixture\r\nretry: 4\r\nevent: vendor.fixture\r\ndata: {"type":"vendor.fixture",\r\ndata: "fixture":true}\r\n\r\n' + wire(eventsFor([scenes.text]));
    expect(await new Response(transformResponsesStream(source(raw, 1), context, options())).text()).toBe(raw);
  });
  it('preserves an unchanged all-allowed terminal frame including comments, metadata and multiline CRLF data', async () => {
    const events = eventsFor([scenes.exec]);
    const terminal = { sequence_number: events.length - 1, ...events.at(-1)! };
    const json = JSON.stringify(terminal);
    const split = json.indexOf(',"response"');
    const tail = `: terminal-metadata\r\nid: original-terminal\r\nretry: 17\r\nevent: response.completed\r\ndata: ${json.slice(0, split + 1)}\r\ndata: ${json.slice(split + 1)}\r\n\r\n`;
    const raw = wire(events.slice(0, -1)) + tail;
    expect(await new Response(transformResponsesStream(source(raw, 113), context, options())).text()).toBe(raw);
  });
  it('keeps shadow byte-identical and nonblocking while a hypothetical block is pending', async () => {
    const pending = Promise.withResolvers<Verdict>();
    const work: Promise<void>[] = [];
    const config = { ...options(), mode: 'shadow' as const, onToolCall: vi.fn(() => pending.promise), trackObservation: (value: Promise<void>) => { work.push(value); } };
    const raw = ': shadow-fixture\r\n\r\n' + wire(eventsFor([scenes.exec, scenes.text]));
    expect(await new Response(transformResponsesStream(source(raw, 1), context, config)).text()).toBe(raw);
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    expect(work).toHaveLength(1);
    pending.resolve(verdict('block'));
    await Promise.all(work);
  });
  it('bounds shadow observation and skips an over-cap response without altering raw delivery', async () => {
    const config = { ...options(), mode: 'shadow' as const };
    const raw = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
    expect(await new Response(transformResponsesStream(source(raw, 65_536), context, config)).text()).toBe(raw);
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
});

describe('Responses failure, cancellation and resource boundaries', () => {
  it('cancels upstream before acquiring execution when the request is already aborted', async () => {
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({ cancel });
    const abort = new AbortController();
    abort.abort();
    const config = { ...options(), signal: abort.signal };
    await expect(new Response(transformResponsesStream(input, context, config)).text()).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalled();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('withholds an incomplete EOF after a valid individually approved execution', async () => {
    const events = eventsFor([scenes.exec]); events.pop();
    const result = await captureFailure(events);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('printf fixture');
  });
  it('withholds approved execution through EOF and rejects execution after the terminal snapshot', async () => {
    const events = eventsFor([scenes.exec]);
    events.push({ type: 'response.output_item.done', output_index: 1, item: scenes.patch });
    const result = await captureFailure(events);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
    expect(result.text).not.toContain('custom_tool_call');
  });
  it('does not let a control-named event forward an execution snapshot', async () => {
    const result = await captureFailure([
      ...eventsFor([scenes.exec]).slice(0, 5),
      { type: 'ping', response: { output: [scenes.patch] } },
    ]);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
    expect(result.text).not.toContain('custom_tool_call');
  });
  it('rejects conflicting SSE header and payload execution identity before forwarding the frame', async () => {
    const raw = wire(eventsFor([scenes.exec])).replace('event: response.output_item.added', 'event: response.output_text.delta');
    const reader = transformResponsesStream(source(raw), context, options()).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('response.created');
    await expect(reader.read()).rejects.toBeDefined();
  });
  it('keeps a client [DONE] terminator after rewritten execution and its terminal array', async () => {
    const config = { ...options(), onToolCall: vi.fn(async () => verdict('block')) };
    const raw = wire(eventsFor([scenes.exec])) + 'data: [DONE]\n\n';
    const text = await new Response(transformResponsesStream(source(raw), context, config)).text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(parsed(text.replace('data: [DONE]\n\n', '')).at(-1)!.type).toBe('response.completed');
    expect(text).not.toContain('function_call');
  });
  it.each(['{', '{"cmd":', '[1,', 'invalid'])('never approves malformed complete arguments %s', async argumentsText => {
    const config = options();
    const result = await captureFailure(eventsFor([{ ...scenes.exec, arguments: argumentsText }]), config);
    expect(result.error).toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects a single call over 1 MiB before approval', async () => {
    const config = options();
    const result = await captureFailure(eventsFor([{ ...scenes.exec, arguments: JSON.stringify({ cmd: 'x'.repeat(MAX_TOOL_BYTES) }) }]), config);
    expect(result.error).toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
    expect(result.text).not.toContain('function_call');
  });
  it('enforces aggregate retained representations even when raw wire is below 8 MiB', async () => {
    const config = options();
    const items = Array.from({ length: 8 }, (_, index) => ({ ...scenes.exec, id: `fc_${index}`, call_id: `call_${index}`, arguments: JSON.stringify({ cmd: 'x'.repeat(110_000) }) }));
    const input = eventsFor(items);
    expect(encoder.encode(wire(input)).byteLength).toBeLessThan(MAX_RESPONSE_BYTES);
    const result = await captureFailure(input, config);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
  });
  it('applies the independent reasoning subset to retained suffix representations', async () => {
    const reasoning = Array.from({ length: 3 }, (_, index) => ({ ...scenes.reasoning, id: `rs_${index}`, encrypted_content: 'x'.repeat(250_000) }));
    const input = eventsFor([scenes.exec, ...reasoning]);
    expect(encoder.encode(wire(input)).byteLength).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(encoder.encode(JSON.stringify(reasoning)).byteLength).toBeLessThan(MAX_REASONING_BYTES);
    const result = await captureFailure(input);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
  });
  it('counts reasoning-associated frames when output_index uses valid Unicode-escaped JSON spelling', async () => {
    const input = eventsFor([scenes.exec, scenes.reasoning]);
    input.splice(input.length - 1, 0, ...Array.from({ length: 3 }, () => ({ type: 'vendor.stateful', output_index: 1, payload: 'x'.repeat(500_000) })));
    const escapedKey = [...'output_index'].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const raw = wire(input).replaceAll('"output_index"', `"${escapedKey}"`);
    expect(encoder.encode(raw).byteLength).toBeLessThan(MAX_RESPONSE_BYTES);
    const reader = transformResponsesStream(source(raw, 65_536), context, options()).getReader();
    let delivered = '';
    let failure: unknown;
    try { for (;;) { const next = await reader.read(); if (next.done) break; delivered += new TextDecoder().decode(next.value); } }
    catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(delivered).not.toContain('function_call');
  });
  it.each([
    { escapedLast: true, reasoningLast: true }, { escapedLast: false, reasoningLast: true },
    { escapedLast: true, reasoningLast: false }, { escapedLast: false, reasoningLast: false },
  ])('uses LAST duplicate index semantics across escaped spelling and chunk splits ($escapedLast/$reasoningLast)', async ({ escapedLast, reasoningLast }) => {
    const input = eventsFor([scenes.exec, scenes.reasoning]);
    input.splice(input.length - 1, 0, ...Array.from({ length: 3 }, () => ({ type: 'vendor.stateful', output_index: 1, payload: 'x'.repeat(500_000) })));
    const escapedKey = [...'output_index'].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    let raw = input.map((event, sequence_number) => {
      const first = escapedLast ? 'output_index' : escapedKey;
      const last = escapedLast ? escapedKey : 'output_index';
      const json = JSON.stringify({ sequence_number, ...event });
      return `event: ${String(event.type)}\ndata: ${event.type === 'vendor.stateful' ? json.replace('"output_index":1', `"${first}":${reasoningLast ? 0 : 1},"${last}":${reasoningLast ? 1 : 0}`) : json}\n\n`;
    }).join('');
    let padding = (4092 - raw.indexOf(escapedKey) % 4093 + 4093) % 4093;
    if (padding < 3) padding += 4093;
    raw = `:${'p'.repeat(padding - 3)}\n\n` + raw;
    const result = new Response(transformResponsesStream(source(raw, 4093), context, options())).text();
    if (reasoningLast) await expect(result).rejects.toBeDefined();
    else expect(await result).toBe(raw);
  });
  it('counts terminal reasoning and rewrite temporaries even when each raw reasoning snapshot is below the subset cap', async () => {
    const reasoning = { ...scenes.reasoning, encrypted_content: 'x'.repeat(450_000) };
    const input = eventsFor([scenes.exec, reasoning]);
    expect(encoder.encode(wire(input)).byteLength).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(encoder.encode(JSON.stringify(reasoning)).byteLength * 9).toBeLessThan(MAX_REASONING_BYTES);
    const result = await captureFailure(input);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
  });
  it('keeps stateful data associated with a reasoning item inside the reasoning subset', async () => {
    const input = eventsFor([scenes.exec, scenes.reasoning]);
    const fragments = Array.from({ length: 3 }, () => ({ type: 'vendor.stateful', output_index: 1, payload: 'x'.repeat(500_000) }));
    input.splice(input.length - 1, 0, ...fragments);
    expect(encoder.encode(wire(input)).byteLength).toBeLessThan(MAX_RESPONSE_BYTES);
    const result = await captureFailure(input);
    expect(result.error).toBeDefined();
    expect(result.text).not.toContain('function_call');
  });
  it('stops collection clocks at EOF while preserving the separate remaining decision window', async () => {
    vi.useFakeTimers();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const decision = Promise.withResolvers<Verdict>();
    const config = { ...options(), holdKeepaliveMs: 100_000, onToolCall: vi.fn(() => decision.promise) };
    const events = eventsFor([scenes.exec]);
    const result = new Response(transformResponsesStream(input, context, config)).text();
    feed.enqueue(encoder.encode(wire(events.slice(0, 2))));
    for (let index = 0; index < 2; index++) { await vi.advanceTimersByTimeAsync(20_000); feed.enqueue(encoder.encode(': upstream-progress\n\n')); }
    await vi.advanceTimersByTimeAsync(19_000);
    feed.enqueue(encoder.encode(wire(events.slice(2)))); feed.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(config.onToolCall).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    decision.resolve(verdict());
    expect(await result).toContain('function_call');
  });
  it.each(['idle', 'completion', 'decision'] as const)('fails closed at the independent %s deadline', async deadline => {
    vi.useFakeTimers();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    const config = { ...options(), holdKeepaliveMs: 100_000, onToolCall: vi.fn(() => new Promise<Verdict>(() => {})) };
    const events = eventsFor([scenes.exec]);
    const prefix = deadline === 'decision' ? events : deadline === 'completion' ? events.slice(0, 2) : events.slice(0, 1);
    const result = new Response(transformResponsesStream(input, context, config)).text();
    const failure = expect(result).rejects.toBeDefined();
    feed.enqueue(encoder.encode(wire(prefix)));
    if (deadline === 'decision') feed.close();
    if (deadline === 'completion') {
      for (let i = 0; i < 2; i++) { await vi.advanceTimersByTimeAsync(20_000); feed.enqueue(encoder.encode(': upstream-ping\n\n')); }
      await vi.advanceTimersByTimeAsync(20_001);
    } else await vi.advanceTimersByTimeAsync(deadline === 'idle' ? 30_001 : 60_001);
    await failure;
  });
  it('cancels the upstream on completion deadline even while the consumer applies backpressure', async () => {
    vi.useFakeTimers();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; }, cancel });
    const config = { ...options(), holdKeepaliveMs: 100_000 };
    const reader = transformResponsesStream(input, context, config).getReader();
    feed.enqueue(encoder.encode(wire(eventsFor([scenes.exec]).slice(0, 2)) + ': backpressure-boundary\n\n'));
    await reader.read();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': backpressure-boundary\n\n');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(cancel).toHaveBeenCalled();
    expect(config.onToolCall).not.toHaveBeenCalled();
    await expect(reader.read()).rejects.toBeDefined();
  });
  it('aborts in-flight approval and cancels upstream on consumer cancellation without a terminal execution leak', async () => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; }, cancel });
    let observed: AbortSignal | undefined;
    const config = { ...options(), onToolCall: vi.fn((_call: unknown, _context: unknown, signal: AbortSignal) => { observed = signal; return new Promise<Verdict>(() => {}); }) };
    const reader = transformResponsesStream(upstream, context, config).getReader();
    feed.enqueue(encoder.encode(wire(eventsFor([scenes.exec]).slice(0, 5))));
    await reader.read();
    const pending = reader.read();
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    await reader.cancel('fixture disconnect');
    await pending.catch(() => undefined);
    expect(observed?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('Responses nonstream parity and media boundary', () => {
  it('caps freeform input by its UTF-8 bytes, not a fabricated second JSON-string encoding', async () => {
    const input = '\n'.repeat(MAX_TOOL_BYTES / 2);
    let observed: unknown;
    const config = { ...options(), onToolCall: vi.fn(async (call: { input: unknown }) => { observed = call.input; return verdict('block'); }) };
    const response = await transformResponsesNonstream(jsonResponse([{ ...scenes.patch, name: 'fixture_raw_freeform', input }]), context, config);
    expect(config.onToolCall).toHaveBeenCalledOnce();
    expect(observed).toBe(input);
    expect(responseValue(await response.json()).output[0]).toMatchObject({ type: 'message' });
  });
  it.each(['completed', 'incomplete'])('rewrites only denied output items in %s and preserves usage/order', async status => {
    const config = { ...options(), onToolCall: vi.fn(async (call: { name: string }) => verdict(call.name === 'apply_patch' ? 'block' : 'allow')) };
    const input = [scenes.exec, scenes.text, scenes.patch, scenes.reasoning, scenes.local];
    const response = await transformResponsesNonstream(jsonResponse(input, status), context, config);
    const value = responseValue(await response.json());
    expect(value.status).toBe(status);
    expect(value.usage).toEqual(scenes.usage);
    expect(value.output[0]).toEqual(scenes.exec);
    expect(value.output[1]).toEqual(scenes.text);
    expect(value.output[2]).toMatchObject({ type: 'message', id: 'msg_amp_0', content: [{ text: expect.stringContaining('fixture-deny') }] });
    expect(value.output.slice(3)).toEqual(input.slice(3));
    expect(response.headers.get('x-fixture')).toBe('preserved');
    expect(response.headers.has('content-length')).toBe(false);
  });
  it('rejects duplicate execution IDs before any nonstream approval', async () => {
    const config = options();
    await expect(transformResponsesNonstream(jsonResponse([scenes.exec, { ...scenes.patch, call_id: scenes.exec.call_id }]), context, config)).rejects.toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects raw-below-cap nonstream aggregate over-cap before approval', async () => {
    const config = options();
    const output = [scenes.exec, { ...scenes.text, content: [{ type: 'output_text', text: 'x'.repeat(2_200_000), annotations: [] }] }];
    expect(encoder.encode(JSON.stringify(output)).byteLength).toBeLessThan(MAX_RESPONSE_BYTES);
    await expect(transformResponsesNonstream(jsonResponse(output), context, config)).rejects.toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects nonstream reasoning whose retained representations exceed the subset before approval', async () => {
    const config = options();
    const output = [scenes.exec, { ...scenes.reasoning, encrypted_content: 'x'.repeat(1_500_000) }];
    await expect(transformResponsesNonstream(jsonResponse(output), context, config)).rejects.toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('rejects duplicate nonstream output item IDs before approval even with distinct call IDs', async () => {
    const config = options();
    await expect(transformResponsesNonstream(jsonResponse([scenes.exec, { ...scenes.patch, id: scenes.exec.id }]), context, config)).rejects.toBeDefined();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
  it('keeps nonstream shadow bytes and headers unchanged despite a hypothetical denial', async () => {
    const pending = Promise.withResolvers<Verdict>();
    const observations: Promise<void>[] = [];
    const config = { ...options(), mode: 'shadow' as const, onToolCall: vi.fn(() => pending.promise), trackObservation: (work: Promise<void>) => { observations.push(work); } };
    const raw = ` {"status":"completed", "output": ${JSON.stringify([scenes.exec])}, "usage":${JSON.stringify(scenes.usage)}} `;
    const response = await transformResponsesNonstream(new Response(raw, { headers: { 'content-type': 'application/json', 'x-fixture': 'shadow' } }), context, config);
    expect(await response.text()).toBe(raw);
    expect(response.headers.get('x-fixture')).toBe('shadow');
    await vi.waitFor(() => expect(config.onToolCall).toHaveBeenCalledOnce());
    pending.resolve(verdict('block'));
    await Promise.all(observations);
  });
  it.each([undefined, 'text/plain', 'application/octet-stream'])('rejects unsupported generation media %s and cancels upstream', async media => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: media ? { 'content-type': media } : {} });
    const config = options();
    await expect(responsesAdapter.transformResponse(response, context, config)).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalled();
    expect(config.onToolCall).not.toHaveBeenCalled();
  });
});
