import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { loadConfig } from '../config/load.js';
import { configSchema } from '../config/schema.js';
import { resolvePolicy } from '../policy/effective.js';
import { engineFingerprint, runEvaluation, wrapCase, type EvaluationOptions } from '../eval/runner.js';
import { EvalInputError, parseCorpus, templatesSchema } from '../eval/schema.js';

interface CommandOptions { config?: string; corpus: string; templates: string; reportsDir: string; provider?: string; rulesOnly?: boolean; validate?: boolean }
const rulesConfigurationSchema = z.strictObject({
  policy: configSchema.shape.policy,
  gate: configSchema.shape.gate,
  routes: configSchema.shape.routes.optional(),
});

/** Ignore provider-only secrets entirely when evaluating a deterministic boundary. */
export async function loadRulesConfiguration(path: string) {
  let input: unknown;
  try {
    const document = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    input = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch { throw new Error('Rules configuration: unable to read valid YAML'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Rules configuration: expected an object');
  const source = input as Record<string, unknown>;
  function interpolate(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = process.env[name];
      if (replacement === undefined) throw new Error('Rules configuration: missing selected policy or route environment value');
      return replacement;
    });
    if (Array.isArray(value)) return value.map(interpolate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, interpolate(member)]));
    return value;
  }
  const selected = interpolate({ policy: source.policy, gate: source.gate, ...(source.routes !== undefined ? { routes: source.routes } : {}) });
  const result = rulesConfigurationSchema.safeParse(selected);
  if (!result.success) throw new Error('Rules configuration: invalid policy, gate or normalization routes');
  return result.data;
}

export function registerEvalCommand(program: Command): void {
  program.command('eval')
    .description('Evaluate inert labeled tool-call data against the real gate; never execute corpus actions.')
    .option('--config <path>', 'provider configuration (rules-only reads only policy, gate and routes)')
    .option('--corpus <path>', 'JSONL corpus path', fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../eval/cases.jsonl' : '../eval/assets/cases.jsonl', import.meta.url)))
    .option('--templates <path>', 'injection templates path', fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../eval/injection-templates.json' : '../eval/assets/injection-templates.json', import.meta.url)))
    .option('--reports-dir <path>', 'exclusive timestamped JSON report directory', 'eval/reports')
    .option('--provider <id>', 'evaluate one configured provider (otherwise all providers and full chain)')
    .option('--rules-only', 'offline-safety gate; retain measured accuracy and fail-closed uncertainty; no external calls')
    .option('--validate', 'validate corpus and injection schemas/counts only; no configuration or provider calls')
    .action(async (options: CommandOptions) => {
      // Fixed diagnostics: filesystem, parser, config and provider exceptions may contain secrets.
      let phase = 'corpus read';
      try {
        if (options.provider !== undefined && !options.provider.trim()) { process.stderr.write('eval: --provider requires a nonempty identifier\n'); process.exitCode = 1; return; }
        if (options.config !== undefined && !options.config.trim()) { process.stderr.write('eval: --config requires a nonempty path\n'); process.exitCode = 1; return; }
        if (options.rulesOnly && options.provider !== undefined) { process.stderr.write('eval: --provider cannot be combined with --rules-only\n'); process.exitCode = 1; return; }
        if (options.validate && (options.rulesOnly || options.provider !== undefined)) { process.stderr.write('eval: --validate cannot be combined with an evaluation mode or provider selection\n'); process.exitCode = 1; return; }
        const rows = parseCorpus(await readFile(options.corpus, 'utf8'));
        phase = 'template validation';
        const templates = templatesSchema.safeParse(JSON.parse(await readFile(options.templates, 'utf8')) as unknown);
        if (!templates.success) throw new Error();
        if (options.validate) {
          for (const row of rows.filter((entry) => entry.label === 'block')) for (const template of templates.data.templates) wrapCase(row, template);
          process.stdout.write(`eval: validated ${rows.length} cases, ten categories, both label groups and three injection templates; no provider calls\n`);
          return;
        }
        phase = 'configuration';
        const rules = options.rulesOnly && options.config !== undefined ? await loadRulesConfiguration(options.config) : undefined;
        const config = options.rulesOnly ? undefined : await loadConfig(options.config);
        const evaluation: EvaluationOptions = { rows, templates: templates.data, rulesOnly: options.rulesOnly === true,
          ...(config ? { config } : {}), ...(rules ? { policy: resolvePolicy(rules.policy), rulesConfiguration: rules, normalizationRoutes: rules.routes } : {}),
          ...(options.provider !== undefined ? { provider: options.provider } : {}), engine: await engineFingerprint() };
        phase = 'evaluation';
        const report = await runEvaluation(evaluation);
        phase = 'report write';
        await mkdir(options.reportsDir, { recursive: true, mode: 0o700 });
        const name = `${report.created_at.replace(/[:.]/g, '-')}-${report.mode}-${randomUUID()}.json`;
        await writeFile(join(options.reportsDir, name), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        for (const selection of report.selections) {
          const metrics = selection.metrics;
          process.stdout.write(`eval: ${selection.selection} mode=${report.mode} status=${selection.status} dangerous_block=${metrics.by_label.block.effective_block}/${metrics.by_label.block.total} dangerous_block_rate=${metrics.dangerous_block_rate} safe_false_block=${metrics.by_label.allow.effective_block}/${metrics.by_label.allow.total} safe_false_block_rate=${metrics.safe_false_block_rate} raw_uncertain=${metrics.raw_uncertain}/${metrics.total} raw_gray=${metrics.gray_rate} safe_gray=${metrics.by_label.allow.raw_uncertain}/${metrics.by_label.allow.total} dangerous_gray=${metrics.by_label.block.raw_uncertain}/${metrics.by_label.block.total} wrapped_dangerous_allows=${selection.injection_metrics.dangerous_allows} accuracy=${metrics.accuracy_passed ? 'passed' : 'failed'} injection_safety=${selection.injection_metrics.safety_passed ? 'passed' : 'failed'}\n`);
        }
        process.stdout.write(`eval: selected_gate=${report.selected_gate} offline_safety=${report.gates.offline_safety.status} accuracy=${report.gates.accuracy.status} release_coverage=${report.release_coverage.status} live_acceptance=unverified; exclusive JSON report archived\n`);
        const selectedStatus = report.mode === 'rules-only' ? report.gates.offline_safety.status : report.gates.accuracy.status;
        if (selectedStatus !== 'passed') process.exitCode = 1;
      } catch (error) {
        process.stderr.write(error instanceof EvalInputError ? `eval: ${error.message}\n` : `eval: ${phase} failed; check schema/counts, selected configuration or writable report directory (no action was executed)\n`);
        process.exitCode = 1;
      }
    });
}
