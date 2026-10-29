import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
}

// Real Node HTTP ingress and response consumption; only outbound fetch is
// replaced with an explicitly allowlisted fake relay stream. No logger or
// protocol adapter is mocked, and no fixture content is executed.
describe('Node adapter response-stream privacy boundary', () => {
  it.each(['before-initial-bytes', 'after-observed-prefix'] as const)('preserves visible failure and cancellation without private diagnostics %s', async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), 'amp-stream-security-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const credential = 'fake-stream-upstream-credential-7701';
    const privateMarker = 'fake-private-tool-input-marker-7702';
    const relayUrl = 'http://127.0.0.1:1/v1/messages';
    const providerBase = 'http://127.0.0.1:2';
    const config = configSchema.parse({
      auth: { mode: 'vault', client_tokens: ['fake-stream-client-7703'] },
      upstreams: { fake: { base_url: 'http://127.0.0.1:1', api_key: credential } },
      routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'fake', claude_delivery: 'native' }],
      decision: { chain: ['fake'], providers: { fake: { kind: 'systemone', base_url: providerBase, api_key: 'fake-stream-provider-7704', model: 'fake-model' } } },
      audit: { path: join(directory, 'audit.jsonl') },
      log_level: 'silent',
    });
    const prefix = ': safe-prefix-comment\r\nid: safe-prefix-id\r\nretry: 1500\r\n\r\n'
      + frame({ type: 'message_start', message: { id: 'safe-message-id', type: 'message', content: [] } })
      + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Safe early text' } })
      + frame({ type: 'content_block_stop', index: 0 })
      + frame({ type: 'ping' });
    const prefixBytes = Buffer.from(prefix);
    // Missing closing quote/object: partial-json can recover these strings into
    // a diagnostic, but they must never escape through the Node adapter's sink.
    const malformed = frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'private-withheld-tool', name: 'Bash', input: {} } })
      + frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: `{"command":"${credential} ${privateMarker}` } })
      + frame({ type: 'content_block_stop', index: 1 });
    const releaseMalformed = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<boolean>();
    let sourceCanceled = false;
    let upstreamAborted = false;
    let upstreamCalls = 0;
    let providerCalls = 0;
    let unexpectedCalls = 0;
    let sourceStep = 0;
    let diagnosticOutput = '';
    let diagnosticBytes = 0;
    let diagnosticOverflow = false;
    function captureDiagnostic(text: string) {
      const bytes = Buffer.byteLength(text);
      if (bytes > 128 * 1024 - diagnosticBytes) {
        diagnosticOverflow = true;
        return;
      }
      diagnosticBytes += bytes;
      diagnosticOutput += text;
    }
    // This is the actual Node adapter console.error sink, formatting the real
    // error objects as console output would. Pino is not replaced or echoed.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { captureDiagnostic(`${format(...args)}\n`); });
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...args: unknown[]) => {
      captureDiagnostic(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      const callback = args.find((value) => typeof value === 'function');
      if (callback) (callback as () => void)();
      return true;
    }) as typeof process.stderr.write);
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== relayUrl) {
        if (url.startsWith(providerBase)) providerCalls++;
        else unexpectedCalls++;
        throw new Error('Unexpected fake relay destination');
      }
      upstreamCalls++;
      const signal = init?.signal;
      const abort = () => { upstreamAborted = true; canceled.resolve(true); };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sourceStep === 0) {
            sourceStep = 1;
            if (phase === 'after-observed-prefix') {
              controller.enqueue(new TextEncoder().encode(prefix));
              return;
            }
          }
          if (sourceStep === 1) {
            if (phase === 'after-observed-prefix') await releaseMalformed.promise;
            sourceStep = 2;
            controller.enqueue(new TextEncoder().encode(malformed));
          }
          // Deliberately remain open: failure must cancel the source, not merely
          // consume an already-closed fixture and pretend cancellation occurred.
        },
        cancel() { sourceCanceled = true; canceled.resolve(true); },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    });

    const app = createApp(config);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    cleanups.push(async () => {
      releaseMalformed.resolve();
      const closed = once(server, 'close');
      server.close();
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await closed;
      await app.flushAudit();
    });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing owned test listener');
    const completed = Promise.withResolvers<void>();
    let status: number | undefined;
    let transportFailed = false;
    let ended = false;
    let deadlineExpired = false;
    let captureOverflow = false;
    let prefixObserved = false;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    let response: IncomingMessage | undefined;
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, path: '/cc/v1/messages', method: 'POST',
      agent: false,
      headers: { authorization: `Bearer ${config.auth.client_tokens[0]!}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    }, (incoming) => {
      response = incoming;
      status = incoming.statusCode;
      incoming.on('data', (chunk: Buffer) => {
        if (chunk.byteLength > 128 * 1024 - receivedBytes) {
          captureOverflow = true;
          request.destroy();
          completed.resolve();
          return;
        }
        receivedBytes += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
        if (phase === 'after-observed-prefix' && receivedBytes >= prefixBytes.byteLength) {
          prefixObserved = Buffer.concat(chunks).subarray(0, prefixBytes.byteLength).equals(prefixBytes);
          releaseMalformed.resolve();
        }
      });
      incoming.once('end', () => { ended = true; completed.resolve(); });
      incoming.once('aborted', () => { transportFailed = true; completed.resolve(); });
      incoming.once('error', () => { transportFailed = true; completed.resolve(); });
      incoming.once('close', () => {
        if (!incoming.complete) transportFailed = true;
        completed.resolve();
      });
    });
    request.once('error', () => { transportFailed = true; completed.resolve(); });
    // Real platform HTTP requires watchdogs for owned-socket cleanup; fixture
    // progression and success await actual byte/cancellation events, not sleeps.
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      releaseMalformed.resolve();
      request.destroy();
      completed.resolve();
    }, 5000);
    try {
      request.end(JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: 'Safe request' }] }));
      await completed.promise;
      // This bounds a missing cancellation signal; successful runs do not wait.
      const cancellationDeadline = setTimeout(() => canceled.resolve(false), 1000);
      let cancellationObserved: boolean;
      try { cancellationObserved = await canceled.promise; }
      finally { clearTimeout(cancellationDeadline); }
      const output = Buffer.concat(chunks);
      expect(deadlineExpired).toBe(false);
      expect(captureOverflow).toBe(false);
      expect(diagnosticOverflow).toBe(false);
      expect(upstreamCalls).toBe(1);
      expect(providerCalls).toBe(0);
      expect(unexpectedCalls).toBe(0);
      expect(cancellationObserved && (sourceCanceled || upstreamAborted)).toBe(true);
      expect((status !== undefined && status >= 400) || transportFailed).toBe(true);
      expect(status === 200 && ended && !transportFailed).toBe(false);
      if (phase === 'after-observed-prefix') {
        expect(prefixObserved).toBe(true);
        expect(output.subarray(0, prefixBytes.byteLength).equals(prefixBytes)).toBe(true);
      }
      // Boolean privacy assertions keep captured private diagnostics out of
      // assertion-failure reports, including when run against vulnerable code.
      for (const secret of [credential, privateMarker]) {
        expect(diagnosticOutput.includes(secret)).toBe(false);
        expect(output.includes(Buffer.from(secret))).toBe(false);
      }
      for (const executable of ['tool_use', 'input_json_delta', 'private-withheld-tool', 'safeguard_results']) {
        expect(output.includes(Buffer.from(executable))).toBe(false);
      }
    } finally {
      clearTimeout(deadline);
      releaseMalformed.resolve();
      response?.destroy();
      request.destroy();
    }
  }, 10_000);
});
