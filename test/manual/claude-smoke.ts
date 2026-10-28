/** Parent-only manual entrypoint; importing its helpers never launches a CLI.
 * ~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/claude-smoke.ts
 * Run that finite gated command with async:true, timeout:0. No external model
 * endpoint is configured. This is CLI + loopback MOCK evidence, not provider,
 * real prompt-cache, Desktop, /status or real-relay compatibility acceptance.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { configSchema } from '../../src/config/schema.js';
import { createApp } from '../../src/server/app.js';
import { extractLatestUserText } from '../../src/protocols/request-context.js';
import { parseSse } from '../../src/protocols/sse.js';
import type { ClaudeRoute } from '../../src/protocols/anthropic/delivery.js';
import { createMockDecision } from '../integration/mock-decision.js';
import { createMockRelay, startLoopback, type RecordedRequest, type RelayScene } from '../integration/mock-relay.js';

const PROBE = 'printf AMP_DENIAL_PROBE';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TURN_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 240_000;
const cliEventSchema = z.object({
  type: z.string(),
  claude_code_version: z.string().optional(),
  is_error: z.boolean().optional(),
  message: z.object({ content: z.array(z.object({
    type: z.string(), name: z.string().optional(),
    input: z.object({ command: z.string().optional() }).passthrough().optional(),
    is_error: z.boolean().optional(),
  }).passthrough()).optional() }).passthrough().optional(),
}).passthrough();
interface RunEvidence {
  delivery: 'native' | 'rewrite';
  interactionMode: 'print' | 'interactive';
  sceneCounters: CliProbeSceneCounters;
  mixedContent: boolean;
  mixedReplay?: MixedContentReplayEvidence;
  mixedReplayDiagnostics?: MixedContentReplayStructure[];
  mixedParserErrorObserved?: boolean;
  versionOverrideRewrite?: VersionOverrideRewriteEvidence;
  cliVersion: string | null;
  observedSourceModelRequests: { stream: boolean; safeguards: boolean; sessionHeader: boolean; versionHeader: boolean; agentVersion: string | null; dangerousBeta: boolean; toolResult: boolean; bashDeclared: boolean }[];
  completedTurns: number;
  completedNormalTurns: number;
  completedDenialTurns: number;
  resultErrors: number;
  cliExitCode: number | null;
  timedOut: boolean;
  outputBoundHit: boolean;
  observedAssistantProbeCalls: number;
  observedProbeResults: number;
  observedDeniedProbeResults: number;
  observedSuccessfulProbeResults: number;
  observedDenialReturnedToModel: boolean;
  observedSafeguardsRequests: number;
  observedClassifierRequests: number;
  observedRequestCount: number;
  observedNativeAuditBlocks: number;
  observedRewriteAuditBlocks: number;
  observedDecisionProviderRequests: number;
  observedDecisionDeniedProbeRequests: number;
  observedEscalationText: boolean;
  observedEnabledStatusText: boolean;
  observedProbeOnlyToolPayloads: boolean;
}
function hasToolResults(request: RecordedRequest): boolean {
  const messages = request.body.messages;
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index];
    if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'user') continue;
    return 'content' in message && Array.isArray(message.content)
      && message.content.some((block: unknown) => !!block && typeof block === 'object' && 'type' in block && block.type === 'tool_result');
  }
  return false;
}

export function observedDenialReturnedToModel(requests: readonly RecordedRequest[], expectedProbeId?: string): boolean {
  for (const request of requests) {
    const messages = request.body.messages;
    if (!Array.isArray(messages)) continue;
    const seenToolIds = new Set<string>();
    const probeIds = new Set<string>();
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !('role' in message)
        || !('content' in message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || !('type' in block)) continue;
        if (message.role === 'assistant' && block.type === 'tool_use'
          && 'id' in block && typeof block.id === 'string') {
          if (seenToolIds.has(block.id)) {
            probeIds.delete(block.id);
            continue;
          }
          seenToolIds.add(block.id);
          if ('name' in block && block.name === 'Bash' && 'input' in block
            && block.input && typeof block.input === 'object'
            && 'command' in block.input && block.input.command === PROBE) probeIds.add(block.id);
        }
        if (message.role !== 'user' || block.type !== 'tool_result'
          || !('tool_use_id' in block) || typeof block.tool_use_id !== 'string'
          || !probeIds.has(block.tool_use_id) || !('is_error' in block) || block.is_error !== true
          || (expectedProbeId !== undefined && block.tool_use_id !== expectedProbeId)
          || !('content' in block)) continue;
        const resultText = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.flatMap((part: unknown) => {
            if (part && typeof part === 'object' && 'type' in part && part.type === 'text'
              && 'text' in part && typeof part.text === 'string') return [part.text];
            return [];
          }).join('\n') : '';
        if (/\b(?:denied|blocked|flagged|rejected)\b/i.test(resultText)) return true;
      }
    }
  }
  return false;
}

export interface CliProcessObserver {
  onLine(line: string): void;
  onOutputBound(): void;
  onExitCode(code: number | null): void;
  shouldForceKill(): boolean;
}

/** Observes only the caller-owned child; dispose releases observer resources. */
export function attachCliProcess(owned: ChildProcessWithoutNullStreams, observer: CliProcessObserver): {
  completion: Promise<void>;
  stop(): void;
  dispose(): void;
} {
  const exit = Promise.withResolvers<void>();
  let bytes = 0;
  let outputBoundHit = false;
  let stopping = false;
  let closed = false;
  let shutdownDeadline: NodeJS.Timeout | undefined;
  const lines = createInterface({ input: owned.stdout, crlfDelay: Infinity });
  const onLine = (line: string) => { if (!stopping) observer.onLine(line); };
  lines.on('line', onLine);
  const discardOwnedPipes = () => {
    lines.removeListener('line', onLine);
    lines.close();
    owned.stdout.removeListener('data', countBytes);
    owned.stderr.removeListener('data', countBytes);
    // Closing readline can pause stdout. Destroy ONLY these owned pipes rather
    // than leaving unread output paused or buffering it after the bound.
    owned.stdin.destroy();
    owned.stdout.destroy();
    owned.stderr.destroy();
  };
  const stop = () => {
    if (stopping || closed) return;
    stopping = true;
    if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM');
    discardOwnedPipes();
    // Success still requires the real child close event; an unaccounted live
    // child or unclosed stdio becomes an explicit bounded failure, never success.
    shutdownDeadline = setTimeout(() => {
      if (closed) return;
      if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
      discardOwnedPipes();
      exit.reject(new Error('Owned child did not close within the shutdown deadline'));
    }, 2500);
  };
  const countBytes = (chunk: Buffer) => {
    if (stopping) return;
    bytes += chunk.byteLength;
    if (bytes > MAX_OUTPUT_BYTES && !outputBoundHit) {
      outputBoundHit = true;
      observer.onOutputBound();
      stop();
    }
  };
  owned.stdout.prependListener('data', countBytes);
  owned.stderr.on('data', countBytes);
  const onError = (error: Error) => { exit.reject(error); };
  const onClose = (code: number | null) => {
    closed = true;
    clearTimeout(shutdownDeadline);
    clearInterval(killTimer);
    observer.onExitCode(code);
    exit.resolve();
  };
  owned.once('error', onError);
  owned.once('close', onClose);
  const killTimer = setInterval(() => {
    if ((stopping || observer.shouldForceKill()) && owned.exitCode === null && owned.signalCode === null) {
      owned.kill('SIGKILL');
    }
  }, 1000);
  return {
    completion: exit.promise,
    stop,
    dispose() {
      clearInterval(killTimer);
      clearTimeout(shutdownDeadline);
      lines.removeListener('line', onLine);
      lines.close();
      owned.stdout.removeListener('data', countBytes);
      owned.stderr.removeListener('data', countBytes);
      owned.removeListener('error', onError);
      owned.removeListener('close', onClose);
    },
  };
}
export interface CliProbeSceneCounters {
  begunTurns: number;
  denialTurns: number;
  normalTurns: number;
  modelRequests: number;
  probeScenes: number;
  textScenes: number;
  missingDeclaredBash: number;
  latestUserProbeTextMatches: number;
  toolResultContinuations: number;
  consecutiveProbeBudget: 1 | 3;
  correlatedProbeDenials: number;
}

