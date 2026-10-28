/** Parent-only installed Codex / loopback MOCK proof; imports never launch.
 * ~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/codex-smoke.ts
 * Finite gated launch: async:true, timeout:0. Not real-provider/Desktop evidence.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { HttpBindings } from '@hono/node-server';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { parseSse } from '../../src/protocols/sse.js';
import { extractLatestUserText } from '../../src/protocols/request-context.js';
import { parseShell } from '../../src/policy/shell-parse.js';
import { canonical } from '../../src/gate/cache.js';
import { attachCliProcess } from './claude-smoke.js';
import { createMockDecision } from '../integration/mock-decision.js';
import { createMockRelay, startLoopback, type RecordedRequest, type RelayScene } from '../integration/mock-relay.js';

export const CODEX_PROBE = 'printf AMP_DENIAL_PROBE';
export const CODEX_ALLOW_PROBE = 'printf AMP_CODEX_ALLOW_PROBE';
const MAX_CAPTURE = 8 * 1024 * 1024;
const RUN_TIMEOUT_MS = 240_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CODEX_FIXTURE_MODEL = 'gpt-5.5';

export interface CodexNativeUserExpectation {
  probeId: string;
  requestId: string;
  turnOrdinal: number;
  prompt: string;
}
export interface CodexNativeScope {
  directory: string;
  threadId: string;
  model: string;
  provider: string;
  mode: '--yolo' | '--approve-for-me';
  turnCount: number;
  expected: readonly CodexNativeUserExpectation[];
}
export interface CodexNativeUserIdentity extends CodexNativeUserExpectation {
  readonly threadId: string;
  readonly turnId: string;
  readonly inputId: string;
  readonly model: string;
  readonly taskRecordIndex: number;
  readonly contextRecordIndex: number;
  readonly inputRecordIndex: number;
  readonly userEventRecordIndex: number;
  readonly source: Readonly<{ path: string; bytes: number; sha256: string }>;
}
const nativeIdentityProofs = new WeakSet<CodexNativeUserIdentity>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NATIVE_INPUT_ID = /^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Independent producer evidence only: this API never receives candidate HTTP input. */
export async function readCodexNativeUsers(scope: CodexNativeScope, run: CodexRunDeadline, chargeCapture: (bytes: number) => void): Promise<ReadonlyMap<string, CodexNativeUserIdentity>> {
  const invalid = () => new Error('Native Codex input identity evidence invalid or unavailable');
  run.check();
  let charged = 0;
  const charge = (bytes: number) => {
    run.check();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CAPTURE - charged) throw invalid();
    chargeCapture(bytes); run.check(); charged += bytes;
  };
  if (!Array.isArray(scope.expected) || scope.expected.length > scope.turnCount) throw invalid();
  charge((scope.directory.length + scope.model.length + scope.provider.length + scope.threadId.length) * 2 + 128);
  if (!UUID.test(scope.threadId) || scope.directory !== resolve(scope.directory) || !scope.model || !scope.provider
    || !Number.isSafeInteger(scope.turnCount) || scope.turnCount < 1 || scope.turnCount > 32
    || !['--yolo', '--approve-for-me'].includes(scope.mode)) throw invalid();
  const byOrdinal = new Map<number, CodexNativeUserExpectation>();
  const probeIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const expected of scope.expected) {
    if (!expected.probeId || !expected.requestId || !Number.isSafeInteger(expected.turnOrdinal)
      || expected.turnOrdinal < 1 || expected.turnOrdinal > scope.turnCount || expected.prompt !== normalTurnPrompt(expected.turnOrdinal)
      || byOrdinal.has(expected.turnOrdinal) || probeIds.has(expected.probeId) || requestIds.has(expected.requestId)) throw invalid();
    charge((expected.probeId.length + expected.requestId.length + expected.prompt.length) * 2 + 128);
    byOrdinal.set(expected.turnOrdinal, expected); probeIds.add(expected.probeId); requestIds.add(expected.requestId);
  }
  if (byOrdinal.size === 0) return new Map();
  const checkedDirectory = async (path: string) => {
    const stat = await run.step(() => lstat(path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || await run.step(() => realpath(path)) !== path) throw invalid();
  };
  const home = join(scope.directory, 'home');
  const codexHome = join(home, '.codex');
  const sessions = join(codexHome, 'sessions');
  for (const path of [scope.directory, home, codexHome, sessions, join(scope.directory, 'workspace')]) await checkedDirectory(path);
  const files: string[] = [];
  let entries = 0;
  const discover = async (directory: string, depth: number): Promise<void> => {
    await checkedDirectory(directory);
    const owned = await run.step(() => opendir(directory, { bufferSize: 1 }).then((handle) => {
      let closing: Promise<void> | undefined;
      const close = () => closing ??= handle.close();
      return { handle, close, untrack: run.onShutdown(close) };
    }));
    try {
      await checkedDirectory(directory);
      while (true) {
        const entry = await run.step(() => owned.handle.read());
        if (!entry) break;
        if (++entries > 32) throw invalid();
        charge((directory.length + entry.name.length + 1) * 2 + 64);
        const path = join(directory, entry.name);
        const stat = await run.step(() => lstat(path));
        if (stat.isSymbolicLink()) throw invalid();
        if (stat.isDirectory()) {
          if (depth >= 3 || !(depth === 0 ? /^\d{4}$/u : /^\d{2}$/u).test(entry.name)) throw invalid();
          await discover(path, depth + 1);
        } else if (stat.isFile() && depth === 3 && entry.name.startsWith('rollout-')
          && entry.name.endsWith(`-${scope.threadId}.jsonl`)) files.push(path);
        else throw invalid();
      }
    } finally {
      const closing = run.observe(owned.close());
      await run.step(() => closing);
      owned.untrack();
    }
  };
  await discover(sessions, 0);
  // Finish discovery before accepting a file: another session is ambiguous.
  if (files.length !== 1 || typeof constants.O_NOFOLLOW !== 'number') throw invalid();
  const path = files[0]!;
  if (await run.step(() => realpath(path)) !== path) throw invalid();
  const owned = await run.step(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW).then((handle) => {
    let closing: Promise<void> | undefined;
    const close = () => closing ??= handle.close();
    return { handle, close, untrack: run.onShutdown(close) };
  }));
  try {
    const before = await run.step(() => owned.handle.stat());
    const named = await run.step(() => lstat(path));
    if (!before.isFile() || before.nlink !== 1 || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())
      || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > MAX_CAPTURE) throw invalid();
    charge(before.size + 1);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(64 * 1024, bytes.length - offset);
      const read = await run.step(() => owned.handle.read(bytes, offset, count, offset));
      if (read.bytesRead === 0) throw invalid();
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await run.step(() => owned.handle.read(extra, 0, 1, bytes.length))).bytesRead !== 0) throw invalid();
    const after = await run.step(() => owned.handle.stat());
    const namedAfter = await run.step(() => lstat(path));
    if (namedAfter.isSymbolicLink() || namedAfter.ino !== before.ino || namedAfter.dev !== before.dev
      || await run.step(() => realpath(path)) !== path) throw invalid();
    if (before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.at(-1) !== 10
      || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw invalid();
    const source = Object.freeze({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const responseIds = new Map<string, number>();
    const promptCounts = new Map<number, number>();
    const userEventPromptCounts = new Map<number, number>();
    type InputTurn = { id: string; ordinal: number; task: number; context?: number; contexts: number; users: number; events: number; closed: boolean; input?: { id: string; index: number }; event?: number };
    const turns = new Map<string, InputTurn>();
    const bound = new Map<number, InputTurn>();
    let active: InputTurn | undefined;
    let sessionCount = 0;
    let recordIndex = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const matches = (value: unknown, prompt: string, event = false) => {
      if (!Array.isArray(value) || value.length !== 1) return false;
      const part = object(value[0]);
      return part?.type === (event ? 'text' : 'input_text') && part.text === prompt
        && Object.keys(part).length === (event ? 3 : 2)
        && (!event || (Array.isArray(part.text_elements) && part.text_elements.length === 0));
    };
    for (let start = 0; start < bytes.length; recordIndex++) {
      run.check();
      const end = bytes.indexOf(10, start);
      if (end <= start) throw invalid();
      charge((end - start) * 3);
      const value: unknown = JSON.parse(decoder.decode(bytes.subarray(start, end)));
      start = end + 1;
      const record = object(value);
      const payload = object(record?.payload);
      if (typeof record?.type !== 'string' || !payload) throw invalid();
      if (record.type === 'session_meta') {
        sessionCount++;
        if (sessionCount !== 1 || payload.id !== scope.threadId
          || payload.source !== 'exec' || payload.originator !== 'codex_exec' || payload.cli_version !== '0.164.0'
          || payload.model_provider !== scope.provider || payload.cwd !== join(scope.directory, 'workspace')) throw invalid();
      } else if (record.type === 'event_msg' && payload.type === 'task_started') {
        if (sessionCount !== 1 || typeof payload.turn_id !== 'string' || !UUID.test(payload.turn_id) || turns.has(payload.turn_id) || turns.size >= scope.turnCount) throw invalid();
        active = { id: payload.turn_id, ordinal: turns.size + 1, task: recordIndex, contexts: 0, users: 0, events: 0, closed: false };
        turns.set(active.id, active);
        if (byOrdinal.has(active.ordinal)) bound.set(active.ordinal, active);
      } else if (record.type === 'turn_context') {
        const recordedTurn = typeof payload.turn_id === 'string' ? turns.get(payload.turn_id) : undefined;
        if (recordedTurn && byOrdinal.has(recordedTurn.ordinal) && recordedTurn !== active) throw invalid();
        if (active && byOrdinal.has(active.ordinal)) {
          if (payload.turn_id !== active.id || ++active.contexts !== 1 || active.closed || payload.cwd !== join(scope.directory, 'workspace') || payload.model !== scope.model
            || payload.approval_policy !== (scope.mode === '--yolo' ? 'never' : 'on-request')
            || payload.approvals_reviewer !== (scope.mode === '--yolo' ? 'user' : 'auto_review')) throw invalid();
          active.context = recordIndex;
        }
      } else if (record.type === 'response_item') {
        if (payload.id !== undefined) {
          if (typeof payload.id !== 'string' || payload.id.length === 0) throw invalid();
          responseIds.set(payload.id, (responseIds.get(payload.id) ?? 0) + 1);
        }
        if (payload.type === 'message' && payload.role === 'user') {
          for (const expected of scope.expected) if (matches(payload.content, expected.prompt)) promptCounts.set(expected.turnOrdinal, (promptCounts.get(expected.turnOrdinal) ?? 0) + 1);
        }
        const expected = active && byOrdinal.get(active.ordinal);
        if (active && expected && !active.closed) {
          // Accepted user input is persisted BEFORE the native UserMessage event,
          // before any model output. A later relay-shaped user item cannot qualify.
          const metadata = object(payload.internal_chat_message_metadata_passthrough);
          if (active.context === undefined || ++active.users !== 1 || payload.type !== 'message' || payload.role !== 'user'
            || !matches(payload.content, expected.prompt) || metadata?.turn_id !== active.id
            || typeof payload.id !== 'string' || !NATIVE_INPUT_ID.test(payload.id)) throw invalid();
          active.input = { id: payload.id, index: recordIndex };
        }
      } else if (record.type === 'event_msg' && payload.type === 'item_completed') {
        const item = object(payload.item);
        if (item?.type === 'UserMessage') for (const expected of scope.expected) {
          if (matches(item.content, expected.prompt, true)) userEventPromptCounts.set(expected.turnOrdinal, (userEventPromptCounts.get(expected.turnOrdinal) ?? 0) + 1);
        }
        const turn = typeof payload.turn_id === 'string' ? turns.get(payload.turn_id) : undefined;
        const expected = turn && byOrdinal.get(turn.ordinal);
        if (turn && expected && item?.type === 'UserMessage') {
          if (turn !== active || turn.closed || ++turn.events !== 1 || !turn.input || turn.context === undefined
            || payload.thread_id !== scope.threadId || !matches(item.content, expected.prompt, true)
            || typeof item.id !== 'string' || !UUID.test(item.id)) throw invalid();
          turn.event = recordIndex; turn.closed = true;
        } else if (active && byOrdinal.has(active.ordinal) && !active.closed) throw invalid();
      }
    }
    if (sessionCount !== 1) throw invalid();
    const result = new Map<string, CodexNativeUserIdentity>();
    for (const expected of scope.expected) {
      const turn = bound.get(expected.turnOrdinal);
      if (!turn?.closed || !turn.input || turn.context === undefined || turn.event === undefined
        || turn.contexts !== 1 || turn.users !== 1 || turn.events !== 1 || promptCounts.get(expected.turnOrdinal) !== 1 || userEventPromptCounts.get(expected.turnOrdinal) !== 1
        || responseIds.get(turn.input.id) !== 1 || !(turn.task < turn.context && turn.context < turn.input.index && turn.input.index < turn.event)) throw invalid();
      const identity: CodexNativeUserIdentity = Object.freeze({ ...expected, threadId: scope.threadId, turnId: turn.id, inputId: turn.input.id,
        model: scope.model, taskRecordIndex: turn.task, contextRecordIndex: turn.context, inputRecordIndex: turn.input.index, userEventRecordIndex: turn.event, source });
      nativeIdentityProofs.add(identity); result.set(expected.probeId, identity);
    }
    return result;
  } finally {
    const closing = run.observe(owned.close());
    await run.step(() => closing);
    owned.untrack();
  }
}

export interface CodexRunDeadline {
  signal: AbortSignal;
  check(): void;
  step<T>(operation: () => Promise<T>): Promise<T>;
  observe<T>(operation: Promise<T>): Promise<T>;
  onShutdown(close: () => void | Promise<void>): () => void;
}

/** One deadline owns setup, BOTH modes, evidence and teardown; imports never launch. */
export async function withCodexRunDeadline<T>(work: (run: CodexRunDeadline) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const closing = new Set<() => void>();
  let expired = false;
  let stopped = false;
  let cleanupFailed = false;
  const failure = () => new Error('Codex fixture deadline or owned cleanup failed');
  const observe = <V>(operation: Promise<V>): Promise<V> => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const check = () => { if (stopped || abort.signal.aborted) throw failure(); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    // Initiate cancellation/socket closure before joining ANY pending work.
    for (const close of closing) close();
  };
  const run: CodexRunDeadline = {
    signal: abort.signal, check, observe,
    step<V>(operation: () => Promise<V>): Promise<V> {
      check();
      const active = observe(operation());
      const result = Promise.withResolvers<V>();
      const onAbort = () => result.reject(failure());
      abort.signal.addEventListener('abort', onAbort, { once: true });
      void active.then((value) => {
        abort.signal.removeEventListener('abort', onAbort);
        if (abort.signal.aborted) result.reject(failure()); else result.resolve(value);
      }, (error: unknown) => { abort.signal.removeEventListener('abort', onAbort); result.reject(error); });
      if (abort.signal.aborted) onAbort();
      return result.promise;
    },
    onShutdown(close) {
      let initiated = false;
      const initiate = () => {
        if (initiated) return;
        initiated = true;
        try {
          const result = close();
          if (result) observe(result).catch(() => { cleanupFailed = true; });
        } catch { cleanupFailed = true; }
      };
      closing.add(initiate);
      // Late asynchronous setup must close its resource, never start another turn.
      if (stopped) initiate();
      return () => { closing.delete(initiate); };
    },
  };
  const deadline = setTimeout(() => { expired = true; stop(); }, RUN_TIMEOUT_MS);
  let result: { value: T } | undefined;
  let failed = false;
  try { result = { value: await run.step(() => work(run)) }; }
  catch { failed = true; }
  finally {
    stop();
    const shutdown = Promise.withResolvers<never>();
    const shutdownTimer = setTimeout(() => shutdown.reject(failure()), SHUTDOWN_TIMEOUT_MS);
    try {
      while (pending.size > 0) await Promise.race([Promise.allSettled([...pending]), shutdown.promise]);
    } catch { cleanupFailed = true; }
    finally { clearTimeout(shutdownTimer); clearTimeout(deadline); }
  }
  if (failed || expired || cleanupFailed || !result) throw failure();
  return result.value;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Fixture admission uses the same raw WHATWG pathname as the actual gateway. */
export function isCanonicalCodexFixtureRequest(request: Request, hop: 'ingress' | 'relay'): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === (hop === 'ingress' ? '/codex/v1/responses' : '/v1/responses');
}

export interface CodexRecordedRequest extends RecordedRequest {
  readonly arrivalId: string;
  readonly arrivalOrder: number;
  readonly url: string;
  bodyComplete: boolean;
  overlap: boolean;
}

/** Production ingress admission: invalid requests never enter capture chronology. */
export function admitCodexFixtureArrival(request: Request, token: string, requests: CodexRecordedRequest[], originalBodies: string[], overlap: boolean): CodexRecordedRequest | 401 | 429 {
  if (!isCanonicalCodexFixtureRequest(request, 'ingress') || request.headers.get('authorization') !== `Bearer ${token}`) return 401;
  if (requests.length >= 32) return 429;
  const record: CodexRecordedRequest = { arrivalId: randomUUID(), arrivalOrder: requests.length, url: request.url, bodyComplete: false, overlap, method: request.method, path: new URL(request.url).pathname, headers: new Headers(request.headers), body: {} };
  Object.defineProperties(record, { arrivalId: { writable: false, configurable: false }, arrivalOrder: { writable: false, configurable: false }, url: { writable: false, configurable: false } });
  requests.push(record); originalBodies.push('');
  return record;
}

function normalTurnPrompt(turn: number): string {
  return `AMP_NORMAL_${turn}: reply with a short text only. Do not execute tools.`;
}

export interface CodexCapture {
  control: 'deny' | 'allow' | 'mixed';
  requestIndex: number;
  requestId: string;
  probeId: string;
  marker: string;
  sourceItem: Record<string, unknown>;
  positiveItem?: Record<string, unknown>;
  events: Record<string, unknown>[];
  captureComplete: boolean;
  expectedNextTurnPrompt?: string;
}
// Pinned client.rs request preparation for a custom provider. Observation only:
// never mutate the captured request/history, message boundaries, or content types.
function sameNativeReplayItem(expectedValue: unknown, actualValue: unknown): boolean {
  const expected = object(expectedValue);
  const actual = object(actualValue);
  if (!expected || !actual) return false;
  const projected = { ...expected };
  delete projected.internal_chat_message_metadata_passthrough;
  if (projected.type === 'message') delete projected.encrypted_content;
  if (projected.type === 'function_call') delete projected.encrypted_function_args;
  if (typeof projected.id === 'string') {
    const separator = projected.id.indexOf('_');
    if (separator < 1 || separator === projected.id.length - 1) delete projected.id;
  }
  return canonical(projected) === canonical(actual);
}

/** Checks source completion order separately from original terminal indices. */
export function observeCodexReplay(requests: readonly CodexRecordedRequest[], capture: CodexCapture, nativeUser?: CodexNativeUserIdentity): { passed: boolean; reason: string } {
  if (!capture.captureComplete || capture.events.length === 0) return { passed: false, reason: 'missing_capture' };
  let sequence = -1;
  for (const event of capture.events) {
    if (!Number.isSafeInteger(event.sequence_number) || (event.sequence_number as number) <= sequence) return { passed: false, reason: 'invalid_outgoing_sequence' };
    sequence = event.sequence_number as number;
  }
  if (!['deny', 'allow', 'mixed'].includes(capture.control)) return { passed: false, reason: 'unsafe_or_uncorrelated_probe' };
  const original = requests[capture.requestIndex];
  if (!original || original.method !== 'POST' || original.path !== '/codex/v1/responses') return { passed: false, reason: 'missing_source_request' };
  try { if (new URL(original.url).pathname !== original.path) return { passed: false, reason: 'ambiguous_arrival_identity' }; }
  catch { return { passed: false, reason: 'ambiguous_arrival_identity' }; }
  if (original.arrivalId !== capture.requestId || original.arrivalOrder !== capture.requestIndex || !original.bodyComplete || original.overlap
    || requests.some((request, index) => request.arrivalOrder !== index || request.overlap || !request.bodyComplete)
    || new Set(requests.map((request) => request.arrivalId)).size !== requests.length) return { passed: false, reason: 'ambiguous_arrival_identity' };
  const declared = declaredCodexExec(original);
  if (!declared || JSON.stringify(original.body.input ?? null).includes(capture.marker)) return { passed: false, reason: 'wrong_source_request' };
  const positive = capture.control === 'allow' ? capture.sourceItem : capture.control === 'mixed' ? capture.positiveItem : undefined;
  const sources = [capture.sourceItem, ...(capture.control === 'mixed' ? [positive] : [])];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    let args: Record<string, unknown> | undefined;
    try { args = source && typeof source.arguments === 'string' ? object(JSON.parse(source.arguments)) : undefined; } catch { /* Unsafe source below. */ }
    const command = capture.control === 'allow' || index === 1 ? CODEX_ALLOW_PROBE : CODEX_PROBE;
    if (!source || source.type !== 'function_call' || source.name !== 'exec_command' || typeof source.call_id !== 'string'
      || (index === 0 && source.call_id !== capture.probeId) || args?.cmd !== command || Object.keys(args).some((key) => key !== 'cmd')
      || source.encrypted_function_args !== undefined) return { passed: false, reason: 'unsafe_or_uncorrelated_probe' };
    if (declared.namespace !== source.namespace) return { passed: false, reason: 'wrong_source_request' };
  }
  if (capture.control === 'mixed' && positive?.call_id === capture.probeId) return { passed: false, reason: 'unsafe_or_uncorrelated_probe' };
  const next = requests[capture.requestIndex + 1];
  if (!next || !Array.isArray(next.body.input)) return { passed: false, reason: 'missing_immediate_replay' };
  if (next.method !== 'POST' || next.path !== '/codex/v1/responses') return { passed: false, reason: 'wrong_immediate_request' };
  try { if (new URL(next.url).pathname !== next.path) return { passed: false, reason: 'wrong_immediate_request' }; }
  catch { return { passed: false, reason: 'wrong_immediate_request' }; }
  const completed = capture.events.filter((event) => event.type === 'response.completed');
  const terminal = completed.length === 1 ? object(completed[0]?.response) : undefined;
  if (!terminal || !Array.isArray(terminal.output)) return { passed: false, reason: 'missing_terminal_snapshot' };
  const output = terminal.output.map(object);
  const order = capture.control === 'mixed' ? [1, 0, 2] : [0, 1];
  const done = capture.events.filter((event) => event.type === 'response.output_item.done');
  if (output.length !== order.length || done.length !== order.length || done.some((event, index) => event.output_index !== order[index]
    || JSON.stringify(event.item) !== JSON.stringify(output[order[index]!]))) return { passed: false, reason: 'terminal_item_mismatch' };
  const texts = output.map((entry) => entry?.role === 'assistant' && Array.isArray(entry.content) ? entry.content.map((part) => object(part)?.text).join('') : undefined);
  const markerIndex = output.length - 1;
  if (texts[markerIndex] !== capture.marker) return { passed: false, reason: 'missing_exact_ordered_denial' };
  const denial = capture.control === 'allow' ? undefined : texts[0];
  if (capture.control !== 'allow' && (typeof denial !== 'string' || !denial.startsWith('[auto-mode-proxy]') || !/blocked/i.test(denial))) return { passed: false, reason: 'missing_exact_ordered_denial' };
  if (positive) {
    const delivered = output[capture.control === 'mixed' ? 1 : 0];
    if (!delivered || delivered.type !== 'function_call' || delivered.id !== positive.id || delivered.call_id !== positive.call_id
      || delivered.name !== positive.name || delivered.namespace !== positive.namespace || delivered.arguments !== positive.arguments
      || delivered.encrypted_function_args !== undefined) return { passed: false, reason: 'allowed_wire_item_order_or_identity_mismatch' };
  } else if (output.some((entry) => entry?.type !== 'message')) return { passed: false, reason: 'execution_or_unexpected_output' };
  if (capture.events.some((event) => {
    const item = object(event.item);
    if (item && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(item.type))) {
      return !positive || item.type !== 'function_call' || item.id !== positive.id || item.call_id !== positive.call_id || item.name !== positive.name || item.namespace !== positive.namespace;
    }
    return /function_call_arguments|custom_tool_call_input|local_shell/.test(String(event.type)) && (!positive || event.item_id !== positive.id);
  })) return { passed: false, reason: 'execution_delivered' };
  const input = next.body.input;
  const previous = original.body.input;
  if (!Array.isArray(previous)) return { passed: false, reason: 'missing_original_input' };
  for (let index = 0; index < previous.length; index++) {
    if (!sameNativeReplayItem(previous[index], input[index])) return { passed: false, reason: 'original_prefix_changed' };
  }
  for (let index = 0; index < done.length; index++) {
    if (!sameNativeReplayItem(done[index]?.item, input[previous.length + index])) return { passed: false, reason: 'immediate_replay_order_or_reason_mismatch' };
  }
  const resultIndex = previous.length + done.length;
  if (positive) {
    const result = object(input[resultIndex]);
    if (result?.type !== 'function_call_output' || result.call_id !== positive.call_id || typeof result.output !== 'string'
      || !/^(?:Chunk ID: [^\r\n]+\n)?Wall time: \d+\.\d{4} seconds\nProcess exited with code 0\n(?:Original token count: \d+\n)?Output:\nAMP_CODEX_ALLOW_PROBE$/.test(result.output)) {
      return { passed: false, reason: 'allowed_correlated_native_result_missing' };
    }
  }
  const accounted = resultIndex + (positive ? 1 : 0);
  if (capture.control === 'deny' && capture.expectedNextTurnPrompt !== undefined && (!nativeUser || !nativeIdentityProofs.has(nativeUser))) return { passed: false, reason: 'unaccounted_replay_tail' };
  if (nativeUser && input.length === accounted) return { passed: false, reason: 'unaccounted_replay_tail' };
  if (input.length !== accounted) {
    const expectedPrompt = capture.expectedNextTurnPrompt;
    if (input.length !== accounted + 1 || capture.control !== 'deny' || typeof expectedPrompt !== 'string'
      || !nativeUser || !nativeIdentityProofs.has(nativeUser) || nativeUser.probeId !== capture.probeId
      || nativeUser.requestId !== capture.requestId || nativeUser.prompt !== expectedPrompt
      || original.body.model !== nativeUser.model || next.body.model !== nativeUser.model
      || [original, next].some((request) => request.headers.get('thread-id') !== nativeUser.threadId || request.headers.get('session-id') !== nativeUser.threadId)
      || [...previous, ...done.map((event) => event.item)].some((entry) => object(entry)?.id === nativeUser.inputId)) return { passed: false, reason: 'unaccounted_replay_tail' };
    const expectedUser = { type: 'message', id: nativeUser.inputId, role: 'user', content: [{ type: 'input_text', text: expectedPrompt }] };
    if (canonical(input[accounted]) !== canonical(expectedUser)) return { passed: false, reason: 'unaccounted_replay_tail' };
  }
  for (let index = 0; index < input.length; index++) {
    const entry = object(input[index]);
    if (entry && ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'local_shell_call_output', 'tool_search_call'].includes(String(entry.type))) {
      if (!positive || entry.call_id !== positive.call_id || !((index === previous.length && entry.type === 'function_call')
        || (index === resultIndex && entry.type === 'function_call_output'))) return { passed: false, reason: 'execution_replayed' };
    }
  }
  return { passed: true, reason: capture.control === 'mixed' ? 'exact_interleaved_source_event_replay' : 'exact_immediate_ordered_replay' };
}

