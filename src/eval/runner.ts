import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectConfigSecrets, sanitizeAuditValue } from '../audit/record.js';
import type { Config } from '../config/schema.js';
import { createGate, deterministicOutcome } from '../gate/decide.js';
import { normalizeToolCall } from '../gate/normalize/index.js';
import type { GateContext, Verdict } from '../gate/types.js';
import { resolvePolicy, type EffectivePolicy } from '../policy/effective.js';
import { redact } from '../policy/redact.js';
import { assessReport, calculateMetrics, injectionMetrics, validateReport } from './metrics.js';
import { caseSchema, fingerprintsSchema, resultSchema, templatesSchema, validateCorpus, type EvalCase, type EvalReport, type EvalResult, type Fingerprints, type InjectionTemplates } from './schema.js';

/** Canonical content identity includes regex source/flags, not empty JSON objects. */
export function fingerprint(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (input instanceof RegExp) return { source: input.source, flags: input.flags };
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, member]) => [key, canonical(member)]));
    return input;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Sources in development; the actual executable bundle in installed builds. */
export async function engineFingerprint(): Promise<string> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sources: [string, string][] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) sources.push([relative, await readFile(join(root, relative), 'utf8')]);
    }
  }
  if (import.meta.url.endsWith('.ts')) {
    for (const directory of ['gate', 'policy', 'decision', 'eval', 'config']) await visit(directory);
    return fingerprint(sources);
  }
  return fingerprint(await readFile(fileURLToPath(import.meta.url), 'utf8'));
}

export interface EvaluationOptions {
  rows: readonly EvalCase[];
  templates: InjectionTemplates;
  rulesOnly: boolean;
  config?: Config;
  policy?: EffectivePolicy;
  rulesConfiguration?: unknown;
  normalizationRoutes?: readonly Config['routes'][number][];
  provider?: string;
  engine: string;
}
export function evaluationFingerprints(options: EvaluationOptions): Fingerprints {
  const policy = options.policy ?? resolvePolicy(options.config?.policy);
  const config = options.config;
  const secrets = config ? collectConfigSecrets(config) : [];
  return {
    corpus: fingerprint(options.rows), templates: fingerprint(options.templates), policy: fingerprint(policy),
    overrides: fingerprint(config?.policy ?? options.rulesConfiguration ?? {}),
    config: fingerprint({ configured: config ? redact(config, secrets, policy) : options.rulesConfiguration ?? { defaults: true }, effective_mode: 'enforce', rules_only: options.rulesOnly }),
    chain: fingerprint(config ? { providers: redact(config.decision.providers, secrets, policy), chain: config.decision.chain, second_stage: redact(config.decision.second_stage ?? null, secrets, policy) } : { unavailable: true }),
    engine: options.engine,
  };
}

/** Only execution-bearing text is prefixed, never labels or provenance metadata. */
export function wrapCase(row: EvalCase, template: InjectionTemplates['templates'][number]): EvalCase {
  const copy = structuredClone(row);
  if (template.id === 'clean') return copy;
  const commandFields = ['command', 'cmd'].filter((key) => typeof copy.tool_call.input[key] === 'string');
  if (commandFields.length !== 1) throw new Error('Dangerous injection case needs one unambiguous string command input');
  const commandField = commandFields[0]!;
  copy.tool_call.input[commandField] = template.tool_input_prefix + String(copy.tool_call.input[commandField]);
  copy.user_request = template.user_request_prefix + row.user_request;
  return copy;
}

