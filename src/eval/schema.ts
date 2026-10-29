import { z } from 'zod';
import { configSchema } from '../config/schema.js';

const text = z.string().trim().min(1);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
export const categories = ['readonly', 'build/test', 'project modification', 'system changes', 'destructive', 'exfiltration', 'download-execute', 'weaken security', 'outside-project writes', 'adversarial'] as const;
export const sourceSchema = z.strictObject({
  kind: z.enum(['authored', 'adapted']), reference: text, license: z.literal('MIT'),
  url: z.url().refine((value) => value.startsWith('https://')).optional(),
}).refine((source) => source.kind !== 'adapted' || source.url !== undefined);
export const caseSchema = z.strictObject({
  id, protocol: z.enum(['anthropic-messages', 'openai-responses', 'openai-chat']),
  tool_call: z.strictObject({ id, name: text, input: z.record(z.string(), z.json()) }),
  label: z.enum(['allow', 'block']), category: z.enum(categories), source: sourceSchema,
  notes: text, user_request: text,
  context: z.strictObject({ platform: text, project_dir: text, trusted_directories: z.array(text).min(1), workdir: text.optional(), home_dir: text.optional(), userprofile: text.optional() }),
  route: configSchema.shape.routes.element.pick({ tool_map: true, project_dirs: true }).optional(),
});
export type EvalCase = z.infer<typeof caseSchema>;
export const templatesSchema = z.strictObject({
  version: z.literal(1), source: sourceSchema,
  templates: z.array(z.strictObject({ id: z.enum(['clean', 'direct-override', 'owner-approved']), tool_input_prefix: z.string(), user_request_prefix: z.string() })).length(3),
}).refine(({ templates }) => new Set(templates.map((entry) => entry.id)).size === 3
  && templates.some((entry) => entry.id === 'clean' && entry.tool_input_prefix === '' && entry.user_request_prefix === '')
  && templates.every((entry) => entry.id === 'clean' || (entry.tool_input_prefix.trim().length > 0 && entry.user_request_prefix.trim().length > 0
    && entry.tool_input_prefix.endsWith('\n') && entry.tool_input_prefix.split(/\r?\n/).every((line) => !line.trim() || line.trimStart().startsWith('#')))));
export type InjectionTemplates = z.infer<typeof templatesSchema>;

export class EvalInputError extends Error {}

/** Diagnostics deliberately exclude input values, keys, paths, and parser messages. */
export function parseCorpus(text: string): EvalCase[] {
  const rows: EvalCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let input: unknown;
    try { input = JSON.parse(line) as unknown; } catch { throw new EvalInputError(`Corpus line ${index + 1}: invalid JSON`); }
    const parsed = caseSchema.safeParse(input);
    if (!parsed.success) throw new EvalInputError(`Corpus line ${index + 1}: invalid required fields, label, category, context or MIT provenance`);
    if (ids.has(parsed.data.id)) throw new EvalInputError(`Corpus line ${index + 1}: duplicate case ID`);
    ids.add(parsed.data.id);
    rows.push(parsed.data);
  }
  validateCorpus(rows);
  return rows;
}
export function validateCorpus(rows: readonly EvalCase[]): void {
  if (rows.length < 150) throw new EvalInputError('Corpus requires at least 150 cases');
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new EvalInputError('Corpus requires unique case IDs');
  for (const category of categories) if (rows.filter((row) => row.category === category).length < 10) throw new EvalInputError(`Corpus category ${category} requires at least 10 cases`);
  for (const label of ['allow', 'block']) if (!rows.some((row) => row.label === label)) throw new EvalInputError(`Corpus requires a nonempty ${label} label group`);
}

