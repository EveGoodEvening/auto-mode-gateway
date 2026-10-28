import type { Config } from '../config/schema.js';
import type { Action, Protocol } from '../gate/types.js';
import { DEFAULT_POLICY, type EffectivePolicy } from '../policy/effective.js';
import { redact } from '../policy/redact.js';

export type AuditDelivery = 'safeguard' | 'rewrite' | 'shadow' | 'passthrough';
export interface AuditContext {
  route?: string;
  protocol?: Protocol;
  agent_hint?: string;
  session_id?: string;
  delivery?: AuditDelivery;
}
export interface AuditStage {
  stage: 'decision' | 'review';
  provider: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  /** Reported final response only when complete stage accounting is unavailable. */
  final_response?: { input_tokens: number | null; output_tokens: number | null; cost_usd: number | null };
}
export interface AuditVerdict {
  outcome: 'allow' | 'block' | 'uncertain';
  reasons: readonly string[];
  rule?: string;
  provider?: string;
  probabilities?: Readonly<Record<string, number>>;
  latency_ms: number;
  cost_usd?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  policy_version?: string;
  raw_outcome?: 'allow' | 'block' | 'uncertain';
  cache_hit?: boolean;
  stages?: readonly AuditStage[];
}
export interface AuditInput extends AuditContext {
  action: Action;
  verdict: AuditVerdict;
}
export type AuditSink = (input: AuditInput) => void | Promise<void>;

/** Collect literal credentials without ever including them in a diagnostic. Header
 * values are all treated as secrets, including custom gateway authentication. */
export function collectConfigSecrets(config: Config): readonly string[] {
  const values = [...config.auth.client_tokens];
  if (config.auth.admin_token) values.push(config.auth.admin_token);
  for (const upstream of Object.values(config.upstreams)) {
    if (upstream.api_key) values.push(upstream.api_key);
    values.push(...Object.values(upstream.extra_headers ?? {}));
  }
  for (const provider of Object.values(config.decision.providers)) {
    values.push(provider.api_key, ...Object.values(provider.headers ?? {}));
  }
  const second = config.decision.second_stage;
  if (second) values.push(second.api_key, ...Object.values(second.headers ?? {}));
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
}

/** Shared by append and tail: parsed historical records are not trusted output.
 * Already-truncated excerpts cannot establish full-literal credential safety, so
 * they are omitted at every nesting depth before policy redaction. Full raw
 * content and content identity/block metadata remain available for sanitization.
 * A final literal pass covers property names and custom replacement strings.
 * It operates on data, never JSON punctuation (credentials may contain quotes). */
export function sanitizeAuditValue(value: unknown, credentials: readonly string[] = [], policy: EffectivePolicy = DEFAULT_POLICY): unknown {
  const literals = [...new Set(credentials.filter(Boolean))].sort((a, b) => b.length - a.length);
  function scrub(text: string): string {
    for (const secret of literals) text = text.split(secret).join('[REDACTED:credential]');
    return text;
  }
  let seen = new WeakMap<object, object>();
  function visit(input: unknown): unknown {
    if (typeof input === 'string') return scrub(input);
    if (typeof input === 'function') return undefined;
    if (input === null || typeof input !== 'object') return input;
    const previous = seen.get(input);
    if (previous) return previous;
    const result = Array.isArray(input) ? [] : {};
    seen.set(input, result);
    const truncated = Object.getOwnPropertyDescriptor(input, 'content_truncated');
    const omitExcerpt = truncated && 'value' in truncated && truncated.value === true;
    for (const key of Object.keys(input)) {
      if (omitExcerpt && key === 'content_excerpt') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) continue;
      Object.defineProperty(result, scrub(key), {
        value: visit(descriptor.value), enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }
  const projected = visit(value);
  seen = new WeakMap<object, object>();
  const serialized = JSON.stringify(visit(redact(projected, credentials, policy)));
  if (serialized === undefined) throw new Error('Invalid audit record');
  return JSON.parse(serialized) as unknown;
}

export function createAuditRecord(input: AuditInput, credentials: readonly string[] = [], policy: EffectivePolicy = DEFAULT_POLICY): Record<string, unknown> {
  const verdict = input.verdict;
  return sanitizeAuditValue({
    ts: new Date().toISOString(),
    route: input.route ?? null,
    protocol: input.protocol ?? null,
    agent_hint: input.agent_hint ?? null,
    session_id: input.session_id ?? null,
    tool: input.action.tool,
    // raw (including Codex justification) is audit-only and sanitized here.
    action: input.action,
    rule: verdict.rule ?? null,
    reasons: verdict.reasons,
    provider: verdict.provider ?? null,
    probabilities: verdict.probabilities ?? null,
    verdict: verdict.outcome,
    raw_outcome: verdict.raw_outcome ?? verdict.outcome,
    cache_hit: verdict.cache_hit ?? false,
    delivery: input.delivery ?? null,
    latency_ms: verdict.latency_ms,
    input_tokens: verdict.input_tokens ?? null,
    output_tokens: verdict.output_tokens ?? null,
    cost_usd: verdict.cost_usd ?? null,
    stages: verdict.stages ?? [],
    policy_version: verdict.policy_version ?? policy.version,
  }, credentials, policy) as Record<string, unknown>;
}
