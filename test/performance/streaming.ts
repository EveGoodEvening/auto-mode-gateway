import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';

import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { parseSse } from '../../src/protocols/sse.js';
import type { SseFrame } from '../../src/protocols/sse.js';
import { encodeMockEvent, startLoopback, type MockProtocol } from '../integration/mock-relay.js';

const TEXT_EVENTS = 1000;
const DEADLINE_MS = 10_000;
const pieces = Array.from({ length: TEXT_EVENTS }, (_, index) => `${String(index).padStart(4, '0')}:é雪🙂\n`);
interface WireFrame { raw: string; text?: string }
interface Fixture { protocol: MockProtocol; endpoint: string; frames: WireFrame[] }
function requireSafe(condition: boolean, diagnostic: string): asserts condition {
  if (!condition) throw new Error(diagnostic);
}

async function boundedCleanup(cleanup: () => Promise<void>): Promise<void> {
  const expired = Promise.withResolvers<void>();
  const timer = setTimeout(() => expired.reject(new Error('Benchmark cleanup deadline expired')), 5000);
  try { await Promise.race([cleanup(), expired.promise]); }
  finally { clearTimeout(timer); }
}

// Complete protocol lifecycles, not 1000 orphan deltas. Lifecycle frames are
// counted separately; the performance denominator is exactly 1000 text deltas.
function fixture(protocol: MockProtocol): Fixture {
  const frames: WireFrame[] = [];
  const event = (type: string, value: Record<string, unknown>, text?: string) => frames.push({ raw: encodeMockEvent(type, { type, ...value }), text });
  const fullText = pieces.join('');
  if (protocol === 'anthropic-messages') {
    event('message_start', { message: { id: 'msg_perf', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const text of pieces) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }, text);
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: TEXT_EVENTS } });
    event('message_stop', {});
    return { protocol, endpoint: '/v1/messages', frames };
  }
  if (protocol === 'openai-responses') {
    let sequence = 0;
    const emit = (type: string, value: Record<string, unknown>, text?: string) => event(type, { sequence_number: sequence++, ...value }, text);
    const item = { id: 'msg_perf', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText, annotations: [] }] };
    const response = { id: 'resp_perf', object: 'response', created_at: 1, model: 'mock', status: 'in_progress', output: [] };
    emit('response.created', { response });
    emit('response.in_progress', { response });
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    const position = { output_index: 0, item_id: item.id, content_index: 0 };
    emit('response.content_part.added', { ...position, part: { type: 'output_text', text: '', annotations: [] } });
    for (const text of pieces) emit('response.output_text.delta', { ...position, delta: text }, text);
    emit('response.output_text.done', { ...position, text: fullText });
    emit('response.content_part.done', { ...position, part: item.content[0] });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: TEXT_EVENTS, total_tokens: TEXT_EVENTS + 1 } } });
    return { protocol, endpoint: '/v1/responses', frames };
  }
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, text?: string) => frames.push({ raw: `data: ${JSON.stringify({ id: 'chatcmpl_perf', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`, text });
  chunk({ role: 'assistant' });
  for (const text of pieces) chunk({ content: text }, null, text);
  chunk({}, 'stop');
  frames.push({ raw: 'data: [DONE]\n\n' });
  return { protocol, endpoint: '/v1/chat/completions', frames };
}

