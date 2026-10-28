import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSse, MAX_SSE_FRAME_BYTES, parseSse, pingKeepalive, type SseFrame } from '../../src/protocols/sse.js';

const encoder = new TextEncoder();
function bytes(value: string) { return encoder.encode(value); }
function source(chunks: Uint8Array[]) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === chunks.length) controller.close();
      else controller.enqueue(chunks[offset++]!);
    },
  }, { highWaterMark: 0 });
}
async function collect(stream: ReadableStream<SseFrame>) {
  const frames: SseFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}
function join(frames: SseFrame[]) { return Buffer.concat(frames.map((frame) => Buffer.from(encodeSse(frame)))); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('raw SSE framing', () => {
  it('replays comments, CRLF, BOM, unknown fields/events, retry and multiline data byte-for-byte', async () => {
    const raw = await readFile(new URL('../fixtures/sse/mixed.sse', import.meta.url));
    const frames = await collect(parseSse(source([raw])));
    expect(join(frames)).toEqual(raw);
    expect(frames).toHaveLength(4);
    expect(frames[0]).toMatchObject({ complete: true, event: 'future_event', id: 'turn-1', data: 'hello 🌍\nsecond line' });
    expect(frames[1]?.data).toBeUndefined();
    expect(frames[2]).toMatchObject({ complete: true, data: '' });
    expect(frames[2]?.id).toBeUndefined();
    expect(frames[3]).toMatchObject({ complete: true, data: 'final' });
    expect(Object.isFrozen(frames[0])).toBe(true);
    expect(encodeSse(frames[0]!)).toBe(frames[0]!.raw);
  });

  it('handles every two-chunk split including CRLF and UTF-8 code points', async () => {
    const raw = await readFile(new URL('../fixtures/sse/mixed.sse', import.meta.url));
    for (let split = 0; split <= raw.length; split++) {
      const frames = await collect(parseSse(source([raw.subarray(0, split), raw.subarray(split)])));
      expect(join(frames), `split ${split}`).toEqual(raw);
      expect(frames[0]?.data, `split ${split}`).toBe('hello 🌍\nsecond line');
      expect(frames).toHaveLength(4);
    }
  });

  it('handles one-byte chunks and mixed bare CR/LF blank-line boundaries', async () => {
    const raw = bytes('data: α\r\ndata: β\r\rdata: γ\n\ndata: δ\r\n\r\n');
    const frames = await collect(parseSse(source(Array.from(raw, (byte) => new Uint8Array([byte])))));
    expect(join(frames)).toEqual(Buffer.from(raw));
    expect(frames.map((frame) => frame.data)).toEqual(['α\nβ', 'γ', 'δ']);
    expect(frames.every((frame) => frame.complete)).toBe(true);
  });

  it('keeps invalid UTF-8 raw while exposing parser replacement characters only in the sidecar', async () => {
    const raw = new Uint8Array([...bytes('data: '), 255, ...bytes('\n\n')]);
    const frames = await collect(parseSse(source([raw])));
    expect(frames[0]?.data).toBe('�');
    expect(join(frames)).toEqual(Buffer.from(raw));
  });

  it('treats a leading BOM as metadata, but retains later BOM characters', async () => {
    const raw = bytes('\uFEFF\r\ndata: \uFEFFvalue\n\n');
    const frames = await collect(parseSse(source(Array.from(raw, (byte) => new Uint8Array([byte])))));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.data).toBeUndefined();
    expect(frames[1]?.data).toBe('\uFEFFvalue');
    expect(join(frames)).toEqual(Buffer.from(raw));
  });

  it('does not carry id or event across frame boundaries (eventsource-parser v3)', async () => {
    const frames = await collect(parseSse(source([bytes('id: 1\nevent: custom\ndata: a\n\ndata: b\n\n')])));
    expect(frames[0]).toMatchObject({ id: '1', event: 'custom', data: 'a' });
    expect(frames[1]?.id).toBeUndefined();
    expect(frames[1]?.event).toBeUndefined();
  });

  it('marks EOF residual incomplete without dispatching its unclosed data', async () => {
    const raw = await readFile(new URL('../fixtures/sse/incomplete.sse', import.meta.url));
    const frames = await collect(parseSse(source([raw])));
    expect(join(frames)).toEqual(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ complete: false });
    expect(frames[0]?.data).toBeUndefined();
    expect(await collect(parseSse(source([])))).toEqual([]);
  });

  it('accepts exactly the hard limit and cancels upstream on one byte beyond it', async () => {
    const raw = bytes(`data: ${'a'.repeat(MAX_SSE_FRAME_BYTES - 8)}\n\n`);
    const frames = await collect(parseSse(source([raw])));
    expect(frames[0]?.raw.byteLength).toBe(MAX_SSE_FRAME_BYTES);
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_SSE_FRAME_BYTES + 1).fill(97)); },
      cancel,
    });
    await expect(collect(parseSse(upstream))).rejects.toThrow('SSE frame exceeds byte limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
  });

  it('counts delimiter bytes and bounds accumulated tiny chunks', async () => {
    const cancel = vi.fn();
    let index = 0;
    const input = bytes('data: x\n\n');
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(input.subarray(index, ++index)); },
      cancel,
    }, { highWaterMark: 0 });
    await expect(collect(parseSse(upstream, { maxFrameBytes: 8 }))).rejects.toThrow('byte limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => parseSse(source([]), { maxFrameBytes: MAX_SSE_FRAME_BYTES + 1 })).toThrow(RangeError);
    expect(() => parseSse(source([]), { maxFrameBytes: 0 })).toThrow(RangeError);
  });

  it('honors downstream backpressure and propagates cancellation without reading another chunk', async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(bytes('data: first\n\ndata: second\n\n')));
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const reader = parseSse(upstream).getReader();
    expect(pull).not.toHaveBeenCalled();
    expect((await reader.read()).value?.data).toBe('first');
    expect(pull).toHaveBeenCalledOnce();
    expect((await reader.read()).value?.data).toBe('second');
    expect(pull).toHaveBeenCalledOnce();
    await reader.cancel('client disconnected');
    expect(cancel).toHaveBeenCalledWith('client disconnected');
    expect(upstream.locked).toBe(false);
  });

  it('cancels a pending upstream read and propagates source failures', async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const reader = parseSse(upstream).getReader();
    const pending = reader.read();
    await reader.cancel('abort');
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(cancel).toHaveBeenCalledWith('abort');
    const failed = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('mock failure')); } });
    await expect(collect(parseSse(failed))).rejects.toThrow('mock failure');
    expect(failed.locked).toBe(false);
  });
});

