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
  cliVersion: string | null;
  observedSourceModelRequests: { stream: boolean; safeguards: boolean; sessionHeader: boolean; versionHeader: boolean; dangerousBeta: boolean; toolResult: boolean; bashDeclared: boolean }[];
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
export function createCliProbeSceneController(options: { consecutiveProbeBudget?: 1 | 3 } = {}) {
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
  return {
    counters,
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
          return { content: [{ type: 'tool_use', id: lastIssuedId, name: 'Bash', input: { command: PROBE } }] };
        }
        counters.missingDeclaredBash++;
      }
      counters.textScenes++;
      return { content: [{ type: 'text', text: issuedThisTurn > 0 ? 'Mock acknowledges the harmless probe outcome. No further tool is needed.' : 'AMP_NORMAL_TURN_OK' }] };
    },
  };
}

async function runCli(delivery: 'native' | 'rewrite', executable: string, root: string, interactive = false, consecutive = false): Promise<RunEvidence> {
  const workdir = join(root, delivery);
  await mkdir(workdir, { recursive: true });
  const home = join(workdir, 'home'); await mkdir(home);
  const settings = join(workdir, 'settings.json');
  const mcp = join(workdir, 'mcp.json');
  await writeFile(settings, JSON.stringify({ hooks: {}, disableAllHooks: true, enableAllProjectMcpServers: false, permissions: { defaultMode: 'auto' } }));
  await writeFile(mcp, JSON.stringify({ mcpServers: {} }));
  const requests: RecordedRequest[] = [];
  const scenes = createCliProbeSceneController({ consecutiveProbeBudget: consecutive ? 3 : 1 });
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
    delivery, interactionMode: interactive ? 'interactive' : 'print', sceneCounters: scenes.counters,
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
      routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock', claude_delivery: delivery, project_dirs: [workdir] }],
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
      if (context.req.method === 'POST' && context.req.path.endsWith('/messages')) {
        if (evidence.observedSourceModelRequests.length >= 128) return context.json({ error: 'manual QA request bound' }, 429);
        const body: unknown = await context.req.raw.clone().json();
        const parsed = z.record(z.string(), z.unknown()).safeParse(body);
        if (!parsed.success) return context.json({ error: 'manual QA invalid request' }, 400);
        const request: RecordedRequest = { method: context.req.method, path: context.req.path, headers: context.req.raw.headers, body: parsed.data };
        const optIn = Object.hasOwn(request.body, 'safeguards');
        evidence.observedSafeguardsRequests += Number(optIn);
        evidence.observedSourceModelRequests.push({
          stream: request.body.stream === true, safeguards: optIn,
          sessionHeader: request.headers.has('x-session-id') || request.headers.has('x-claude-code-session-id'),
          versionHeader: /claude-(?:cli|code)\/\d+\.\d+\.\d+/.test(request.headers.get('user-agent') ?? ''),
          dangerousBeta: request.headers.get('anthropic-beta')?.includes('dangerous-tool-use-2026-09-03') ?? false,
          toolResult: hasToolResults(request),
          bashDeclared: Array.isArray(request.body.tools) && request.body.tools.some((tool: unknown) => tool !== null
            && typeof tool === 'object' && 'name' in tool && tool.name === 'Bash'),
        });
      }
      return proxy.fetch(context.req.raw);
    });
    const gateway = await startLoopback(ingress); listeners.push(gateway);
    const session = randomUUID();
    const prompts = [
      ...Array.from({ length: 3 }, (_, i) => `Safe denial observation ${i + 1}: request the Bash tool with exactly printf AMP_DENIAL_PROBE once. If denied, acknowledge and do not retry or use any other tool.`),
      ...Array.from({ length: 5 }, (_, i) => `Normal conversation turn ${i + 1}: reply with AMP_NORMAL_TURN_OK. Do not call any tool.`),
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
    const sendNext = () => {
      clearTimeout(turnTimer);
      if (nextPrompt >= prompts.length) { owned.stdin.end(); return; }
      scenes.beginTurn(nextPrompt < 3 ? 'denial' : 'normal');
      owned.stdin.write(`${JSON.stringify({ type: 'user', session_id: session, parent_tool_use_id: null, message: { role: 'user', content: prompts[nextPrompt++] } })}\n`);
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
        if (nextPrompt <= 3) evidence.completedDenialTurns++; else evidence.completedNormalTurns++;
        if (value.is_error === true) evidence.resultErrors++;
        sendNext();
      }
      },
    });
    runTimer = setTimeout(() => { evidence.timedOut = true; stopOwned(); }, RUN_TIMEOUT_MS);
    try { sendNext(); await lifecycle.completion; } finally { lifecycle.dispose(); }
    }
    await proxy.flushAudit();
    evidence.observedRequestCount = requests.length;
    evidence.observedClassifierRequests = decision.requests.filter((r) => r.path.endsWith('/messages')).length;
    evidence.observedDecisionProviderRequests = decision.requests.filter((r) => !r.path.endsWith('/messages')).length;
    evidence.observedDecisionDeniedProbeRequests = decision.requests.filter((r) => !r.path.endsWith('/messages') && JSON.stringify(r.body.state ?? '').includes(PROBE)).length;
    evidence.observedDenialReturnedToModel = observedDenialReturnedToModel(requests);
    try {
      const records = (await readFile(join(workdir, 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      evidence.observedNativeAuditBlocks = records.filter((r) => r.delivery === 'safeguard' && r.verdict === 'block').length;
      evidence.observedRewriteAuditBlocks = records.filter((r) => r.delivery === 'rewrite' && r.verdict === 'block').length;
    } catch { /* Missing audit evidence is zero observations, not success. */ }
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
  if (consecutive && !interactive) throw new Error('Consecutive denial QA is interactive-only');
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive mode requires an inherited PTY');
  const deliveries: ('native' | 'rewrite')[] = interactive ? [process.argv.includes('--delivery=rewrite') ? 'rewrite' : 'native'] : ['native', 'rewrite'];
  for (const delivery of deliveries) runs.push(await runCli(delivery, executable, root, interactive, consecutive));
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
