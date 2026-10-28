import type { Config } from '../config/schema.js';
import { createAuditLogger } from '../audit/logger.js';
import { collectConfigSecrets, type AuditSink } from '../audit/record.js';
import { createDecisionProvider, decideChain } from '../decision/chain.js';
import type { Answers, DecisionProvider } from '../decision/types.js';
import { resolvePolicy, type EffectivePolicy } from '../policy/effective.js';
import { hardDeny } from '../policy/hard-deny.js';
import { isReadonlyCommand } from '../policy/readonly-allowlist.js';
import { redact } from '../policy/redact.js';
import { sensitivePaths } from '../policy/sensitive-paths.js';
import { buildState } from '../policy/state-builder.js';
import { cacheKey, DecisionCache } from './cache.js';
import type { Action, Gate, GateContext, GateStats, Outcome, Verdict } from './types.js';

export const DECISION_DEADLINE_MS = 60_000;
const risks = ['destructive', 'exfiltration', 'remote_code_exec', 'security_weakening'] as const;

export interface GateOptions {
  providers?: readonly DecisionProvider[];
  audit?: AuditSink;
  now?: () => number;
  policy?: EffectivePolicy;
}

/** The order is significant when configured thresholds overlap. */
export function thresholdOutcome(answers: Answers, policy: EffectivePolicy): Outcome {
  const t = policy.thresholds;
  if (risks.some((id) => answers[id] >= t.risk_block)) return 'block';
  if (answers.matches_user_request <= t.intent_mismatch && risks.some((id) => answers[id] >= t.intent_risk)) return 'block';
  if (risks.every((id) => answers[id] <= t.risk_allow) && answers.outside_scope <= t.outside_scope_allow) return 'allow';
  return 'uncertain';
}

/** Cached decisions must never share mutable arrays/maps with their callers. */
function cloneVerdict(verdict: Verdict): Verdict {
  const cloned = { ...verdict, reasons: [...verdict.reasons] };
  if (verdict.probabilities) cloned.probabilities = { ...verdict.probabilities };
  return cloned;
}

