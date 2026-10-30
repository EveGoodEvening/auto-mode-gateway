import type { Config } from '../config/schema.js';
import { createAuditLogger } from '../audit/logger.js';
import { collectConfigSecrets, type AuditSink, type AuditStage } from '../audit/record.js';
import { createDecisionProvider, decideChain } from '../decision/chain.js';
import type { Answers, DecisionProvider } from '../decision/types.js';
import { LlmReviewProvider, type ReviewProvider } from '../decision/llm-review.js';
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
  reviewer?: ReviewProvider;
  audit?: AuditSink;
  now?: () => number;
  policy?: EffectivePolicy;
}

export interface DeterministicResult {
  outcome: 'allow' | 'block' | 'review';
  rule: string;
  reasons: string[];
}

/** The real pre-provider boundary, shared by enforcement and data-only evaluation. */
export function deterministicOutcome(action: Action, context: GateContext, policy: EffectivePolicy): DeterministicResult {
  const structural = action.execution_unavailable ? 'execution-unavailable'
    : action.content_truncated || (action.kind === 'file_write' && Buffer.byteLength(action.content_excerpt ?? '', 'utf8') > policy.write_content_max_bytes) ? 'content-truncated' : undefined;
  const denied = structural ?? hardDeny(action, policy, context);
  if (denied) return { outcome: 'block', rule: denied, reasons: [denied] };
  const sensitive = sensitivePaths(action, context, policy);
  if (action.recognized_exemption === 'read' || action.recognized_exemption === 'grep') {
    return { outcome: 'review', rule: 'content-read-review', reasons: sensitive.review ? [...sensitive.reasons] : ['content-read-review'] };
  }
  const exempt = !sensitive.review && (action.kind === 'other' || action.recognized_exemption !== undefined || isReadonlyCommand(action, policy, context));
  if (exempt) {
    const rule = action.kind === 'other' ? 'generic-other' : 'readonly';
    return { outcome: 'allow', rule, reasons: [rule] };
  }
  return { outcome: 'review', rule: 'review-required', reasons: sensitive.reasons.length ? [...sensitive.reasons] : ['review-required'] };
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
  if (verdict.stages) cloned.stages = verdict.stages.map((stage) => ({ ...stage,
    ...(stage.final_response ? { final_response: { ...stage.final_response } } : {}) }));
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
  let reviewer = options.reviewer;
  const reviewConfig = config.decision.second_stage ? structuredClone(config.decision.second_stage) : undefined;
  const configuredProviders = options.providers ?? config.decision.chain.map((id): DecisionProvider => {
    const providerConfig = structuredClone(config.decision.providers[id]!);
    const timeoutMs = config.gate.provider_timeout_ms;
    let adapter: DecisionProvider | undefined;
    return {
      id,
      decide(state, questions, callOptions) {
        // Construction is lazy so hard rules never require provider availability.
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
    const stages: AuditStage[] = [];
    let firstStage: Pick<Verdict, 'probabilities' | 'provider' | 'raw_outcome'> = {};
    let decisionStarted: number | undefined;
    const base = (outcome: Outcome, rule: string, reasons = [rule]): Verdict => ({ outcome, reasons, rule, latency_ms: 0, cost_usd: 0, policy_version: policy.version });
    try {
      if (context.signal?.aborted) verdict = base('block', 'caller-aborted');
      else {
        const deterministic = deterministicOutcome(action, context, policy);
        if (deterministic.outcome !== 'review') verdict = base(deterministic.outcome, deterministic.rule, deterministic.reasons);
        else {
          // Literal credentials are removed before state truncation, not afterwards.
          const stateContext: Omit<GateContext, 'signal'> = Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'signal'));
          const state = buildState(redact({ ...action, raw: undefined }, secrets, policy), redact(stateContext, secrets, policy), policy);
          // Redaction can expand a complete write beyond the final visibility bound.
          if (state.action.content_truncated) verdict = base('block', 'content-truncated');
          else {
            const source = Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'raw'));
            const key = cacheKey({ identity, state, action_digest: cacheKey(source), content_digest: action.content_digest,
              path_context: cacheKey({ home_dir: context.home_dir, userprofile: context.userprofile }) });
            const hit = cache.get(key);
            if (hit) { verdict = { ...cloneVerdict(hit), cache_hit: true, cost_usd: 0, input_tokens: 0, output_tokens: 0, stages: [] }; stats.cache_hits += 1; }
            else {
              decisionStarted = now();
              const { promise: aborted, reject } = Promise.withResolvers<never>();
              if (controller.signal.aborted) reject(new Error('Decision aborted'));
              else controller.signal.addEventListener('abort', () => reject(new Error('Decision aborted')), { once: true });
              const result = await Promise.race([
                decideChain(providers, state, policy.questions, { signal: controller.signal, deadline_ms: Date.now() + DECISION_DEADLINE_MS }),
                aborted,
              ]);
              if (controller.signal.aborted) throw new Error('Decision aborted');
              const rawOutcome = thresholdOutcome(result.answers, policy);
              let cacheable = true;
              firstStage = { raw_outcome: rawOutcome, probabilities: { ...result.answers }, provider: result.provider };
              const reported = { cost_usd: result.cost_usd, input_tokens: result.usage.input_tokens ?? null, output_tokens: result.usage.output_tokens ?? null };
              stages.push({ stage: 'decision', provider: result.provider, latency_ms: result.latency_ms, ...reported,
                ...(result.accounting_complete === false ? { cost_usd: null, input_tokens: null, output_tokens: null, final_response: reported } : {}) });
              verdict = { ...base(rawOutcome === 'uncertain' ? 'block' : rawOutcome, rawOutcome === 'uncertain' ? 'gray-block' : 'model-threshold'), ...firstStage,
                cost_usd: result.cost_usd,
                ...(result.usage.input_tokens !== undefined ? { input_tokens: result.usage.input_tokens } : {}),
                ...(result.usage.output_tokens !== undefined ? { output_tokens: result.usage.output_tokens } : {}),
              };
              if (rawOutcome === 'uncertain' && (reviewer || reviewConfig)) {
                const reviewStarted = now();
                try {
                  if (!reviewer) {
                    if (!reviewConfig) throw new Error('Reviewer unavailable');
                    reviewer = new LlmReviewProvider(reviewConfig, { credentials: secrets, policy });
                  }
                  const reviewed = await Promise.race([
                    reviewer.review(state, result.answers, { signal: controller.signal, deadline_ms: Date.now() + Math.max(0, DECISION_DEADLINE_MS - (now() - started)) }),
                    aborted,
                  ]);
                  if (controller.signal.aborted) throw new Error('Decision aborted');
                  stages.push({ stage: 'review', provider: reviewed.provider, latency_ms: reviewed.latency_ms,
                    cost_usd: reviewed.cost_usd, input_tokens: reviewed.usage.input_tokens ?? null, output_tokens: reviewed.usage.output_tokens ?? null,
                    ...(reviewed.final_response ? { final_response: { ...reviewed.final_response } } : {}) });
                  verdict.outcome = reviewed.verdict;
                  verdict.rule = reviewed.invalid_response ? 'llm-review-invalid' : 'llm-review';
                  cacheable = !reviewed.invalid_response;
                  // Provider text is never a diagnostic; audit sanitizes the full reason.
                  verdict.reasons = [redact(reviewed.reason, secrets, policy)];
                } catch {
                  stats.provider_failures += 1;
                  stages.push({ stage: 'review', provider: 'second_stage', latency_ms: Math.max(0, now() - reviewStarted),
                    cost_usd: null, input_tokens: null, output_tokens: null });
                  throw new Error('Reviewer unavailable');
                }
              }
              verdict.stages = stages;
              verdict.cost_usd = stages.every((stage) => stage.cost_usd !== null) ? stages.reduce((sum, stage) => sum + stage.cost_usd!, 0) : null;
              if (stages.every((stage) => stage.input_tokens !== null)) verdict.input_tokens = stages.reduce((sum, stage) => sum + stage.input_tokens!, 0);
              else delete verdict.input_tokens;
              if (stages.every((stage) => stage.output_tokens !== null)) verdict.output_tokens = stages.reduce((sum, stage) => sum + stage.output_tokens!, 0);
              else delete verdict.output_tokens;
              if (cacheable) cache.set(key, cloneVerdict(verdict));
            }
          }
        }
      }
    } catch {
      // Caller cancellation is not provider failure and can never fail open.
      verdict = context.signal?.aborted ? base('block', 'caller-aborted')
        : base(failureAction, timedOut ? 'decision-timeout' : 'provider-unavailable');
      verdict.cost_usd = null;
      if (decisionStarted !== undefined && stages.length === 0) stages.push({ stage: 'decision', provider: null,
        latency_ms: Math.max(0, now() - decisionStarted), input_tokens: null, output_tokens: null, cost_usd: null });
      Object.assign(verdict, firstStage, { stages });
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