/** Prompt ownership, not relay-specific request wrappers, selects each safe scene. */
export function createCliProbeSceneController(options: { consecutiveProbeBudget?: 1 | 3; mixedContent?: boolean } = {}) {
  const counters: CliProbeSceneCounters = {
    begunTurns: 0, denialTurns: 0, normalTurns: 0, modelRequests: 0,
    probeScenes: 0, textScenes: 0, missingDeclaredBash: 0,
    latestUserProbeTextMatches: 0, toolResultContinuations: 0,
    consecutiveProbeBudget: options.consecutiveProbeBudget ?? 1, correlatedProbeDenials: 0,
  };
  let turnKind: 'denial' | 'normal' = 'normal';
  let issuedThisTurn = 0;
  let lastIssuedId: string | undefined;
  const countedDenials = new Set<string>();
  const mixedProbes: MixedContentProbe[] = [];
  return {
    counters,
    mixedProbes,
    beginTurn(kind: 'denial' | 'normal') {
      turnKind = kind;
      issuedThisTurn = 0;
      lastIssuedId = undefined;
      countedDenials.clear();
      counters.begunTurns++;
      if (kind === 'denial') counters.denialTurns++; else counters.normalTurns++;
    },
    sceneForRequest(request: RecordedRequest): RelayScene {
      counters.modelRequests++;
      const messages = request.body.messages;
      if (Array.isArray(messages) && extractLatestUserText(messages).includes('AMP_DENIAL_PROBE')) counters.latestUserProbeTextMatches++;
      if (hasToolResults(request)) counters.toolResultContinuations++;
      const latestProbeDenied = lastIssuedId !== undefined && observedDenialReturnedToModel([request], lastIssuedId);
      if (latestProbeDenied && lastIssuedId !== undefined && !countedDenials.has(lastIssuedId)) {
        countedDenials.add(lastIssuedId);
        counters.correlatedProbeDenials++;
      }
      if (turnKind === 'denial' && issuedThisTurn < counters.consecutiveProbeBudget
        && (issuedThisTurn === 0 || latestProbeDenied) && counters.begunTurns > 0) {
        const tools = request.body.tools;
        const declaresBash = Array.isArray(tools) && tools.some((entry: unknown) => entry !== null
          && typeof entry === 'object' && 'name' in entry && entry.name === 'Bash');
        if (declaresBash) {
          issuedThisTurn++;
          lastIssuedId = counters.consecutiveProbeBudget === 1 ? `probe_${counters.begunTurns}` : `probe_${counters.begunTurns}_${issuedThisTurn}`;
          counters.probeScenes++;
          const content: Record<string, unknown>[] = [{ type: 'tool_use', id: lastIssuedId, name: 'Bash', input: { command: PROBE } }];
          if (options.mixedContent) {
            const marker = `AMP_TRAILING_TEXT_${lastIssuedId}`;
            mixedProbes.push({ id: lastIssuedId, marker, requestIndex: counters.modelRequests - 1 });
            content.push({ type: 'text', text: marker });
          }
          return { content };
        }
        counters.missingDeclaredBash++;
      }
      counters.textScenes++;
      return { content: [{ type: 'text', text: issuedThisTurn > 0 ? 'Mock acknowledges the harmless probe outcome. No further tool is needed.' : 'AMP_NORMAL_TURN_OK' }] };
    },
  };
}

export interface MixedContentProbe {
  id: string;
  marker: string;
  requestIndex: number;
}
export interface MixedContentNativeToolResult {
  type: string;
  outcome: string;
  explanation?: string;
}
export interface MixedContentBlockSequence {
  event: 'start' | 'delta' | 'stop';
  index: number;
  kind: 'text' | 'tool_use' | 'text_delta' | 'input_json_delta' | 'other';
}
export interface MixedContentDelivery {
  texts: Record<number, string>;
  captureFailed: boolean;
  nativeToolResults?: Record<string, MixedContentNativeToolResult>;
  blockSequence?: MixedContentBlockSequence[];
  omittedSequenceEvents?: number;
}
export interface MixedContentReplayEvidence {
  passed: boolean;
  verifiedProbes: number;
  failures: { probeId: string; reason: string }[];
}

/** Consume an explicitly supplied response clone, never the client's branch. */
export async function captureMixedContentDelivery(response: Response, options: { includeStructure?: boolean } = {}): Promise<MixedContentDelivery> {
  const captured: MixedContentDelivery = { texts: {}, captureFailed: false };
  if (options.includeStructure) { captured.blockSequence = []; captured.omittedSequenceEvents = 0; }
  const recordSequence = (event: MixedContentBlockSequence['event'], index: number, kind: MixedContentBlockSequence['kind']) => {
    if (!captured.blockSequence) return;
    if (captured.blockSequence.length < 64) captured.blockSequence.push({ event, index, kind });
    else captured.omittedSequenceEvents = (captured.omittedSequenceEvents ?? 0) + 1;
  };
  if (!response.body || response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'text/event-stream') {
    captured.captureFailed = true;
    void response.body?.cancel().catch(() => { captured.captureFailed = true; });
    return captured;
  }
  const reader = parseSse(response.body).getReader();
  let bytes = 0;
  let messageStopped = false;
  let terminalNativeResults: unknown;
  const timeout = setTimeout(() => {
    captured.captureFailed = true;
    void reader.cancel().catch(() => { captured.captureFailed = true; });
  }, TURN_TIMEOUT_MS);
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.raw.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        captured.captureFailed = true;
        void reader.cancel().catch(() => { captured.captureFailed = true; });
        break;
      }
      if (item.value.data === undefined) continue;
      const decoded: unknown = JSON.parse(item.value.data);
      const parsed = z.record(z.string(), z.unknown()).safeParse(decoded);
      if (!parsed.success) { captured.captureFailed = true; break; }
      const event = parsed.data;
      if (messageStopped && event.type !== 'ping') { captured.captureFailed = true; break; }
      if (event.type === 'message_stop') messageStopped = true;
      if (event.type === 'error') captured.captureFailed = true;
      if (event.type === 'message_delta') {
        const delta = z.record(z.string(), z.unknown()).safeParse(event.delta);
        if (!delta.success) { captured.captureFailed = true; break; }
        // Only the final delta before message_stop is native-delivery authority.
        terminalNativeResults = delta.data.safeguard_results;
      }
      const index = event.index;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) continue;
      if (event.type === 'content_block_start') {
        const block = z.record(z.string(), z.unknown()).safeParse(event.content_block);
        const kind = block.success ? block.data.type : undefined;
        recordSequence('start', index, kind === 'text' || kind === 'tool_use' ? kind : 'other');
        if (block.success && block.data.type === 'text' && typeof block.data.text === 'string') captured.texts[index] = block.data.text;
      } else if (event.type === 'content_block_delta') {
        const delta = z.record(z.string(), z.unknown()).safeParse(event.delta);
        const kind = delta.success ? delta.data.type : undefined;
        recordSequence('delta', index, kind === 'text_delta' || kind === 'input_json_delta' ? kind : 'other');
        if (delta.success && delta.data.type === 'text_delta') {
          if (!Object.hasOwn(captured.texts, index) || typeof delta.data.text !== 'string') captured.captureFailed = true;
          else captured.texts[index] += delta.data.text;
        }
      } else if (event.type === 'content_block_stop') {
        recordSequence('stop', index, 'other');
      }
    }
  } catch { captured.captureFailed = true; }
  finally {
    clearTimeout(timeout);
    if (captured.captureFailed) void reader.cancel().catch(() => { captured.captureFailed = true; });
    reader.releaseLock();
  }
  captured.captureFailed ||= !messageStopped;
  if (terminalNativeResults !== undefined) {
    const envelopes = z.array(z.object({ type: z.string(), status: z.unknown() })).safeParse(terminalNativeResults);
    const dangerous = envelopes.success ? envelopes.data.filter((entry) => entry.type === 'dangerous_tool_use') : [];
    if (dangerous.length !== 1) captured.captureFailed = true;
    else {
      const status = z.object({
        type: z.literal('available'),
        tool_uses: z.record(z.string(), z.object({ type: z.string(), outcome: z.string(), explanation: z.string().optional() })),
      }).safeParse(dangerous[0]!.status);
      if (!status.success) captured.captureFailed = true;
      else captured.nativeToolResults = status.data.tool_uses;
    }
  }
  return captured;
}

