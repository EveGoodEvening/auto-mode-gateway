import type { Config } from '../config/schema.js';
import type { EffectivePolicy, QuestionId } from '../policy/effective.js';
import type { DecisionState } from '../policy/state-builder.js';

export type { DecisionState, QuestionId };
export type Questions = EffectivePolicy['questions'];
export type Answers = Record<QuestionId, number>;
export type ProviderConfig = Config['decision']['providers'][string];
export interface DecisionOptions { signal?: AbortSignal; /** Absolute wall-clock deadline. */ deadline_ms?: number }
export interface DecisionUsage { input_tokens?: number; output_tokens?: number }
export interface DecisionResult {
  answers: Answers;
  provider: string;
  model: string;
  latency_ms: number;
  usage: DecisionUsage;
  /** null means at least one billable component is unknown, not free. */
  cost_usd: number | null;
}
export interface DecisionProvider {
  readonly id: string;
  decide(state: DecisionState, questions: Questions, options?: DecisionOptions): Promise<DecisionResult>;
}
export type DecisionErrorCode = 'unsupported_kind' | 'configuration' | 'timeout' | 'aborted' | 'http' | 'transport' | 'invalid_response' | 'exhausted';
/** Never include response bodies, URLs, headers, credentials or raw transport errors. */
export class DecisionError extends Error {
  constructor(readonly code: DecisionErrorCode, message: string = `Decision provider failed (${code})`) {
    super(message);
    this.name = 'DecisionError';
  }
}