interface Producer {
  emittedEvents: number;
  emittedTextEvents: number;
  emittedBytes: number;
  finished: boolean;
  canceled: boolean;
  checkpoints: number;
  acknowledge(textEvents: number): void;
  release(): void;
}
function producer(wire: Fixture): { state: Producer; response: Response } {
  let cursor = 0;
  let resume: (() => void) | undefined;
  let checkpoint: Promise<void> | undefined;
  const state: Producer = {
    emittedEvents: 0, emittedTextEvents: 0, emittedBytes: 0, finished: false, canceled: false, checkpoints: 0,
    acknowledge(textEvents) {
      if ((textEvents === 1 || textEvents === 500) && resume) {
        requireSafe(!state.finished && state.emittedTextEvents === textEvents, 'Incremental checkpoint failed');
        state.checkpoints++;
        resume(); resume = undefined;
      }
    },
    release() { resume?.(); resume = undefined; },
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (checkpoint) { await checkpoint; checkpoint = undefined; }
      if (state.canceled) return;
      const next = wire.frames[cursor++];
      if (!next) { state.finished = true; controller.close(); return; }
      state.emittedEvents++;
      if (next.text !== undefined) {
        state.emittedTextEvents++;
        if (state.emittedTextEvents === 1 || state.emittedTextEvents === 500) {
          const gate = Promise.withResolvers<void>();
          checkpoint = gate.promise;
          resume = gate.resolve;
        }
      }
      const bytes = new TextEncoder().encode(next.raw);
      state.emittedBytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
    cancel() { state.canceled = true; state.release(); },
  }, { highWaterMark: 0 });
  return { state, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) };
}

export interface StreamMeasurement {
  first_event_ms: number;
  first_text_ms: number;
  total_ms: number;
  emitted_events: number;
  received_events: number;
  emitted_text_events: number;
  received_text_events: number;
  lifecycle_events: number;
  emitted_bytes: number;
  received_bytes: number;
  incremental_checkpoints: number;
  byte_order_parity: boolean;
}
export interface StreamingBenchmarkRow {
  protocol: MockProtocol;
  sample: number;
  proxy_first: boolean;
  direct: StreamMeasurement;
  proxy: StreamMeasurement;
  first_event_additional_ms: number;
  total_additional_ms: number;
  total_additional_ms_per_text_event: number;
  text_event_denominator: number;
  passed: boolean;
}

async function measure(url: string, wire: Fixture, takeProducer: () => Producer | undefined): Promise<StreamMeasurement> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
  const started = performance.now();
  let reader: ReadableStreamDefaultReader<SseFrame> | undefined;
  try {
    const response = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: 'Bearer fake-perf-client', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'mock', stream: true, max_tokens: 2000, ...(wire.protocol === 'openai-responses' ? { input: [{ role: 'user', content: 'Benchmark inert text' }] } : { messages: [{ role: 'user', content: 'Benchmark inert text' }] }) }),
    });
    requireSafe(response.status === 200 && response.body !== null, 'Benchmark HTTP response failed');
    reader = parseSse(response.body).getReader();
    let first = 0;
    let firstText = 0;
    let events = 0;
    let textEvents = 0;
    let bytes = 0;
    let parity = true;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const frame = next.value;
      try {
        const expected = wire.frames[events];
        if (events === 0) first = performance.now() - started;
        parity = parity && expected !== undefined && Buffer.from(frame.raw).equals(Buffer.from(expected.raw));
        bytes += frame.raw.byteLength;
        events++;
        requireSafe(events <= wire.frames.length && bytes <= 2 * 1024 * 1024, 'Benchmark output bound exceeded');
        if (expected?.text !== undefined) {
          if (textEvents === 0) firstText = performance.now() - started;
          textEvents++;
          // Producer cannot emit the suffix until the actual HTTP consumer has
          // parsed the first and 500th text frames. Buffered-whole-body fails.
          takeProducer()?.acknowledge(textEvents);
        }
      } finally { frame.release(); }
    }
    const total = performance.now() - started;
    const source = takeProducer();
    requireSafe(source !== undefined && source.finished && !source.canceled, 'Benchmark producer lifecycle failed');
    requireSafe(parity && events === wire.frames.length && textEvents === TEXT_EVENTS && source.emittedEvents === events && source.emittedTextEvents === textEvents && source.emittedBytes === bytes && source.checkpoints === 2, 'Benchmark event or byte parity failed');
    return { first_event_ms: first, first_text_ms: firstText, total_ms: total, emitted_events: source.emittedEvents, received_events: events, emitted_text_events: source.emittedTextEvents, received_text_events: textEvents, lifecycle_events: events - textEvents, emitted_bytes: source.emittedBytes, received_bytes: bytes, incremental_checkpoints: source.checkpoints, byte_order_parity: parity };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    takeProducer()?.release();
    if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  }
}