/** Validate the immediate actual model request, not unrelated historical prose. */
export function observeMixedContentReplay(
  delivery: 'native' | 'rewrite',
  requests: readonly RecordedRequest[],
  probes: readonly MixedContentProbe[],
  deliveries: ReadonlyMap<string, MixedContentDelivery>,
): MixedContentReplayEvidence {
  const evidence: MixedContentReplayEvidence = { passed: false, verifiedProbes: 0, failures: [] };
  const messageSchema = z.object({
    role: z.string(), content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  });
  const seen = new Set<string>();
  if (!probes.length) evidence.failures.push({ probeId: '', reason: 'no_mixed_probes_emitted' });
  for (const probe of probes) {
    const fail = (reason: string) => evidence.failures.push({ probeId: probe.id, reason });
    if (seen.has(probe.id)) { fail('duplicate_emitted_probe_id'); continue; }
    seen.add(probe.id);
    if (!Number.isSafeInteger(probe.requestIndex) || probe.requestIndex < 0 || probe.marker !== `AMP_TRAILING_TEXT_${probe.id}`) {
      fail('invalid_emitted_probe_identity'); continue;
    }
    const captured = deliveries.get(probe.id);
    if (!captured || captured.captureFailed) { fail('delivered_response_capture_failed'); continue; }
    if (captured.texts[1] !== probe.marker) { fail('delivered_trailing_marker_corrupt_or_missing'); continue; }
    const next = requests[probe.requestIndex + 1];
    if (!next) { fail('immediate_next_model_request_missing'); continue; }
    const parsed = z.array(messageSchema).safeParse(next.body.messages);
    if (!parsed.success) { fail('replay_message_shape_invalid'); continue; }
    const messages = parsed.data;
    const calls: { messageIndex: number; blockIndex: number; block: Record<string, unknown> }[] = [];
    const results: { messageIndex: number; block: Record<string, unknown> }[] = [];
    const messageTexts: string[] = [];
    let markerCount = 0;
    for (const [messageIndex, message] of messages.entries()) {
      const blocks = typeof message.content === 'string' ? [] : message.content;
      const text = typeof message.content === 'string' ? message.content : blocks.flatMap((block) =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
      messageTexts.push(text);
      markerCount += text.split(/[^A-Za-z0-9_]+/u).filter((token) => token === probe.marker).length;
      for (const [blockIndex, block] of blocks.entries()) {
        if (block.type === 'tool_use' && block.id === probe.id) calls.push({ messageIndex, blockIndex, block });
        if (block.type === 'tool_result' && block.tool_use_id === probe.id) results.push({ messageIndex, block });
      }
    }
    if (markerCount !== 1) { fail('replay_marker_missing_or_duplicated'); continue; }
    if (delivery === 'native') {
      if (calls.length !== 1) { fail('native_probe_call_missing_or_duplicated'); continue; }
      const call = calls[0]!;
      const owner = messages[call.messageIndex]!;
      const input = z.record(z.string(), z.unknown()).safeParse(call.block.input);
      if (owner.role !== 'assistant' || call.block.name !== 'Bash' || !input.success || input.data.command !== PROBE) {
        fail('native_probe_call_corrupt'); continue;
      }
      const markerIndex = typeof owner.content === 'string' ? -1 : owner.content.findIndex((block) =>
        block.type === 'text' && typeof block.text === 'string' && block.text.split(/[^A-Za-z0-9_]+/u).includes(probe.marker));
      if (markerIndex <= call.blockIndex) { fail('native_trailing_marker_misassociated_or_reordered'); continue; }
      const native = captured.nativeToolResults && Object.hasOwn(captured.nativeToolResults, probe.id)
        ? captured.nativeToolResults[probe.id] : undefined;
      const explanation = native?.explanation;
      if (native?.type !== 'evaluated' || native.outcome !== 'flagged' || typeof explanation !== 'string'
        || !explanation.startsWith('[auto-mode-proxy]') || !explanation.slice('[auto-mode-proxy]'.length).trim()) {
        fail('native_authoritative_proxy_denial_missing_or_invalid'); continue;
      }
      if (results.length !== 1 || results[0]!.messageIndex <= call.messageIndex
        || messages[results[0]!.messageIndex]?.role !== 'user' || results[0]!.block.is_error !== true) {
        fail('native_correlated_denial_result_missing_or_corrupt'); continue;
      }
      const content = results[0]!.block.content;
      const returnedText = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap((part: unknown) => {
        if (part && typeof part === 'object' && 'type' in part && part.type === 'text'
          && 'text' in part && typeof part.text === 'string') return [part.text];
        return [];
      }).join('\n') : '';
      if (!returnedText.includes(explanation)) { fail('native_authoritative_explanation_not_preserved'); continue; }
    } else {
      if (calls.length || results.length) { fail('rewrite_leaked_probe_execution_or_result'); continue; }
      const denial = captured.texts[0];
      if (typeof denial !== 'string' || !denial.startsWith('[auto-mode-proxy]') || !/\bblocked\b/i.test(denial)) {
        fail('captured_proxy_denial_missing_or_invalid'); continue;
      }
      const matching = messages.filter((message, index) => {
        if (message.role !== 'assistant') return false;
        const text = messageTexts[index]!;
        const denialIndex = text.indexOf(denial);
        const markerIndex = text.indexOf(probe.marker);
        return denialIndex >= 0 && markerIndex >= denialIndex + denial.length
          && text.split(/[^A-Za-z0-9_]+/u).includes(probe.marker);
      });
      if (matching.length !== 1) { fail('rewrite_denial_and_marker_missing_corrupt_or_misassociated'); continue; }
    }
    evidence.verifiedProbes++;
  }
  evidence.passed = probes.length > 0 && evidence.verifiedProbes === probes.length && evidence.failures.length === 0;
  return evidence;
}

export interface MixedTextPositions { count: number; offsets: number[] }
export interface MixedReplayBlockStructure {
  messageIndex: number;
  blockIndex: number;
  groupBlockIndex: number | null;
  role: 'assistant' | 'user' | 'system' | 'other';
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking' | 'other';
  stringContentRepresentation: boolean;
  ownToolId: boolean;
  ownResultId: boolean;
  bashName: boolean;
  inputObject: boolean;
  commandPresent: boolean;
  commandExact: boolean;
  isError: boolean | null;
  textLength: number;
  marker: MixedTextPositions;
  explanation: MixedTextPositions;
}
export interface MixedAssistantGroupStructure {
  groupIndex: number;
  messageStart: number;
  messageEnd: number;
  blockCount: number;
  blocks: MixedReplayBlockStructure[];
  omittedBlocks: number;
  concatenatedText: { length: number; marker: MixedTextPositions; explanation: MixedTextPositions };
  newlineJoinedText: { length: number; marker: MixedTextPositions; explanation: MixedTextPositions };
}
export interface MixedContentReplayStructure {
  probeId: string;
  emittedRequestIndex: number;
  immediateNextRequestIndex: number;
  nextRequestPresent: boolean;
  replayShapeValid: boolean;
  diagnosticComplete: boolean;
  totalMessages: number;
  omittedProbes: number;
  capture: {
    path: 'proxied_loopback_response_clone';
    missing: boolean;
    failed: boolean;
    markerAtIndex1Exact: boolean;
    nativeEvaluated: boolean;
    nativeFlagged: boolean;
    nativeProxyExplanation: boolean;
    explanationLength: number;
    blockSequence: MixedContentBlockSequence[];
    omittedSequenceEvents: number;
  };
  assistantGroups: MixedAssistantGroupStructure[];
  omittedAssistantGroups: number;
  omittedRelevantAssistantGroups: number;
  nonAssistantMatches: MixedReplayBlockStructure[];
  omittedNonAssistantMatches: number;
  offsetUnits: 'utf16_code_units';
}

/** Diagnostic only: do not reinterpret the strict observer's failure as a pass. */
export function describeMixedContentReplay(
  delivery: 'native' | 'rewrite',
  requests: readonly RecordedRequest[],
  probes: readonly MixedContentProbe[],
  deliveries: ReadonlyMap<string, MixedContentDelivery>,
): MixedContentReplayStructure[] {
  const positions = (text: string, needle: string): MixedTextPositions => {
    const found: MixedTextPositions = { count: 0, offsets: [] };
    if (!needle) return found;
    let offset = text.indexOf(needle);
    while (offset >= 0) {
      found.count++;
      if (found.offsets.length < 8) found.offsets.push(offset);
      offset = text.indexOf(needle, offset + needle.length);
    }
    return found;
  };
  const schema = z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]) }));
  const reports: MixedContentReplayStructure[] = [];
  for (const probe of probes.slice(0, 8)) {
    const captured = deliveries.get(probe.id);
    const native = captured?.nativeToolResults && Object.hasOwn(captured.nativeToolResults, probe.id) ? captured.nativeToolResults[probe.id] : undefined;
    const explanation = (delivery === 'native' ? native?.explanation : captured?.texts[0]) ?? '';
    const next = requests[probe.requestIndex + 1];
    const parsed = schema.safeParse(next?.body.messages);
    const report: MixedContentReplayStructure = {
      probeId: probe.id, emittedRequestIndex: probe.requestIndex, immediateNextRequestIndex: probe.requestIndex + 1,
      nextRequestPresent: next !== undefined, replayShapeValid: parsed.success, diagnosticComplete: false,
      totalMessages: Array.isArray(next?.body.messages) ? next.body.messages.length : 0,
      omittedProbes: Math.max(0, probes.length - 8),
      capture: {
        path: 'proxied_loopback_response_clone', missing: captured === undefined, failed: captured?.captureFailed ?? true,
        markerAtIndex1Exact: captured?.texts[1] === probe.marker,
        nativeEvaluated: native?.type === 'evaluated', nativeFlagged: native?.outcome === 'flagged',
        nativeProxyExplanation: typeof native?.explanation === 'string' && native.explanation.startsWith('[auto-mode-proxy]')
          && native.explanation.slice('[auto-mode-proxy]'.length).trim().length > 0,
        explanationLength: explanation.length, blockSequence: captured?.blockSequence ?? [], omittedSequenceEvents: captured?.omittedSequenceEvents ?? 0,
      },
      assistantGroups: [], omittedAssistantGroups: 0, omittedRelevantAssistantGroups: 0,
      nonAssistantMatches: [], omittedNonAssistantMatches: 0,
      offsetUnits: 'utf16_code_units',
    };
    reports.push(report);
    if (!parsed.success) continue;
    const groups: { report: MixedAssistantGroupStructure; texts: string[]; relevant: boolean }[] = [];
    let current: { report: MixedAssistantGroupStructure; texts: string[]; relevant: boolean } | undefined;
    const nonAssistantMatches: MixedReplayBlockStructure[] = [];
    for (const [messageIndex, message] of parsed.data.entries()) {
      const role: MixedReplayBlockStructure['role'] = message.role === 'assistant' || message.role === 'user' || message.role === 'system' ? message.role : 'other';
      if (role !== 'assistant') current = undefined;
      else if (!current) {
        current = {
          report: { groupIndex: groups.length, messageStart: messageIndex, messageEnd: messageIndex, blockCount: 0, blocks: [], omittedBlocks: 0,
            concatenatedText: { length: 0, marker: positions('', ''), explanation: positions('', '') },
            newlineJoinedText: { length: 0, marker: positions('', ''), explanation: positions('', '') } },
          texts: [], relevant: false,
        };
        groups.push(current);
      }
      if (current) current.report.messageEnd = messageIndex;
      const stringContentRepresentation = typeof message.content === 'string';
      const blocks: Record<string, unknown>[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      for (const [blockIndex, block] of blocks.entries()) {
        let text = block.type === 'text' && typeof block.text === 'string' ? block.text : '';
        if (block.type === 'tool_result') {
          const content = block.content;
          text = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap((part: unknown) => {
            if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return [part.text];
            return [];
          }).join('\n') : '';
        }
        const input = z.record(z.string(), z.unknown()).safeParse(block.input);
        const type = block.type;
        const item: MixedReplayBlockStructure = {
          messageIndex, blockIndex, groupBlockIndex: current?.report.blockCount ?? null, role,
          type: type === 'text' || type === 'tool_use' || type === 'tool_result' || type === 'thinking' || type === 'redacted_thinking' ? type : 'other',
          stringContentRepresentation, ownToolId: type === 'tool_use' && block.id === probe.id,
          ownResultId: type === 'tool_result' && block.tool_use_id === probe.id, bashName: block.name === 'Bash',
          inputObject: input.success, commandPresent: input.success && Object.hasOwn(input.data, 'command'),
          commandExact: input.success && input.data.command === PROBE,
          isError: type === 'tool_result' && typeof block.is_error === 'boolean' ? block.is_error : null,
          textLength: text.length, marker: positions(text, probe.marker), explanation: positions(text, explanation),
        };
        const relevant = item.ownToolId || item.ownResultId || item.marker.count > 0 || item.explanation.count > 0;
        if (current) {
          current.relevant ||= relevant;
          current.report.blockCount++;
          if (current.report.blocks.length < 64) current.report.blocks.push(item); else current.report.omittedBlocks++;
          if (type === 'text') current.texts.push(text);
        } else if (relevant) nonAssistantMatches.push(item);
      }
    }
    const selected = new Set<number>();
    for (const [index, group] of groups.entries()) {
      const concatenated = group.texts.join('');
      const newlineJoined = group.texts.join('\n');
      group.report.concatenatedText = { length: concatenated.length, marker: positions(concatenated, probe.marker), explanation: positions(concatenated, explanation) };
      group.report.newlineJoinedText = { length: newlineJoined.length, marker: positions(newlineJoined, probe.marker), explanation: positions(newlineJoined, explanation) };
      group.relevant ||= group.report.concatenatedText.marker.count > 0 || group.report.concatenatedText.explanation.count > 0;
      if (group.relevant) {
        for (const neighbor of [index - 1, index, index + 1]) if (neighbor >= 0 && neighbor < groups.length) selected.add(neighbor);
      }
    }
    if (!selected.size) for (let index = Math.max(0, groups.length - 3); index < groups.length; index++) selected.add(index);
    const groupIndices = [...selected].sort((a, b) => a - b).slice(0, 8);
    report.assistantGroups = groupIndices.map((index) => groups[index]!.report);
    report.omittedAssistantGroups = groups.length - groupIndices.length;
    report.omittedRelevantAssistantGroups = groups.filter((group, index) => group.relevant && !groupIndices.includes(index)).length;
    report.nonAssistantMatches = nonAssistantMatches.slice(-24);
    report.omittedNonAssistantMatches = nonAssistantMatches.length - report.nonAssistantMatches.length;
    report.diagnosticComplete = captured !== undefined && !captured.captureFailed && captured.blockSequence !== undefined
      && report.capture.omittedSequenceEvents === 0 && report.omittedProbes === 0
      && report.omittedRelevantAssistantGroups === 0 && report.omittedNonAssistantMatches === 0
      && report.assistantGroups.every((group) => group.omittedBlocks === 0);
  }
  return reports;
}