export async function runEvaluation(options: EvaluationOptions): Promise<EvalReport> {
  options.rows.forEach((row) => caseSchema.parse(row));
  templatesSchema.parse(options.templates);
  validateCorpus(options.rows);
  if (options.rulesOnly && options.provider) throw new Error('Provider selection is incompatible with rules-only');
  const config = options.config;
  if (!options.rulesOnly && !config) throw new Error('Full evaluation requires a valid provider configuration');
  if (options.provider && (!config || !Object.hasOwn(config.decision.providers, options.provider))) throw new Error('Selected provider is not configured');
  const policy = options.policy ?? resolvePolicy(config?.policy);
  const fingerprints = fingerprintsSchema.parse(evaluationFingerprints(options));
  const selections: EvalReport['selections'] = [];
  const choices: { selection: string; kind: 'rules-only' | 'provider' | 'chain'; chain?: string[] }[] = options.rulesOnly
    ? [{ selection: 'rules-only', kind: 'rules-only' }]
    : options.provider
      ? [{ selection: `provider[${Object.keys(config!.decision.providers).indexOf(options.provider) + 1}]`, kind: 'provider', chain: [options.provider] }]
      : [...Object.keys(config!.decision.providers).map((id, index) => ({ selection: `provider[${index + 1}]`, kind: 'provider' as const, chain: [id] })), { selection: 'chain', kind: 'chain', chain: config!.decision.chain }];
  const credentials = config ? collectConfigSecrets(config) : [];
  for (const choice of choices) {
    const baseline: EvalResult[] = [];
    const injection: EvalResult[] = [];
    async function evaluate(row: EvalCase, variant: EvalResult['variant'], base: EvalCase): Promise<EvalResult> {
      const started = performance.now();
      const context: GateContext = { ...row.context, protocol: row.protocol, lastUserText: row.user_request, delivery: 'rewrite' };
      const route = row.route ?? (options.normalizationRoutes ?? config?.routes)?.find((candidate) => candidate.protocol === row.protocol);
      const action = normalizeToolCall(row.protocol, { ...row.tool_call, raw: row.tool_call.input }, context, route, policy);
      let verdict: Verdict;
      if (options.rulesOnly) {
        const deterministic = deterministicOutcome(action, context, policy);
        verdict = { outcome: deterministic.outcome === 'allow' ? 'allow' : 'block', raw_outcome: deterministic.outcome === 'review' ? 'uncertain' : deterministic.outcome,
          rule: deterministic.rule, reasons: [], latency_ms: performance.now() - started, cost_usd: 0, input_tokens: 0, output_tokens: 0, policy_version: policy.version };
      } else {
        // A fresh real gate per input avoids cache effects masking repeated injection calls.
        const selected = { ...config!, gate: { ...config!.gate, mode: 'enforce' as const }, decision: { ...config!.decision, chain: choice.chain! } };
        const gate = createGate(selected, { policy, audit: () => {} });
        verdict = await gate.decide(action, context);
        await gate.flushAudit();
      }
      const error = ['provider-unavailable', 'decision-timeout', 'caller-aborted', 'llm-review-invalid'].includes(verdict.rule ?? '');
      // Failure may genuinely fail open in full mode; never relabel it as model success.
      const raw = error && !verdict.raw_outcome ? 'uncertain' : verdict.raw_outcome ?? verdict.outcome;
      const projected = {
        id: `${base.id}.${variant}`, base_id: base.id, variant, label: base.label, category: base.category,
        source_fingerprint: fingerprint(base.source), input_fingerprint: fingerprint({ protocol: row.protocol, tool_call: row.tool_call, context, route }),
        raw_outcome: raw, effective_outcome: verdict.outcome === 'allow' ? 'allow' : 'block',
        rule: verdict.rule ?? 'unspecified', latency_ms: Math.max(0, performance.now() - started),
        cost_usd: verdict.cost_usd, input_tokens: verdict.input_tokens ?? null, output_tokens: verdict.output_tokens ?? null,
        stages: verdict.stages ?? [], error,
      };
      // IDs and custom rule/provider IDs can be user-controlled; sanitize all output fields.
      return resultSchema.parse(sanitizeAuditValue(projected, credentials, policy));
    }
    // Serial evaluation bounds concurrency to one with the real gate deadline.
    for (const row of options.rows) baseline.push(await evaluate(row, 'baseline', row));
    for (const row of options.rows.filter((entry) => entry.label === 'block')) {
      for (const template of options.templates.templates) injection.push(await evaluate(wrapCase(row, template), template.id, row));
    }
    const metrics = calculateMetrics(baseline);
    const injection_metrics = injectionMetrics(injection);
    selections.push({ selection: choice.selection, kind: choice.kind, status: [...baseline, ...injection].some((row) => row.error) ? 'unavailable' : 'complete', baseline, injection, metrics, suite_metrics: calculateMetrics([...baseline, ...injection]), injection_metrics });
  }
  const measured = { mode: options.rulesOnly ? 'rules-only' as const : 'full' as const, selections,
    configured_provider_count: config ? Object.keys(config.decision.providers).length : 0, configured_chain_count: config?.decision.chain.length ?? 0 };
  const assessment = assessReport(measured, choices.map((choice) => choice.selection));
  return validateReport({ schema_version: 2, created_at: new Date().toISOString(), fingerprints, ...measured, ...assessment, live_acceptance: 'unverified' }, fingerprints);
}
