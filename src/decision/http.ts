import { DecisionError, type DecisionOptions } from './types.js';

export const DECISION_BUDGET_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export function decisionDeadline(options: DecisionOptions = {}): number {
  return Math.min(options.deadline_ms ?? Infinity, Date.now() + DECISION_BUDGET_MS);
}

/** Race even non-cooperative injected providers against cancellation; drain late rejection. */
export async function withinDeadline<T>(run: (signal: AbortSignal) => Promise<T>, deadline: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const { promise: cancelled, reject } = Promise.withResolvers<never>();
  const stop = (code: 'aborted' | 'timeout') => {
    controller.abort();
    reject(new DecisionError(code));
  };
  const onAbort = () => stop('aborted');
  if (parent?.aborted) stop('aborted');
  else if (deadline <= Date.now()) stop('timeout');
  else {
    parent?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('timeout'), deadline - Date.now());
  }
  try {
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([run(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

async function waitForRetry(ms: number, deadline: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || Date.now() + ms >= deadline) throw new DecisionError('timeout');
  await withinDeadline((abort) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => { abort.removeEventListener('abort', stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); reject(new DecisionError('aborted')); }
    abort.addEventListener('abort', stop, { once: true });
    return promise;
  }, deadline, signal);
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new DecisionError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new DecisionError('invalid_response');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; }
    catch { throw new DecisionError('invalid_response'); }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Two attempts maximum, only on a timeout or 429/529. Redirects never receive credentials. */
export async function postDecisionJson(url: string, headers: Headers, body: string, timeoutMs: number, options: DecisionOptions = {}): Promise<unknown> {
  const deadline = decisionDeadline(options);
  for (let attempt = 0; attempt < 2; attempt++) {
    let retryDelay = 0;
    try {
      const result = await withinDeadline(async (signal) => {
        const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal });
        if (!response.ok) {
          const retry = response.status === 429 || response.status === 529;
          const delay = retryAfterMs(response.headers.get('retry-after'));
          await response.body?.cancel();
          if (retry) return { retry: true as const, delay };
          throw new DecisionError('http');
        }
        return { retry: false as const, value: await readJson(response) };
      }, Math.min(deadline, Date.now() + timeoutMs), options.signal);
      if (!result.retry) return result.value;
      if (attempt === 1) throw new DecisionError('http');
      retryDelay = result.delay;
    } catch (error) {
      if (options.signal?.aborted) throw new DecisionError('aborted');
      if (error instanceof DecisionError) {
        if (error.code !== 'timeout' || attempt === 1 || Date.now() >= deadline) throw error;
      } else {
        throw new DecisionError('transport');
      }
    }
    await waitForRetry(retryDelay, deadline, options.signal);
  }
  throw new DecisionError('exhausted');
}