const VERSION_OVERRIDE_QA_VERSION = '2.1.311';

/** A dedicated QA route, never an implicit production capability declaration. */
export function versionOverrideRewriteQaRoute(): ClaudeRoute {
  return { claude_delivery: 'auto', claude_delivery_by_version: { [VERSION_OVERRIDE_QA_VERSION]: 'rewrite' } };
}

/** Match the actual server's observed user-agent metadata; never invent a version. */
export function observedQaClaudeVersion(userAgent: string | null): string | null {
  return /\bclaude-(?:cli|code)\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/i.exec(userAgent ?? '')?.[1] ?? null;
}

export interface VersionOverrideProbeSource { userAgent: string | null; safeguards: boolean }
export interface VersionOverrideRewriteEvidence {
  mode: 'version-override-rewrite';
  passed: boolean;
  configuration: ClaudeRoute;
  expectedAgentVersion: string;
  selectionProvenance: 'original_client_header_and_opt_in_exact_auto_route_table_per_probe_rewrite_wire_and_audit';
  provenOverrideHits: number;
  verifiedRewriteProbes: number;
  noOptInRewriteProbes: number;
  probes: {
    probeId: string;
    observedAgentVersion: string | null;
    originalSafeguards: boolean;
    matchingAuditRecords: number;
    auditServerVersionMatches: boolean;
    rewriteAuditBlock: boolean;
    capturedRewriteOnly: boolean;
    selectedBy: 'exact_version_override' | 'no_original_safeguards' | 'unproven';
  }[];
  failures: { probeId: string; reason: string }[];
}
export interface VersionOverrideRewriteObservation {
  route: ClaudeRoute;
  probes: readonly MixedContentProbe[];
  sources: ReadonlyMap<string, VersionOverrideProbeSource>;
  deliveries: ReadonlyMap<string, MixedContentDelivery>;
  auditRecords: readonly unknown[];
  strictRewriteReplay: MixedContentReplayEvidence | undefined;
}