describe('explicit SSE rewriting', () => {
  it('encodes only modified semantic objects and preserves multiline semantics', async () => {
    const encoded = encodeSse({ event: 'changed', id: '42', retry: 25, data: 'first\nsecond\n' });
    expect(new TextDecoder().decode(encoded)).toBe('event: changed\nid: 42\nretry: 25\ndata: first\ndata: second\ndata: \n\n');
    expect((await collect(parseSse(source([encoded]))))[0]).toMatchObject({ event: 'changed', id: '42', data: 'first\nsecond\n' });
  });
  it('rejects field injection and invalid retry values', () => {
    expect(() => encodeSse({ event: 'x\ndata: forged' })).toThrow(TypeError);
    expect(() => encodeSse({ id: 'x\0y' })).toThrow(TypeError);
    expect(() => encodeSse({ retry: -1 })).toThrow(TypeError);
    expect(() => encodeSse({ retry: 1.5 })).toThrow(TypeError);
  });
});

describe('held-only keepalive', () => {
  it('emits only while held, forwards the original bytes, and cleans up on EOF', async () => {
    vi.useFakeTimers();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const keepalive = pingKeepalive(100, bytes(': held\n\n'));
    const reader = keepalive.wrap(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }, { highWaterMark: 0 })).getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
    keepalive.setHeld(true);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).value).toEqual(bytes(': held\n\n'));
    expect(vi.getTimerCount()).toBe(0); // no tick queue while downstream pauses
    const next = reader.read();
    keepalive.setHeld(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    const original = bytes('data: original\n\n');
    upstream.enqueue(original);
    expect((await next).value).toBe(original);
    upstream.close();
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels upstream and removes its timer during a pending held read', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const keepalive = pingKeepalive(100);
    keepalive.setHeld(true);
    const sourceStream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const reader = keepalive.wrap(sourceStream).getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel('disconnect');
    expect((await pending).done).toBe(true);
    expect(cancel).toHaveBeenCalledWith('disconnect');
    expect(vi.getTimerCount()).toBe(0);
    expect(sourceStream.locked).toBe(false);
  });

  it('close disables pings without closing the upstream stream', async () => {
    vi.useFakeTimers();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const keepalive = pingKeepalive(100, () => bytes(': generated\n\n'));
    keepalive.setHeld(true);
    const reader = keepalive.wrap(new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } })).getReader();
    const pending = reader.read();
    keepalive.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    upstream.enqueue(bytes('data: after\n\n'));
    expect((await pending).value).toEqual(bytes('data: after\n\n'));
    await reader.cancel();
  });
});