const outcome = z.enum(['allow', 'block', 'uncertain']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().nonnegative().nullable();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const stageSchema = z.strictObject({
  stage: z.enum(['decision', 'review']), provider: z.string().nullable(), latency_ms: amount,
  input_tokens: count.nullable(), output_tokens: count.nullable(), cost_usd: amount,
  final_response: z.strictObject({ input_tokens: count.nullable(), output_tokens: count.nullable(), cost_usd: amount }).optional(),
});
export const resultSchema = z.strictObject({
  id, base_id: id, variant: z.enum(['baseline', 'clean', 'direct-override', 'owner-approved']),
  label: z.enum(['allow', 'block']), category: z.enum(categories), source_fingerprint: digest, input_fingerprint: digest,
  raw_outcome: outcome, effective_outcome: z.enum(['allow', 'block']), rule: z.string(),
  latency_ms: z.number().nonnegative(), cost_usd: amount, input_tokens: count.nullable(), output_tokens: count.nullable(),
  stages: z.array(stageSchema), error: z.boolean(),
});
export type EvalResult = z.infer<typeof resultSchema>;
const groupSchema = z.strictObject({ total: count, effective_block: count, raw_uncertain: count, block_rate: z.number().min(0).max(1).nullable(), gray_rate: z.number().min(0).max(1).nullable() });
export const metricsSchema = z.strictObject({
  total: count, by_label: z.strictObject({ allow: groupSchema, block: groupSchema }),
  by_category: z.record(z.string(), z.strictObject({ total: count, by_label: z.strictObject({ allow: groupSchema, block: groupSchema }) })),
  raw_uncertain: count, gray_rate: z.number().min(0).max(1), dangerous_block_rate: z.number().min(0).max(1), safe_false_block_rate: z.number().min(0).max(1),
  latency_ms: z.strictObject({ p50: z.number().nonnegative(), p95: z.number().nonnegative() }),
  cost: z.strictObject({ known_usd: z.number().nonnegative(), unknown_rows: count, total_usd: amount }),
  usage: z.strictObject({ known_input_tokens: count, known_output_tokens: count, unknown_input_rows: count, unknown_output_rows: count }),
  errors: count, accuracy_passed: z.boolean(),
});
export const fingerprintsSchema = z.strictObject({ corpus: digest, policy: digest, overrides: digest, config: digest, chain: digest, templates: digest, engine: digest });
export type Fingerprints = z.infer<typeof fingerprintsSchema>;
export const selectionSchema = z.strictObject({
  selection: z.string(), kind: z.enum(['rules-only', 'provider', 'chain']), status: z.enum(['complete', 'unavailable']),
  baseline: z.array(resultSchema), injection: z.array(resultSchema), metrics: metricsSchema, suite_metrics: metricsSchema,
  injection_metrics: z.strictObject({ total: count, dangerous_allows: count, flips: count, flip_denominator: count, flip_rate: z.number().min(0).max(1), safety_passed: z.boolean() }),
});
const reasonSchema = z.enum(['invalid-report', 'incomplete-coverage', 'result-errors', 'dangerous-baseline-allow', 'dangerous-wrapped-allow', 'safe-false-block-rate', 'inconsistent-metrics', 'stale-fingerprints', 'incomplete-provider-coverage']);
export type GateReason = z.infer<typeof reasonSchema>;
const reasonsSchema = z.array(reasonSchema).refine((reasons) => reasons.every((reason, index) => index === 0 || reasons[index - 1]! < reason));
const coverageGroupSchema = z.strictObject({ total: count, resolved: count, rate: z.number().min(0).max(1) });
const deterministicCoverageSchema = coverageGroupSchema.extend({ by_label: z.strictObject({ allow: coverageGroupSchema, block: coverageGroupSchema }) });
export const reportSchema = z.strictObject({
  schema_version: z.literal(2), created_at: z.iso.datetime(), mode: z.enum(['rules-only', 'full']),
  fingerprints: fingerprintsSchema, configured_provider_count: count, configured_chain_count: count,
  selections: z.array(selectionSchema).min(1), live_acceptance: z.literal('unverified'),
  selected_gate: z.enum(['offline-safety', 'full-accuracy']),
  gates: z.strictObject({
    offline_safety: z.strictObject({ status: z.enum(['passed', 'failed', 'not_applicable']), reasons: reasonsSchema }),
    accuracy: z.strictObject({ status: z.enum(['passed', 'failed']), reasons: reasonsSchema }),
  }),
  release_coverage: z.strictObject({ status: z.enum(['complete', 'incomplete']), reasons: reasonsSchema }),
  deterministic_coverage: deterministicCoverageSchema.nullable(),
});
export type EvalReport = z.infer<typeof reportSchema>;
export const receiptSchema = z.strictObject({ report_sha256: digest, config_fingerprint: digest, engine_fingerprint: digest, trusted_provider_run: z.literal(true) });
export type TrustedRunReceipt = z.infer<typeof receiptSchema>;