/** Establish override use from actual input/configuration/output/audit evidence. */
export function observeVersionOverrideRewrite(input: VersionOverrideRewriteObservation): VersionOverrideRewriteEvidence {
  const overrides = input.route.claude_delivery_by_version;
  const evidence: VersionOverrideRewriteEvidence = {
    mode: 'version-override-rewrite', passed: false,
    configuration: { claude_delivery: input.route.claude_delivery, claude_delivery_by_version: { ...overrides } },
    expectedAgentVersion: VERSION_OVERRIDE_QA_VERSION,
    selectionProvenance: 'original_client_header_and_opt_in_exact_auto_route_table_per_probe_rewrite_wire_and_audit',
    provenOverrideHits: 0, verifiedRewriteProbes: 0, noOptInRewriteProbes: 0, probes: [], failures: [],
  };
  const configured = input.route.claude_delivery === 'auto' && overrides !== undefined
    && Object.keys(overrides).length === 1 && Object.hasOwn(overrides, VERSION_OVERRIDE_QA_VERSION)
    && overrides[VERSION_OVERRIDE_QA_VERSION] === 'rewrite';
  if (!configured) evidence.failures.push({ probeId: '', reason: 'required_auto_route_exact_version_override_not_configured' });
  if (!input.strictRewriteReplay?.passed || input.strictRewriteReplay.verifiedProbes !== input.probes.length || !input.probes.length) {
    evidence.failures.push({ probeId: '', reason: 'original_strict_rewrite_replay_not_proven' });
  }
  for (const probe of input.probes) {
    const source = input.sources.get(probe.id);
    const version = observedQaClaudeVersion(source?.userAgent ?? null);
    const rows: { row: Record<string, unknown>; raw: Record<string, unknown> }[] = [];
    for (const value of input.auditRecords) {
      const row = z.record(z.string(), z.unknown()).safeParse(value);
      const action = row.success ? z.record(z.string(), z.unknown()).safeParse(row.data.action) : undefined;
      const raw = action?.success ? z.record(z.string(), z.unknown()).safeParse(action.data.raw) : undefined;
      if (row.success && raw?.success && raw.data.id === probe.id) rows.push({ row: row.data, raw: raw.data });
    }
    const audit = rows.length === 1 ? rows[0] : undefined;
    const auditInput = audit ? z.record(z.string(), z.unknown()).safeParse(audit.raw.input) : undefined;
    const serverVersion = audit?.row.agent_hint === `claude-code/${VERSION_OVERRIDE_QA_VERSION}`;
    const rewriteBlock = audit !== undefined && audit.row.route === '/cc' && audit.row.protocol === 'anthropic-messages'
      && audit.row.delivery === 'rewrite' && audit.row.verdict === 'block' && audit.row.tool === 'Bash'
      && audit.raw.type === 'tool_use' && audit.raw.name === 'Bash' && auditInput?.success === true && auditInput.data.command === PROBE;
    const captured = input.deliveries.get(probe.id);
    const rewriteOnly = captured !== undefined && !captured.captureFailed && captured.nativeToolResults === undefined
      && captured.texts[1] === probe.marker && typeof captured.texts[0] === 'string'
      && captured.texts[0].startsWith('[auto-mode-proxy]') && /\bblocked\b/i.test(captured.texts[0])
      && captured.blockSequence !== undefined && captured.blockSequence.length > 0 && (captured.omittedSequenceEvents ?? 0) === 0
      && captured.blockSequence.every((entry) => entry.kind !== 'tool_use' && entry.kind !== 'input_json_delta');
    const rewriteProven = configured && version === VERSION_OVERRIDE_QA_VERSION && serverVersion && rewriteBlock && rewriteOnly;
    evidence.probes.push({ probeId: probe.id, observedAgentVersion: version, originalSafeguards: source?.safeguards ?? false,
      matchingAuditRecords: rows.length, auditServerVersionMatches: serverVersion, rewriteAuditBlock: rewriteBlock, capturedRewriteOnly: rewriteOnly,
      selectedBy: !rewriteProven ? 'unproven' : source?.safeguards ? 'exact_version_override' : 'no_original_safeguards' });
    if (version !== VERSION_OVERRIDE_QA_VERSION) evidence.failures.push({ probeId: probe.id, reason: 'actual_client_version_missing_or_different' });
    if (!serverVersion || !rewriteBlock) evidence.failures.push({ probeId: probe.id, reason: 'matching_per_probe_versioned_rewrite_block_audit_missing' });
    if (!rewriteOnly) evidence.failures.push({ probeId: probe.id, reason: 'actual_rewrite_only_wire_not_proven' });
    if (rewriteProven) {
      evidence.verifiedRewriteProbes++;
      if (source?.safeguards) evidence.provenOverrideHits++; else evidence.noOptInRewriteProbes++;
    }
  }
  if (evidence.provenOverrideHits === 0) evidence.failures.push({ probeId: '', reason: 'no_genuine_opt_in_version_override_hit' });
  evidence.passed = input.probes.length > 0 && evidence.verifiedRewriteProbes === input.probes.length
    && evidence.provenOverrideHits > 0 && evidence.failures.length === 0;
  return evidence;
}

