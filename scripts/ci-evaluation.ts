import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig } from '../src/config/load.js';
import { engineFingerprint, runEvaluation } from '../src/eval/runner.js';
import { parseCorpus, templatesSchema, type EvalReport } from '../src/eval/schema.js';

export function evaluationSummaries(report: EvalReport) {
  return {
    safety: { selected_gate: report.selected_gate, offline_safety: report.gates.offline_safety, release_coverage: report.release_coverage },
    accuracy: { accuracy: report.gates.accuracy, release_coverage: report.release_coverage,
      deterministic_coverage: report.deterministic_coverage,
      selections: report.selections.map(({ selection, status, metrics, suite_metrics, injection_metrics }) => ({ selection, status, metrics, suite_metrics, injection_metrics })) },
  };
}

async function main() {
  const mode = process.argv[2];
  const directory = process.argv[3];
  if ((mode !== 'offline' && mode !== 'full') || !directory || process.argv.length !== 4) throw new Error();
  // No implicit home config or ambient environment interpolation in either mode.
  const config = mode === 'full' ? parseConfig(process.env.EVAL_CONFIG_YAML ?? '', {}) : undefined;
  if (mode === 'full' && !process.env.EVAL_CONFIG_YAML) throw new Error();
  const rows = parseCorpus(await readFile('eval/cases.jsonl', 'utf8'));
  const templates = templatesSchema.parse(JSON.parse(await readFile('eval/injection-templates.json', 'utf8')) as unknown);
  const report = await runEvaluation({ rows, templates, rulesOnly: mode === 'offline', ...(config ? { config } : {}), engine: await engineFingerprint() });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const summaries = evaluationSummaries(report);
  for (const [name, data] of Object.entries({ report, 'offline-safety': summaries.safety, 'numerical-accuracy-raw-gray': summaries.accuracy })) {
    await writeFile(resolve(directory, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(`eval: offline_safety=${report.gates.offline_safety.status} numerical_accuracy=${report.gates.accuracy.status} release_coverage=${report.release_coverage.status}; separate artifacts archived; no trusted-run receipt issued\n`);
  if ((mode === 'offline' ? report.gates.offline_safety.status : report.gates.accuracy.status) !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch {
    process.stderr.write('eval: CI evaluation or exclusive archival failed (details withheld)\n');
    process.exitCode = 1;
  }
}
