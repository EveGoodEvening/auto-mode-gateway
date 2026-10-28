import type { Config } from '../config/schema.js';
import { upstreamErrorResponse } from './errors.js';

const hopHeaders = [
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'host', 'content-length',
];

function endToEndHeaders(source: Headers): Headers {
  const excluded = new Set(hopHeaders);
  for (const name of (source.get('connection') ?? '').split(',')) {
    excluded.add(name.trim().toLowerCase());
  }
  const result = new Headers();
  for (const [name, value] of source) {
    if (!excluded.has(name) && !name.startsWith('proxy-') && name !== 'set-cookie') {
      result.append(name, value);
    }
  }
  if (!excluded.has('set-cookie')) {
    for (const cookie of source.getSetCookie()) result.append('set-cookie', cookie);
  }
  return result;
}

function targetUrl(base: string, path: string): string {
  // Never resolve a client-supplied //path against the upstream: that could
  // change the destination and expose the already-replaced credentials.
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/$/, '');
  const relativePath = /\/v1$/.test(basePath) && /^\/v1(?:\/|\?|$)/.test(path) ? path.slice(3) : path;
  const suffix = relativePath.startsWith('/') || relativePath.startsWith('?') || relativePath === ''
    ? relativePath : `/${relativePath}`;
  return `${target.origin}${basePath}${suffix}`;
}

export async function forwardUpstream(
  request: Request,
  upstream: Config['upstreams'][string],
  path: string,
  config: Config,
  options?: { signal?: AbortSignal; onError?: (status: 502 | 504) => void },
): Promise<Response> {
  const controller = new AbortController();
  const signals = [request.signal, options?.signal].filter((signal): signal is AbortSignal => !!signal);
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const cleanup = () => {
    clearTimer();
    for (const signal of signals) signal.removeEventListener('abort', abort);
  };
  const deadline = (milliseconds: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(milliseconds, 2_147_483_647));
    timer.unref();
  };
  const reportFailure = (): 502 | 504 => {
    const status = timedOut ? 504 : 502;
    // Never log URLs, credentials, request bodies or arbitrary exception values.
    if (!signals.some((signal) => signal.aborted)) {
      if (options?.onError) options.onError(status);
      else console.error(status === 504 ? 'Upstream request timed out (504)' : 'Upstream connection failed (502)');
    }
    return status;
  };
  const read = async () => {
    deadline(config.limits.upstream_read_timeout_ms);
    try {
      return await reader!.read();
    } finally {
      clearTimer();
    }
  };

  try {
    const headers = endToEndHeaders(request.headers);
    headers.set('accept-encoding', 'identity');
    deadline(config.limits.upstream_connect_timeout_ms);
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      signal: controller.signal,
      // Return redirects as received; never send credentials to a second target.
      redirect: 'manual',
    };
    if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
      init.duplex = 'half';
    }
    const response = await fetch(targetUrl(upstream.base_url, path), init);
    clearTimer();
    const responseHeaders = endToEndHeaders(response.headers);
    // Node fetch decodes these even if a server ignores identity. Do not attach
    // stale encoding metadata to the decoded bytes returned by fetch.
    const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
    if (encoding && /^(?:(?:x-)?gzip|deflate|br)(?:\s*,\s*(?:(?:x-)?gzip|deflate|br))*$/.test(encoding)) {
      responseHeaders.delete('content-encoding');
    }
    if (response.body === null) {
      cleanup();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    }
    reader = response.body.getReader();
    // Prime one chunk, not a complete response. An initial body timeout can
    // still become a 504 before downstream response headers are committed.
    const first = await read();
    if (first.done) {
      reader.releaseLock();
      cleanup();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    }
    let initial: Uint8Array | undefined = first.value;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          if (initial !== undefined) {
            stream.enqueue(initial);
            initial = undefined;
            return;
          }
          const chunk = await read();
          if (chunk.done) {
            reader!.releaseLock();
            cleanup();
            stream.close();
          } else {
            stream.enqueue(chunk.value);
          }
        } catch {
          reportFailure();
          controller.abort();
          cleanup();
          // Once streaming has started HTTP status cannot be replaced by 504.
          stream.error(new Error(timedOut ? 'Upstream read timed out' : 'Upstream stream closed'));
        }
      },
      async cancel() {
        controller.abort();
        cleanup();
        try { await reader!.cancel(); } catch { /* Aborted fetch may already have closed the reader. */ }
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch {
    const status = reportFailure();
    controller.abort();
    cleanup();
    if (reader) {
      try { await reader.cancel(); } catch { /* Transport already failed. */ }
    }
    return upstreamErrorResponse(status);
  }
}