// Actual application HTTP surface; no ambient config, credentials, provider
// traffic, native tools, subprocesses or timer-derived fake measurements.
export async function runStreamingBenchmark(report: (row: StreamingBenchmarkRow) => void = (row) => { console.log(JSON.stringify(row)); }): Promise<StreamingBenchmarkRow[]> {
  const directory = await mkdtemp(join(tmpdir(), 'amp-performance-'));
  const cleanups: (() => Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
  const rows: StreamingBenchmarkRow[] = [];
  let active: Producer | undefined;
  try {
    for (const protocol of ['anthropic-messages', 'openai-responses', 'openai-chat'] as const) {
      const wire = fixture(protocol);
      let unexpectedRequests = 0;
      const relayApp = new Hono();
      relayApp.post(wire.endpoint, () => { const source = producer(wire); active = source.state; return source.response; });
      // No decision endpoint is configured outside this owned relay, and a
      // pure-text run must not attempt any decision request at all.
      relayApp.all('*', () => { unexpectedRequests++; return Response.json({ error: 'Unexpected benchmark request' }, { status: 500 }); });
      const relay = await startLoopback(relayApp);
      cleanups.push(relay.close);
      const app = createApp(configSchema.parse({
        auth: { mode: 'vault', client_tokens: ['fake-perf-client'] },
        routes: [{ prefix: '/benchmark', protocol, upstream: 'mock', ...(protocol === 'anthropic-messages' ? { claude_delivery: 'rewrite' } : {}) }],
        upstreams: { mock: { base_url: relay.url, api_key: 'fake-perf-upstream' } },
        decision: { chain: ['mock'], providers: { mock: { kind: 'systemone', base_url: relay.url, api_key: 'fake-perf-decision', model: 'mock' } } },
        audit: { path: join(directory, `${protocol}.jsonl`) }, log_level: 'error',
      }));
      cleanups.push(app.flushAudit);
      const gateway = await startLoopback(app);
      cleanups.push(gateway.close);
      const run = async (proxy: boolean) => { active = undefined; return measure(proxy ? gateway.url + '/benchmark' + wire.endpoint : relay.url + wire.endpoint, wire, () => active); };
      // Warm-up is explicit and excluded from measurements, never invented rows.
      await run(false); await run(true);
      for (let sample = 1; sample <= 3; sample++) {
        const proxyFirst = sample % 2 === 0;
        const first = await run(proxyFirst);
        const second = await run(!proxyFirst);
        const direct = proxyFirst ? second : first;
        const proxy = proxyFirst ? first : second;
        const additional = proxy.total_ms - direct.total_ms;
        const row: StreamingBenchmarkRow = {
          protocol, sample, proxy_first: proxyFirst, direct, proxy,
          first_event_additional_ms: proxy.first_event_ms - direct.first_event_ms,
          total_additional_ms: additional, total_additional_ms_per_text_event: additional / proxy.received_text_events,
          text_event_denominator: proxy.received_text_events,
          passed: proxy.first_event_ms - direct.first_event_ms < 50 && additional / proxy.received_text_events < 5,
        };
        rows.push(row); report(row);
      }
      requireSafe(unexpectedRequests === 0, 'Unexpected benchmark provider or upstream traffic');
    }
    requireSafe(rows.every((row) => row.passed), 'Strict mock streaming performance threshold failed');
    return rows;
  } finally {
    active?.release();
    // Run every cleanup even if another cleanup fails; do not turn failures into
    // success or print private exception/configuration data.
    let cleanupFailed = false;
    for (const cleanup of cleanups.reverse()) { try { await boundedCleanup(cleanup); } catch { cleanupFailed = true; } }
    requireSafe(!cleanupFailed, 'Benchmark cleanup failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStreamingBenchmark().then(() => {
    console.log(JSON.stringify({ mock_streaming_passed: true, real_provider_tool_tail_measured: false }));
  }, () => {
    console.error(JSON.stringify({ mock_streaming_passed: false, real_provider_tool_tail_measured: false }));
    process.exitCode = 1;
  });
}