async function runCli(delivery: 'native' | 'rewrite', executable: string, root: string, interactive = false, consecutive = false, mixedContent = false, versionOverrideRewrite = false): Promise<RunEvidence> {
  const workdir = join(root, delivery);
  await mkdir(workdir, { recursive: true });
  const home = join(workdir, 'home'); await mkdir(home);
  const settings = join(workdir, 'settings.json');
  const mcp = join(workdir, 'mcp.json');
  await writeFile(settings, JSON.stringify({ hooks: {}, disableAllHooks: true, enableAllProjectMcpServers: false, permissions: { defaultMode: 'auto' } }));
  await writeFile(mcp, JSON.stringify({ mcpServers: {} }));
  const requests: RecordedRequest[] = [];
  const scenes = createCliProbeSceneController({ consecutiveProbeBudget: consecutive ? 3 : 1, mixedContent });
  const mixedDeliveries = new Map<string, MixedContentDelivery>();
  const pendingMixedCaptures = new Set<Promise<void>>();
  const versionOverrideSources = new Map<string, VersionOverrideProbeSource>();
  let lastInteractiveUserText = '';
  const relay = createMockRelay({ sceneForRequest: (request) => {
    requests.push(request);
    if (interactive) {
      const messages = request.body.messages;
      const text = Array.isArray(messages) ? extractLatestUserText(messages) : '';
      if (text && text !== lastInteractiveUserText && !hasToolResults(request)
        && (!consecutive || text.includes('AMP_DENIAL_PROBE') || text.includes('AMP_NORMAL_TURN_OK') || text.includes('AMP_NORMAL_OBSERVATION'))) {
        lastInteractiveUserText = text;
        scenes.beginTurn(text.includes('AMP_DENIAL_PROBE') ? 'denial' : 'normal');
      }
    }
    return scenes.sceneForRequest(request);
  } });
  const decision = createMockDecision({ mode: 'deny' });
  const listeners: { close(): Promise<void> }[] = [];
  let flushApp: (() => Promise<void>) | undefined;
  let child: ChildProcess | undefined;
  const evidence: RunEvidence = {
    delivery, interactionMode: interactive ? 'interactive' : 'print', sceneCounters: scenes.counters, mixedContent,
    ...(mixedContent ? { mixedParserErrorObserved: false } : {}),
    cliVersion: null, observedSourceModelRequests: [], completedTurns: 0, completedNormalTurns: 0, completedDenialTurns: 0,
    resultErrors: 0, cliExitCode: null, timedOut: false, outputBoundHit: false,
    observedAssistantProbeCalls: 0, observedProbeResults: 0, observedDeniedProbeResults: 0, observedSuccessfulProbeResults: 0,
    observedDenialReturnedToModel: false, observedSafeguardsRequests: 0, observedClassifierRequests: 0, observedRequestCount: 0,
    observedNativeAuditBlocks: 0, observedRewriteAuditBlocks: 0, observedDecisionProviderRequests: 0, observedDecisionDeniedProbeRequests: 0,
    observedEscalationText: false, observedEnabledStatusText: false, observedProbeOnlyToolPayloads: true,
  };
  let runTimer: NodeJS.Timeout | undefined;
  let turnTimer: NodeJS.Timeout | undefined;
  try {
    const upstream = await startLoopback(relay.app); listeners.push(upstream);
    const trusted = await startLoopback(decision.app); listeners.push(trusted);
    const config = configSchema.parse({
      auth: { mode: 'vault', client_tokens: ['fake-cli-proxy-token'] },
      routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock',
        ...(versionOverrideRewrite ? versionOverrideRewriteQaRoute() : { claude_delivery: delivery }), project_dirs: [workdir] }],
      upstreams: { mock: { base_url: upstream.url, api_key: 'fake-relay-token' } },
      gate: { mode: 'enforce', on_provider_failure: 'block', provider_timeout_ms: 200 },
      decision: { chain: ['mock'], providers: { mock: { kind: 'systemone', base_url: trusted.url, api_key: 'fake-decision-token', model: 'mock' } }, second_stage: { base_url: trusted.url, api_key: 'fake-classifier-token', model: 'mock-classifier' } },
      classifier_reroute: { enabled: true, model_map: { 'claude-sonnet-5': 'mock-classifier', 'claude-haiku-5-5': 'mock-classifier', 'claude-haiku-5.5': 'mock-classifier' } },
      // Exercise the trusted mock decision chain, not a readonly allow or hard rule.
      policy: { readonly_programs: [] },
      audit: { path: join(workdir, 'audit.jsonl') }, log_level: 'silent',
    });
    const proxy = createApp(config);
    flushApp = proxy.flushAudit;
    const ingress = new Hono();
    ingress.use('*', bodyLimit({ maxSize: 8 * 1024 * 1024 }));
    ingress.all('*', async (context) => {
      let originalSource: VersionOverrideProbeSource | undefined;
      if (context.req.method === 'POST' && context.req.path.endsWith('/messages')) {
        if (evidence.observedSourceModelRequests.length >= 128) return context.json({ error: 'manual QA request bound' }, 429);
        const body: unknown = await context.req.raw.clone().json();
        const parsed = z.record(z.string(), z.unknown()).safeParse(body);
        if (!parsed.success) return context.json({ error: 'manual QA invalid request' }, 400);
        const request: RecordedRequest = { method: context.req.method, path: context.req.path, headers: context.req.raw.headers, body: parsed.data };
        const optIn = Object.hasOwn(request.body, 'safeguards');
        originalSource = { userAgent: request.headers.get('user-agent'), safeguards: optIn };
        evidence.observedSafeguardsRequests += Number(optIn);
        evidence.observedSourceModelRequests.push({
          stream: request.body.stream === true, safeguards: optIn,
          sessionHeader: request.headers.has('x-session-id') || request.headers.has('x-claude-code-session-id'),
          versionHeader: /claude-(?:cli|code)\/\d+\.\d+\.\d+/.test(request.headers.get('user-agent') ?? ''),
          agentVersion: observedQaClaudeVersion(request.headers.get('user-agent')),
          dangerousBeta: request.headers.get('anthropic-beta')?.includes('dangerous-tool-use-2026-09-03') ?? false,
          toolResult: hasToolResults(request),
          bashDeclared: Array.isArray(request.body.tools) && request.body.tools.some((tool: unknown) => tool !== null
            && typeof tool === 'object' && 'name' in tool && tool.name === 'Bash'),
        });
      }
      const requestIndex = requests.length;
      const response = await proxy.fetch(context.req.raw);
      const probe = mixedContent && requests.length === requestIndex + 1
        ? scenes.mixedProbes.find((entry) => entry.requestIndex === requestIndex) : undefined;
      if (probe) {
        if (versionOverrideRewrite && originalSource) versionOverrideSources.set(probe.id, originalSource);
        // Observe a clone without waiting before returning the original bytes.
        const capture = captureMixedContentDelivery(response.clone(), { includeStructure: true }).then(
          (snapshot) => { mixedDeliveries.set(probe.id, snapshot); },
          () => { mixedDeliveries.set(probe.id, { texts: {}, captureFailed: true }); },
        );
        pendingMixedCaptures.add(capture);
        void capture.then(() => pendingMixedCaptures.delete(capture));
      }
      return response;
    });
    const gateway = await startLoopback(ingress); listeners.push(gateway);
    const session = randomUUID();
    const denialPrompts = Array.from({ length: 3 }, (_, i) => ({
      kind: 'denial' as const,
      text: `Safe denial observation ${i + 1}: request the Bash tool with exactly printf AMP_DENIAL_PROBE once. If denied, acknowledge and do not retry or use any other tool.`,
    }));
    const prompts = [
      ...(mixedContent ? denialPrompts.flatMap((prompt, i) => [prompt, {
        kind: 'normal' as const, text: `Harmless continuation ${i + 1}: reply briefly without using tools.`,
      }]) : denialPrompts),
      ...Array.from({ length: 5 }, (_, i) => ({ kind: 'normal' as const, text: `Normal conversation turn ${i + 1}: reply with AMP_NORMAL_TURN_OK. Do not call any tool.` })),
    ];
    // Deliberately do not inherit credentials, HOME, user settings, hooks, MCP,
    // NODE_OPTIONS, proxy overrides or provider endpoints from the parent.
    // --tools changes availability only; keep auto permissions and never preapprove Bash.
    // Documented at https://code.claude.com/docs/en/cli-reference#cli-flags.
    const cliArguments = ['--tools', 'Bash', '--permission-mode', 'auto', '--session-id', session, '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--model', 'claude-sonnet-5'];
    const environment = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: workdir,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_BASE_URL: `${gateway.url}/cc`, ANTHROPIC_AUTH_TOKEN: 'fake-cli-proxy-token', ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-haiku-5-5',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      BROWSER: '/bin/false',
    };
    if (interactive) {
      const scenario = consecutive
        ? 'Send ONE prompt AMP_DENIAL_PROBE consecutive. The mock may emit at most three identical harmless attempts within that human request, advancing only after each actual correlated denial result.'
        : 'Send three distinct prompts AMP_DENIAL_PROBE 1, AMP_DENIAL_PROBE 2, AMP_DENIAL_PROBE 3. Separate human turns do NOT establish consecutive-denial escalation.';
      process.stderr.write(`Interactive ${delivery} loopback MOCK QA; all settings are disposable. Inspect /status. ${scenario} Never approve a blocked tool; the only mock tool command is printf AMP_DENIAL_PROBE. Finish with /exit. UI observations require separate parent evidence; JSON cannot attest inherited terminal output.\n`);
      const owned = spawn(executable, cliArguments, { cwd: workdir, env: environment, stdio: 'inherit' });
      child = owned;
      const exited = Promise.withResolvers<void>();
      let force: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;
      const stopInteractive = () => {
        if (owned.exitCode !== null || owned.signalCode !== null) return;
        owned.kill('SIGTERM');
        if (!force) force = setTimeout(() => owned.kill('SIGKILL'), 1000);
        if (!deadline) deadline = setTimeout(() => exited.reject(new Error('Owned interactive child did not close')), 2500);
      };
      owned.once('error', exited.reject);
      owned.once('close', (code) => { evidence.cliExitCode = code; exited.resolve(); });
      process.on('SIGINT', stopInteractive);
      process.on('SIGTERM', stopInteractive);
      runTimer = setTimeout(() => { evidence.timedOut = true; stopInteractive(); }, RUN_TIMEOUT_MS);
      try { await exited.promise; }
      finally {
        clearTimeout(force); clearTimeout(deadline);
        process.removeListener('SIGINT', stopInteractive);
        process.removeListener('SIGTERM', stopInteractive);
      }
    } else {
    const owned = spawn(executable, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', ...cliArguments], {
      cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, CI: '1', NO_COLOR: '1' },
    });
    child = owned;
    let nextPrompt = 0;
    const stopOwned = () => { if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM'); };
    owned.stdin.on('error', stopOwned);
    let parserDiagnosticTail = '';
    const observeParserDiagnostic = (chunk: Buffer) => {
      if (!mixedContent) return;
      const text = parserDiagnosticTail + chunk.toString('utf8');
      evidence.mixedParserErrorObserved ||= /\b(?:failed|unable) to parse\b|\b(?:parsing|parser|syntax) error\b|\b(?:SyntaxError|JSONParseError|APIResponseValidationError)\b|\binvalid (?:sse|json|stream) (?:event|response|frame)\b/i.test(text);
      parserDiagnosticTail = text.slice(-512);
    };
    if (mixedContent) owned.stderr.on('data', observeParserDiagnostic);
    const sendNext = () => {
      clearTimeout(turnTimer);
      if (nextPrompt >= prompts.length) { owned.stdin.end(); return; }
      const prompt = prompts[nextPrompt++]!;
      scenes.beginTurn(prompt.kind);
      owned.stdin.write(`${JSON.stringify({ type: 'user', session_id: session, parent_tool_use_id: null, message: { role: 'user', content: prompt.text } })}\n`);
      turnTimer = setTimeout(() => { evidence.timedOut = true; stopOwned(); }, TURN_TIMEOUT_MS);
    };
    const lifecycle = attachCliProcess(owned, {
      onOutputBound: () => { evidence.outputBoundHit = true; },
      onExitCode: (code) => { evidence.cliExitCode = code; },
      shouldForceKill: () => evidence.timedOut || evidence.outputBoundHit || !evidence.observedProbeOnlyToolPayloads,
      onLine: (line) => {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { return; }
      const parsed = cliEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const value = parsed.data;
      if (typeof value.claude_code_version === 'string' && /^\d+\.\d+\.\d+$/.test(value.claude_code_version)) evidence.cliVersion = value.claude_code_version;
      const serialized = JSON.stringify(value);
      if (mixedContent && (value.type === 'error' || (value.type === 'result' && typeof value.subtype === 'string' && value.subtype.startsWith('error')))) evidence.mixedParserErrorObserved = true;
      evidence.observedEnabledStatusText ||= serialized.includes('Auto mode server: Enabled');
      evidence.observedEscalationText ||= /manual approval|human approval|switched to.*(?:manual|default)/i.test(serialized);
      const message = value.message;
      if (Array.isArray(message?.content)) for (const block of message.content) {
        if (block.type === 'tool_use') {
          const input = block.input;
          evidence.observedProbeOnlyToolPayloads &&= block.name === 'Bash' && input?.command === PROBE;
          if (block.name === 'Bash' && input?.command === PROBE) evidence.observedAssistantProbeCalls++;
          else stopOwned();
        }
        if (block.type === 'tool_result') {
          evidence.observedProbeResults++;
          if (block.is_error) evidence.observedDeniedProbeResults++;
          else evidence.observedSuccessfulProbeResults++;
        }
      }
      if (value.type === 'result') {
        evidence.completedTurns++;
        if (prompts[nextPrompt - 1]?.kind === 'denial') evidence.completedDenialTurns++; else evidence.completedNormalTurns++;
        if (value.is_error === true) evidence.resultErrors++;
        sendNext();
      }
      },
    });
    runTimer = setTimeout(() => { evidence.timedOut = true; stopOwned(); }, RUN_TIMEOUT_MS);
    try { sendNext(); await lifecycle.completion; }
    finally { lifecycle.dispose(); owned.stderr.removeListener('data', observeParserDiagnostic); }
    }
    await proxy.flushAudit();
    await Promise.all([...pendingMixedCaptures]);
    if (mixedContent) {
      evidence.mixedReplay = observeMixedContentReplay(delivery, requests, scenes.mixedProbes, mixedDeliveries);
      evidence.mixedReplayDiagnostics = describeMixedContentReplay(delivery, requests, scenes.mixedProbes, mixedDeliveries);
    }
    evidence.observedRequestCount = requests.length;
    evidence.observedClassifierRequests = decision.requests.filter((r) => r.path.endsWith('/messages')).length;
    evidence.observedDecisionProviderRequests = decision.requests.filter((r) => !r.path.endsWith('/messages')).length;
    evidence.observedDecisionDeniedProbeRequests = decision.requests.filter((r) => !r.path.endsWith('/messages') && JSON.stringify(r.body.state ?? '').includes(PROBE)).length;
    evidence.observedDenialReturnedToModel = observedDenialReturnedToModel(requests);
    let auditRecords: readonly unknown[] = [];
    try {
      const records = (await readFile(join(workdir, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      auditRecords = records;
      evidence.observedNativeAuditBlocks = records.filter((r) => r.delivery === 'safeguard' && r.verdict === 'block').length;
      evidence.observedRewriteAuditBlocks = records.filter((r) => r.delivery === 'rewrite' && r.verdict === 'block').length;
    } catch { /* Missing audit evidence is zero observations, not success. */ }
    if (versionOverrideRewrite) evidence.versionOverrideRewrite = observeVersionOverrideRewrite({
      route: config.routes[0]!, probes: scenes.mixedProbes, sources: versionOverrideSources,
      deliveries: mixedDeliveries, auditRecords, strictRewriteReplay: evidence.mixedReplay,
    });
    return evidence;
  } finally {
    clearTimeout(runTimer);
    clearTimeout(turnTimer);
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const owned = child;
      const exited = Promise.withResolvers<void>();
      const force = setTimeout(() => owned.kill('SIGKILL'), 1000);
      owned.once('close', () => { clearTimeout(force); exited.resolve(); });
      owned.kill('SIGTERM');
      await exited.promise;
    }
    for (const listener of listeners.reverse()) await listener.close();
    await flushApp?.();
    await Promise.all([...pendingMixedCaptures]);
  }
}

