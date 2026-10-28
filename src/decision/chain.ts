import type { Config } from '../config/schema.js';
import { decisionDeadline, withinDeadline } from './http.js';
import { SystemOneProvider } from './systemone.js';
import { OpenAIDecisionsProvider } from './openai-decisions.js';
import { DecisionError, type DecisionOptions, type DecisionProvider, type DecisionResult, type DecisionState, type ProviderConfig, type Questions } from './types.js';

export function createDecisionProvider(id: string, config: ProviderConfig, timeoutMs: number): DecisionProvider {
  return config.kind === 'openai-decisions'
    ? new OpenAIDecisionsProvider(id, config, timeoutMs)
    : new SystemOneProvider(id, config, timeoutMs);
}

export async function decideChain(providers: readonly DecisionProvider[], state: DecisionState, questions: Questions, options: DecisionOptions = {}): Promise<DecisionResult> {
  const deadline = decisionDeadline(options);
  const started = Date.now();
  let failedAttempt = false;
  const accounting = options.accounting ?? { attempts: 0 };
  const initialAttempts = accounting.attempts;
  for (const provider of providers) {
    if (options.signal?.aborted) throw new DecisionError('aborted');
    if (Date.now() >= deadline) throw new DecisionError('timeout');
    try {
      const result = await withinDeadline((signal) => provider.decide(state, questions, { ...options, signal, deadline_ms: deadline, accounting }), deadline, options.signal);
      return { ...result, latency_ms: Date.now() - started,
        ...(failedAttempt || accounting.attempts - initialAttempts > 1 ? { accounting_complete: false as const } : {}) };
    } catch {
      failedAttempt = true;
      if (options.signal?.aborted) throw new DecisionError('aborted');
      if (Date.now() >= deadline) throw new DecisionError('timeout');
      // No provider text/errors are retained in the public failure path.
    }
  }
  throw new DecisionError('exhausted');
}

export function createDecisionChain(decision: Config['decision'], timeoutMs: number): DecisionProvider {
  const providers = decision.chain.map((id): DecisionProvider => {
    let provider: DecisionProvider | undefined;
    return {
      id,
      async decide(state, questions, options) {
        const config = decision.providers[id];
        if (!config) throw new DecisionError('configuration', 'Decision chain references an unknown provider');
        // Dispatch is lazy; only actual successful construction is memoized.
        // Configuration failures affect this attempt, not earlier providers or hard rules.
        provider ??= createDecisionProvider(id, config, timeoutMs);
        return provider.decide(state, questions, options);
      },
    };
  });
  return {
    id: decision.chain.join(' -> '),
    decide: (state, questions, options) => decideChain(providers, state, questions, options),
  };
}