export function createGate(config: Config, options: GateOptions = {}): Gate {
  const policy = options.policy ?? resolvePolicy(config.policy);
  const secrets = collectConfigSecrets(config);
  const now = options.now ?? Date.now;
  const cache = new DecisionCache<Verdict>(undefined, undefined, now);
  const logger = options.audit ? undefined : createAuditLogger(config, { policy });
  const audit: AuditSink = options.audit ?? ((input) => logger!.append(input));
  const pendingAudit = new Set<Promise<void>>();
  const stats: GateStats = { decisions: 0, allow: 0, block: 0, uncertain: 0, cache_hits: 0, provider_failures: 0, provider_health: {} };
  const configuredProviders = options.providers ?? config.decision.chain.map((id): DecisionProvider => {
    const providerConfig = structuredClone(config.decision.providers[id]!);
    const timeoutMs = config.gate.provider_timeout_ms;
    let adapter: DecisionProvider | undefined;
    return {
      id,
      decide(state, questions, callOptions) {
        // Unsupported adapters fail only when reached, never before hard rules
        // or a successful earlier provider. No synthetic answers are produced.
        adapter ??= createDecisionProvider(id, providerConfig, timeoutMs);
        return adapter.decide(state, questions, callOptions);
      },
    };
  });
  const providers = configuredProviders.map((provider): DecisionProvider => {
    const health = stats.provider_health[provider.id] ??= { successes: 0, failures: 0 };
    return {
      id: provider.id,
      async decide(state, questions, callOptions) {
        try {
          const result = await provider.decide(state, questions, callOptions);
          // Test doubles and future adapters must satisfy the same six-score contract.
          if (!Object.keys(policy.questions).every((id) => {
            const value = result.answers[id as keyof Answers];
            return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
          })) throw new Error('Invalid decision probabilities');
          health.successes += 1;
          return result;
        } catch (error) {
          health.failures += 1;
          stats.provider_failures += 1;
          throw error;
        }
      },
    };
  });
  // Identity contains no raw credentials; config instances never share their cache.
  const identity = {
    policy,
    decision: redact(config.decision, secrets, policy),
    gate: { ...config.gate },
    chain: providers.map(({ id }) => id),
  };
  const mode = config.gate.mode;
  const failureAction = config.gate.on_provider_failure;

  async function decide(action: Action, context: GateContext): Promise<Verdict> {
    const started = now();
    const controller = new AbortController();
    const callerAbort = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) callerAbort();
    else context.signal?.addEventListener('abort', callerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Decision deadline exceeded')); }, DECISION_DEADLINE_MS);
    timer.unref?.();
    let verdict: Verdict;
    const base = (outcome: Outcome, rule: string, reasons = [rule]): Verdict => ({ outcome, reasons, rule, latency_ms: 0, cost_usd: 0, policy_version: policy.version });
    try {
      if (context.signal?.aborted) verdict = base('block', 'caller-aborted');
      else {
        const structural = action.execution_unavailable ? 'execution-unavailable'
          : action.content_truncated || (action.kind === 'file_write' && Buffer.byteLength(action.content_excerpt ?? '', 'utf8') > policy.write_content_max_bytes) ? 'content-truncated' : undefined;
        const denied = structural ?? hardDeny(action, policy, context);
        if (denied) verdict = base('block', denied);
        else {
          const sensitive = sensitivePaths(action, context, policy);
          const exempt = !sensitive.review && (action.kind === 'other' || action.recognized_exemption !== undefined || isReadonlyCommand(action, policy, context));
          if (exempt) verdict = base('allow', action.kind === 'other' ? 'generic-other' : 'readonly');
          else {
            // Literal credentials are removed before state truncation, not afterwards.
            const stateContext: Omit<GateContext, 'signal'> = Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'signal'));
            const state = buildState(redact({ ...action, raw: undefined }, secrets, policy), redact(stateContext, secrets, policy), policy);
            const source = Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'raw'));
            const key = cacheKey({ identity, state, action_digest: cacheKey(source), content_digest: action.content_digest,
              path_context: cacheKey({ home_dir: context.home_dir, userprofile: context.userprofile }) });
            const hit = cache.get(key);
            if (hit) { verdict = { ...cloneVerdict(hit), cache_hit: true, cost_usd: 0, input_tokens: 0, output_tokens: 0 }; stats.cache_hits += 1; }
            else {
              const { promise: aborted, reject } = Promise.withResolvers<never>();
              if (controller.signal.aborted) reject(new Error('Decision aborted'));
              else controller.signal.addEventListener('abort', () => reject(new Error('Decision aborted')), { once: true });
              const result = await Promise.race([
                decideChain(providers, state, policy.questions, { signal: controller.signal, deadline_ms: Date.now() + DECISION_DEADLINE_MS }),
                aborted,
              ]);
              if (controller.signal.aborted) throw new Error('Decision aborted');
              const rawOutcome = thresholdOutcome(result.answers, policy);
              verdict = {
                ...base(rawOutcome === 'uncertain' ? 'block' : rawOutcome, rawOutcome === 'uncertain' ? 'gray-block' : 'model-threshold'),
                raw_outcome: rawOutcome, probabilities: { ...result.answers }, provider: result.provider,
                cost_usd: result.cost_usd,
                ...(result.usage.input_tokens !== undefined ? { input_tokens: result.usage.input_tokens } : {}),
                ...(result.usage.output_tokens !== undefined ? { output_tokens: result.usage.output_tokens } : {}),
              };
              cache.set(key, cloneVerdict(verdict));
            }
          }
        }
      }
    } catch {
      // Caller cancellation is not provider failure and can never fail open.
      verdict = context.signal?.aborted ? base('block', 'caller-aborted')
        : base(failureAction, timedOut ? 'decision-timeout' : 'provider-unavailable');
      verdict.cost_usd = null;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', callerAbort);
    }
    verdict.latency_ms = Math.max(0, now() - started);
    stats.decisions += 1;
    stats[verdict.outcome] += 1;
    if (verdict.raw_outcome === 'uncertain' && verdict.outcome !== 'uncertain') stats.uncertain += 1;
    // Shadow changes delivery, never the hypothetical verdict or cache namespace.
    try {
      const work = Promise.resolve(audit({ action, ...context, verdict, delivery: mode === 'shadow' ? 'shadow' : context.delivery })).then(() => {}, () => {});
      pendingAudit.add(work);
      void work.then(() => pendingAudit.delete(work));
    } catch { /* Audit failure must not change the security verdict. */ }
    return verdict;
  }
  return {
    decide,
    stats: () => ({ ...stats, provider_health: Object.fromEntries(Object.entries(stats.provider_health).map(([id, value]) => [id, { ...value }])) }),
    async flushAudit() { await Promise.all([...pendingAudit]); await logger?.flush(); },
  };
}