async function main(): Promise<void> {
let root: string | undefined;
const runs: RunEvidence[] = [];
try {
  const executable = resolve(process.env.AMP_CLAUDE_EXECUTABLE ?? join(process.env.HOME ?? '/root', '.local/bin/claude'));
  await access(executable);
  root = await mkdtemp(join(tmpdir(), 'amp-real-claude-mock-'));
  const interactive = process.argv.includes('--interactive');
  const consecutive = process.argv.includes('--consecutive-probes');
  const versionOverrideRewrite = process.argv.includes('--version-override-rewrite');
  const mixedContent = process.argv.includes('--mixed-content') || versionOverrideRewrite;
  if (versionOverrideRewrite && (interactive || consecutive || process.argv.some((argument) => argument.startsWith('--delivery=')))) {
    throw new Error('Version-override rewrite QA is a separate auto-route print invocation');
  }
  if (mixedContent && (interactive || consecutive)) throw new Error('Mixed-content QA is print-only and separate from consecutive-denial QA');
  if (consecutive && !interactive) throw new Error('Consecutive denial QA is interactive-only');
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive mode requires an inherited PTY');
  const deliveries: ('native' | 'rewrite')[] = versionOverrideRewrite ? ['rewrite']
    : interactive ? [process.argv.includes('--delivery=rewrite') ? 'rewrite' : 'native'] : ['native', 'rewrite'];
  for (const delivery of deliveries) runs.push(await runCli(delivery, executable, root, interactive, consecutive, mixedContent, versionOverrideRewrite));
  console.log(JSON.stringify({ schema: 'amp.claude-loopback-qa.v1', evidenceKind: 'actual-installed-cli-with-loopback-mocks', runs,
    acceptance: {
      native: 'inspect observations; client safeguards opt-in is required, never inferred from CLI success',
      denial: 'an assistant tool_use is not execution; inspect tool_result is_error and returned model request',
      status: 'print mode cannot establish /status; inherited interactive UI requires parent-recorded exact status text',
      escalation: 'print mode cannot establish interactive escalation; observe and record the real inherited terminal separately',
      automaticFallback: 'pending: classifier presence alone does not prove scoped native-following fallback',
      realProvider: 'blocked: no trusted provider credentials configured', realPromptCache: 'pending: mock cache tokens are always zero',
      desktop: 'pending: no GUI exercised', realRelayBetaThinkingCompatibility: 'pending: loopback mocks cannot establish real upstream acceptance',
    } }));
  if (runs.some((run) => run.timedOut || run.outputBoundHit || run.cliExitCode !== 0
    || (run.interactionMode === 'print' && (run.completedNormalTurns < 5 || run.completedDenialTurns < 3))
    || run.sceneCounters.probeScenes < 3 || run.resultErrors > 0 || !run.observedProbeOnlyToolPayloads
    || run.observedSuccessfulProbeResults > 0 || run.observedDecisionDeniedProbeRequests === 0
    || (run.sceneCounters.consecutiveProbeBudget === 3 && run.sceneCounters.correlatedProbeDenials < 3)
    || (run.mixedContent && (!run.mixedReplay?.passed || run.mixedParserErrorObserved))
    || (versionOverrideRewrite && !run.versionOverrideRewrite?.passed)
    || (run.delivery === 'native' ? run.observedNativeAuditBlocks === 0 : run.observedRewriteAuditBlocks === 0))) process.exitCode = 1;
} catch {
  // Never serialize raw child output, request bodies, auth or exception strings.
  console.log(JSON.stringify({ schema: 'amp.claude-loopback-qa.v1', status: 'unavailable-or-failed', runs, reason: 'See sanitized counters; no live acceptance claimed.' }));
  process.exitCode = 1;
} finally {
  if (root) await rm(root, { recursive: true, force: true });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