function declaredCodexExec(request: RecordedRequest): { namespace?: string } | undefined {
  const matches: { namespace?: string }[] = [];
  const inspect = (value: unknown, namespace?: string) => {
    const tool = object(value);
    const parameters = object(tool?.parameters);
    const properties = object(parameters?.properties);
    if (tool?.type !== 'function' || tool.name !== 'exec_command' || parameters?.type !== 'object'
      || parameters.additionalProperties !== false || object(properties?.cmd)?.type !== 'string'
      || !Array.isArray(parameters.required) || parameters.required.length !== 1 || parameters.required[0] !== 'cmd') return;
    matches.push(namespace === undefined ? {} : { namespace });
  };
  if (Array.isArray(request.body.tools)) for (const value of request.body.tools) inspect(value);
  if (Array.isArray(request.body.input)) for (const value of request.body.input) {
    const prefix = object(value);
    if (prefix?.type !== 'additional_tools' || prefix.role !== 'developer' || !Array.isArray(prefix.tools)) continue;
    for (const value of prefix.tools) {
      const namespace = object(value);
      if (namespace?.type === 'namespace' && namespace.name === 'functions' && Array.isArray(namespace.tools)) {
        for (const nested of namespace.tools) inspect(nested, 'functions');
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function codexProbeScene(request: RecordedRequest, probeId: string, marker: string, control: 'deny' | 'allow' | 'mixed' = 'deny'): { scene: RelayScene; item: Record<string, unknown>; positiveItem?: Record<string, unknown> } {
  const declaration = declaredCodexExec(request);
  if (!declaration) throw new Error('Codex exec_command declaration missing, ambiguous or unsupported');
  const item = { type: 'function_call', id: `fc_${probeId}`, call_id: probeId, name: 'exec_command', ...declaration, arguments: JSON.stringify({ cmd: control === 'allow' ? CODEX_ALLOW_PROBE : CODEX_PROBE }), status: 'completed' };
  const positiveItem = control === 'mixed' ? { ...item, id: `fc_${probeId}_allow`, call_id: `${probeId}_allow`, arguments: JSON.stringify({ cmd: CODEX_ALLOW_PROBE }) } : undefined;
  return { item, positiveItem, scene: { interleaveFirstTwo: control === 'mixed', output: [item, ...(positiveItem ? [positiveItem] : []), { type: 'message', id: `msg_${probeId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: marker, annotations: [] }] }] } };
}

export interface CodexExecutionEvent { eventType: unknown; item: Record<string, unknown>; turnKind: string }

/** Native JSONL command rendering is shlex_join(actual argv), never model echo. */
export function observeCodexExecutions(events: readonly CodexExecutionEvent[], nativeShell: string | null): {
  passed: boolean; positiveSuccessful: number; negativeExecutions: number; unexpectedExecutions: number;
} {
  let positiveSuccessful = 0;
  let negativeExecutions = 0;
  let unexpectedExecutions = 0;
  const items = new Map<string, { command: string; turnKind: string; completed: boolean }>();
  for (const event of events) {
    const rendered = event.item.command;
    const parsed = typeof rendered === 'string' ? parseShell(rendered) : undefined;
    const argv = parsed?.segments[0]?.argv;
    // This is recorded argv, not a policy decision: the expected executable IS
    // an interpreter. Reject every other parse hazard and require exact argv.
    const fixedCommand = nativeShell !== null && parsed?.valid === true
      && parsed.reasons.every((reason) => reason === 'interpreter') && parsed.segments.length === 1
      && parsed.segments[0]?.operator === undefined && argv?.length === 3 && argv[0] === nativeShell
      && (argv[1] === '-lc' || argv[1] === '-c') && argv[2] === CODEX_ALLOW_PROBE;
    if (event.turnKind === 'deny' || (typeof rendered === 'string' && rendered.includes(CODEX_PROBE))) negativeExecutions++;
    if (!['allow', 'mixed'].includes(event.turnKind) || event.item.type !== 'command_execution' || !fixedCommand
      || typeof rendered !== 'string' || typeof event.item.id !== 'string' || event.item.id.length === 0) {
      unexpectedExecutions++; continue;
    }
    // JSONL item_N IDs identify lifecycle snapshots, not Responses call_id.
    const previous = items.get(event.item.id);
    if (previous && (previous.command !== rendered || previous.turnKind !== event.turnKind || previous.completed)) {
      unexpectedExecutions++; continue;
    }
    const terminal = event.eventType === 'item.completed';
    items.set(event.item.id, { command: rendered, turnKind: event.turnKind, completed: terminal });
    if (terminal) {
      if (event.item.status === 'completed' && event.item.exit_code === 0 && event.item.aggregated_output === 'AMP_CODEX_ALLOW_PROBE') positiveSuccessful++;
      else unexpectedExecutions++;
    } else if (!['item.started', 'item.updated'].includes(String(event.eventType))
      || event.item.status !== 'in_progress' || event.item.exit_code !== null) unexpectedExecutions++;
  }
  if (items.size !== 1) unexpectedExecutions++;
  return { passed: positiveSuccessful === 1 && negativeExecutions === 0 && unexpectedExecutions === 0, positiveSuccessful, negativeExecutions, unexpectedExecutions };
}

async function runMode(mode: '--yolo' | '--approve-for-me', root: string, executable: string, run: CodexRunDeadline) {
  const directory = join(root, mode.slice(2));
  const home = join(directory, 'home');
  const codexHome = join(home, '.codex');
  const workspace = join(directory, 'workspace');
  await run.step(() => mkdir(codexHome, { recursive: true }));
  await run.step(() => mkdir(workspace, { recursive: true }));
  const requests: CodexRecordedRequest[] = [];
  const originalBodies: string[] = [];
  const captures: CodexCapture[] = [];
  const pending = new Set<Promise<void>>();
  const responses = new Set<Promise<void>>();
  const relayKey = randomUUID();
  const clientToken = randomUUID();
  const decisionKey = randomUUID();
  type Admission = { record: CodexRecordedRequest; nonce: string; prompt: string; control: 'deny' | 'mixed' | undefined; turn: number; capture?: CodexCapture; relayClaimed: boolean; sceneConsumed: boolean; captureStarted: boolean; captureFinished: boolean; responseFinished: boolean; release(): void };
  const admissions = new WeakMap<Request, Admission>();
  const transactions = new Map<string, Admission>();
  let active: Admission | undefined;
  let armedControl: 'deny' | 'mixed' | undefined;
  let expectedPrompt = '';
  let unsupportedRequests = 0;
  let turn = 0;
  let threadId: string | undefined;
  let bytes = 0;
  let captureFailed = false;
  let timedOut = false;
  let outputBoundHit = false;
  const executions: CodexExecutionEvent[] = [];
  const relay = createMockRelay({ protocol: 'openai-responses', sceneForRequest(request) {
    const admission = transactions.get(request.headers.get('x-amp-fixture-request') ?? '');
    if (!admission || !admission.relayClaimed || admission.sceneConsumed) throw new Error('Uncorrelated fixture relay request');
    admission.sceneConsumed = true;
    const control = admission.control;
    if (!control) return { output: [{ type: 'message', id: `msg_normal_${admission.turn}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `AMP_NORMAL_TURN_OK_${admission.turn}`, annotations: [] }] }] };
    const probeId = `amp_${randomUUID()}`;
    const marker = `AMP_AFTER_${probeId}`;
    const { scene, item, positiveItem } = codexProbeScene(request, probeId, marker, control);
    const capture: CodexCapture = { control, requestId: admission.record.arrivalId, requestIndex: admission.record.arrivalOrder, probeId, marker, sourceItem: item, positiveItem, events: [], captureComplete: false };
    if (control === 'deny') capture.expectedNextTurnPrompt = normalTurnPrompt(admission.turn + 1);
    admission.capture = capture;
    captures.push(capture);
    return scene;
  } });
  const relayBroker = new Hono();
  relayBroker.all('*', async (context) => {
    const admission = transactions.get(context.req.header('x-amp-fixture-request') ?? '');
    if (context.req.header('authorization') !== `Bearer ${relayKey}` || !admission || admission.relayClaimed || !isCanonicalCodexFixtureRequest(context.req.raw, 'relay')) return context.json({ error: 'uncorrelated fixture transport' }, 401);
    admission.relayClaimed = true;
    const raw = await run.step(() => context.req.raw.clone().text());
    if (raw !== originalBodies[admission.record.arrivalOrder]) { unsupportedRequests++; return context.json({ error: 'fixture body correlation failed' }, 400); }
    return run.step(async () => relay.app.fetch(new Request(context.req.raw, { signal: run.signal })));
  });
  const decision = createMockDecision({ mode: 'deny' });
  const positiveDecision = createMockDecision({ mode: 'allow' });
  const trustedFixture = new Hono();
  trustedFixture.onError(() => { unsupportedRequests++; return Response.json({ error: 'manual decision request failed' }, { status: 400 }); });
  trustedFixture.post('*', async (context) => {
    if (context.req.header('authorization') !== `Bearer ${decisionKey}`) return context.json({ error: 'unauthorized manual decision request' }, 401);
    const body: unknown = await run.step(() => context.req.raw.clone().json());
    const command = object(object(object(body)?.state)?.action)?.command;
    if (command === CODEX_PROBE) return run.step(async () => decision.app.fetch(new Request(context.req.raw, { signal: run.signal })));
    if (command === CODEX_ALLOW_PROBE) return run.step(async () => positiveDecision.app.fetch(new Request(context.req.raw, { signal: run.signal })));
    unsupportedRequests++;
    return context.json({ error: 'unsupported manual decision payload' }, 400);
  });
  const listeners: { close(): Promise<void> }[] = [];
  const ownListener = (listener: { url: string; close(): Promise<void> }) => {
    const close = listener.close;
    let closing: Promise<void> | undefined;
    listener.close = () => closing ??= close();
    listeners.push(listener);
    run.onShutdown(listener.close);
    return listener;
  };
  try {
    const upstream = await run.step(() => startLoopback(relayBroker).then(ownListener));
    const trusted = await run.step(() => startLoopback(trustedFixture).then(ownListener));
    const config = configSchema.parse({ auth: { mode: 'vault', client_tokens: [clientToken] },
      routes: [{ prefix: '/codex', protocol: 'openai-responses', upstream: 'mock', project_dirs: [workspace] }],
      upstreams: { mock: { base_url: upstream.url, api_key: relayKey } }, gate: { mode: 'enforce', on_provider_failure: 'block' },
      decision: { chain: ['mock'], providers: { mock: { kind: 'systemone', base_url: trusted.url, api_key: decisionKey, model: 'mock' } } },
      policy: { readonly_programs: [] }, audit: { path: join(directory, 'audit.jsonl') }, log_level: 'silent' });
    const proxy = createApp(config);
    run.onShutdown(() => proxy.flushAudit());
    const ingress = new Hono<{ Bindings: HttpBindings }>();
    ingress.onError(() => { unsupportedRequests++; return Response.json({ error: 'manual generation request failed' }, { status: 400 }); });
    ingress.use('*', async (context, next) => {
      run.check();
      // Authenticate/canonicalize before recording identity/order, before any await.
      const record = admitCodexFixtureArrival(context.req.raw, clientToken, requests, originalBodies, active !== undefined);
      if (typeof record === 'number') { unsupportedRequests++; return context.json({ error: 'unauthorized or bounded fixture arrival' }, record); }
      if (record.overlap) { unsupportedRequests++; return context.json({ error: 'ambiguous fixture arrival' }, 401); }
      const outgoing = context.env?.outgoing;
      if (!outgoing) { unsupportedRequests++; return context.json({ error: 'missing owned response lifecycle' }, 500); }
      const completed = Promise.withResolvers<void>();
      responses.add(completed.promise);
      run.observe(completed.promise);
      const admission: Admission = { record, nonce: randomUUID(), prompt: expectedPrompt, control: armedControl, turn,
        relayClaimed: false, sceneConsumed: false, captureStarted: false, captureFinished: false, responseFinished: false,
        release() {
          if (!admission.responseFinished || !admission.captureFinished) return;
          transactions.delete(admission.nonce);
          if (active === admission) active = undefined;
          outgoing.off('finish', finish); outgoing.off('close', close);
          responses.delete(completed.promise); completed.resolve();
        },
      };
      const finish = () => { admission.responseFinished = true; admission.release(); };
      const close = () => { if (!outgoing.writableFinished) captureFailed = true; admission.responseFinished = true; admission.release(); };
      outgoing.once('finish', finish); outgoing.once('close', close);
      active = admission; armedControl = undefined; admissions.set(context.req.raw, admission);
      try { await run.step(() => next()); }
      finally { if (!admission.captureStarted) admission.captureFinished = true; admission.release(); }
    });
    ingress.use('*', bodyLimit({ maxSize: MAX_CAPTURE }));
    ingress.all('*', async (context) => {
      const admission = admissions.get(context.req.raw);
      if (!admission || !isCanonicalCodexFixtureRequest(context.req.raw, 'ingress')) { unsupportedRequests++; return context.json({ error: 'manual probe request boundary' }, 400); }
      const rawBody = await run.step(() => context.req.raw.clone().text());
      bytes += Buffer.byteLength(rawBody) * 3;
      if (bytes > MAX_CAPTURE) { unsupportedRequests++; return context.json({ error: 'manual capture bound' }, 413); }
      originalBodies[admission.record.arrivalOrder] = rawBody;
      const body: unknown = JSON.parse(rawBody);
      const record = object(body);
      if (!record) { unsupportedRequests++; return context.json({ error: 'object required' }, 400); }
      admission.record.body = record; admission.record.bodyComplete = true;
      if (!declaredCodexExec(admission.record) || !Array.isArray(record.input) || extractLatestUserText(record.input) !== admission.prompt) {
        unsupportedRequests++; return context.json({ error: 'unsupported manual generation or review request' }, 400);
      }
      transactions.set(admission.nonce, admission);
      const headers = new Headers(context.req.raw.headers);
      headers.set('x-amp-fixture-request', admission.nonce);
      const response = await run.step(async () => proxy.fetch(new Request(context.req.raw, { headers, signal: run.signal }), context.env));
      if (!response.ok || !response.body) { captureFailed = true; return response; }
      const copy = response.clone();
      admission.captureStarted = true;
      const reader = parseSse(copy.body!).getReader();
      const untrackReader = run.onShutdown(() => reader.cancel());
      const work = (async () => {
        try {
          while (true) {
            const next = await run.step(() => reader.read());
            if (next.done) break;
            const frame = next.value;
            bytes += frame.raw.byteLength * 3;
            if (bytes > MAX_CAPTURE || !frame.complete) throw new Error('capture bound or incomplete frame');
            if (frame.data) {
              const event = object(JSON.parse(frame.data));
              if (!event) throw new Error('invalid capture event');
              admission.capture?.events.push(event);
            }
          }
          if (admission.capture) admission.capture.captureComplete = true;
        } catch { captureFailed = true; await run.observe(reader.cancel()); }
        finally { untrackReader(); reader.releaseLock(); admission.captureFinished = true; admission.release(); }
      })();
      run.observe(work); pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
      return response;
    });
    const gateway = await run.step(() => startLoopback(ingress).then(ownListener));
    await run.step(() => writeFile(join(codexHome, 'config.toml'), `model = "${CODEX_FIXTURE_MODEL}"\nmodel_provider = "amp"\n\n[agents]\nenabled = false\n\n[features]\nhooks = false\napps = false\nplugins = false\nmulti_agent = false\nmulti_agent_v2 = false\ncode_mode = false\ncode_mode_only = false\nenable_mcp_apps = false\nskill_search = false\n\n[model_providers.amp]\nname = "auto-mode-proxy"\nbase_url = "${gateway.url}/codex/v1"\nenv_key = "AMP_TOKEN"\nwire_api = "responses"\nsupports_websockets = false\n`, { mode: 0o600, signal: run.signal }));
    const turns = ['deny', 'normal', 'deny', 'normal', 'mixed', 'normal', 'normal', 'normal'] as const;
    const results: { kind: string; exitCode: number | null; completed: boolean }[] = [];
    for (const kind of turns) {
      run.check();
      turn++;
      armedControl = kind === 'normal' ? undefined : kind;
      let completed = false;
      let exitCode: number | null = null;
      let failed = false;
      const prompt = kind === 'deny' ? `AMP_DENIAL_PROBE turn ${turn}: request only the harmless fixed command printf AMP_DENIAL_PROBE. No other command.`
        : kind === 'mixed' ? `AMP_MIXED_${turn}: request only these fixed harmless commands: printf AMP_DENIAL_PROBE and printf AMP_CODEX_ALLOW_PROBE. No other command.`
        : normalTurnPrompt(turn);
      expectedPrompt = prompt;
      const args = threadId ? ['exec', mode, 'resume', '--json', '--skip-git-repo-check', '--ignore-rules', threadId, prompt]
        : ['exec', mode, '--json', '--skip-git-repo-check', '--ignore-rules', prompt];
      const child = spawn(executable, args, { cwd: workspace, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), AMP_TOKEN: clientToken, NO_COLOR: '1', TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const owned = attachCliProcess(child, {
        onLine(line) {
          try {
            const event = object(JSON.parse(line));
            if (!event) { failed = true; return; }
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
            if (event.type === 'turn.completed') completed = true;
            if (event.type === 'turn.failed' || event.type === 'error') failed = true;
            const item = object(event.item);
            if (item && ['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search'].includes(String(item.type))) executions.push({ eventType: event.type, item, turnKind: kind });
          } catch { failed = true; }
        }, onOutputBound() { outputBoundHit = true; }, onExitCode(code) { exitCode = code; }, shouldForceKill() { return timedOut; },
      });
      const untrackChild = run.onShutdown(() => { owned.stop(); return owned.completion.finally(() => owned.dispose()); });
      child.stdin.end();
      const timer = setTimeout(() => { timedOut = true; owned.stop(); }, 30_000);
      let childClosed = false;
      try { await run.step(() => owned.completion); childClosed = true; }
      finally {
        clearTimeout(timer);
        owned.stop();
        // If closure is unknown, the global shutdown owns bounded reaping.
        if (childClosed) { owned.dispose(); untrackChild(); }
      }
      await run.step(() => Promise.all(pending));
      await run.step(() => Promise.all(responses));
      results.push({ kind, exitCode, completed: completed && !failed });
      if (exitCode !== 0 || !completed || failed || timedOut || outputBoundHit || !threadId) break;
    }
    await run.step(() => proxy.flushAudit());
    let nativeUsers: ReadonlyMap<string, CodexNativeUserIdentity> = new Map();
    let nativeIdentityFailed = false;
    try {
      const expected: CodexNativeUserExpectation[] = [];
      for (const capture of captures) if (capture.control === 'deny') {
        const ordinals = turns.flatMap((kind, index) => kind === 'normal' && normalTurnPrompt(index + 1) === capture.expectedNextTurnPrompt ? [index + 1] : []);
        if (ordinals.length !== 1 || !capture.expectedNextTurnPrompt) throw new Error('Native turn plan unavailable');
        expected.push({ probeId: capture.probeId, requestId: capture.requestId, turnOrdinal: ordinals[0]!, prompt: capture.expectedNextTurnPrompt });
      }
      if (expected.length > 0) {
        if (!threadId) throw new Error('Native thread unavailable');
        nativeUsers = await readCodexNativeUsers({ directory, threadId, model: CODEX_FIXTURE_MODEL, provider: 'amp', mode, turnCount: turns.length, expected }, run, (cost) => {
          if (cost > MAX_CAPTURE - bytes) throw new Error('Manual capture bound');
          bytes += cost;
        });
      }
    } catch { run.check(); nativeIdentityFailed = true; }
    const replay = captures.map((capture) => observeCodexReplay(requests, capture, nativeUsers.get(capture.probeId)));
    const auditText = await run.step(() => readFile(join(directory, 'audit.jsonl'), { encoding: 'utf8', signal: run.signal }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }));
    const audit = auditText.trim().split('\n').filter(Boolean).map((line) => object(JSON.parse(line)));
    const denialRecords = audit.filter((row) => row?.verdict === 'block' && captures.some((capture) => capture.control !== 'allow' && object(object(row.action)?.raw)?.call_id === capture.probeId));
    const positiveRecords = audit.filter((row) => row?.verdict === 'allow' && captures.some((capture) => capture.positiveItem !== undefined && object(object(row.action)?.raw)?.call_id === capture.positiveItem.call_id));
    const fixedDecisionPayloads = decision.requests.length === 3 && decision.requests.every((request) => object(object(request.body.state)?.action)?.command === CODEX_PROBE)
      && positiveDecision.requests.length === 1 && positiveDecision.requests.every((request) => object(object(request.body.state)?.action)?.command === CODEX_ALLOW_PROBE);
    const executionProof = observeCodexExecutions(executions, userInfo().shell);
    const evidence = { mode, turns: results, originalRequestCount: requests.length, deniedCaptures: captures.filter((capture) => capture.control !== 'allow').length, positiveCaptures: captures.filter((capture) => capture.positiveItem !== undefined).length,
      replay, nativeIdentityFailed, nativeUserIdentityCount: nativeUsers.size, captureFailed, timedOut, outputBoundHit, unsupportedRequests, executionProof, negativeDecisionRequests: decision.requests.length, positiveDecisionRequests: positiveDecision.requests.length, fixedDecisionPayloads, correlatedAuditBlocks: denialRecords.length, correlatedAuditAllows: positiveRecords.length,
      passed: results.length === 8 && results.every((result) => result.completed && result.exitCode === 0) && results.filter((result) => result.kind === 'normal').length >= 5
        && captures.filter((capture) => capture.control !== 'allow').length === 3 && captures.filter((capture) => capture.positiveItem !== undefined).length === 1
        && replay.every((result) => result.passed) && !nativeIdentityFailed && executionProof.passed && !captureFailed && !timedOut && !outputBoundHit && unsupportedRequests === 0 && denialRecords.length === 3 && positiveRecords.length === 1 && fixedDecisionPayloads };
    // All requests are private/mock-only. Never print source request/header/auth bodies.
    await run.step(() => writeFile(join(directory, 'capture.json'), JSON.stringify({ requests: requests.map(({ headers, ...record }, index) => ({ ...record, headers: [...headers], rawBody: originalBodies[index] })), captures, executions, nativeUserIdentities: [...nativeUsers.values()], evidence }), { mode: 0o600, signal: run.signal }));
    return evidence;
  } finally {
    // Initiate sockets first; the global shutdown bounds all outstanding joins.
    for (const listener of listeners.reverse()) run.observe(listener.close());
  }
}

async function main() {
  const output = await withCodexRunDeadline(async (run) => {
    const root = await run.step(() => mkdtemp(join(tmpdir(), 'amp-codex-smoke-')).then((directory) => {
      if (process.env.AMP_CODEX_SMOKE_KEEP !== '1') run.onShutdown(() => rm(directory, { recursive: true, force: true }));
      return directory;
    }));
    const modes = [];
    for (const mode of ['--yolo', '--approve-for-me'] as const) {
      run.check();
      modes.push(await run.step(() => runMode(mode, root, process.env.CODEX_EXECUTABLE ?? 'codex', run)));
    }
    return { kind: 'installed_codex_loopback_mock', ...(process.env.AMP_CODEX_SMOKE_KEEP === '1' ? { privateCaptureDirectory: root } : {}), modes, passed: modes.every((mode) => mode.passed) };
  });
  // No success report before confirmed bounded teardown of BOTH modes.
  console.log(JSON.stringify(output));
  process.exitCode = output.passed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Codex manual mock proof failed; no secret diagnostics emitted');
    // A failed cleanup may leave uncooperative owned I/O alive: never retain the gate.
    process.exit(1);
  });
}

