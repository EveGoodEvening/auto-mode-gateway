import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorizeRelease, preflightReleaseDirectory, readBoundedFile, verifyReleaseDirectory } from '../../scripts/release-evidence.js';
import { evaluationSummaries } from '../../scripts/ci-evaluation.js';
import { assessReport, calculateMetrics, injectionMetrics } from '../../src/eval/metrics.js';
import { engineFingerprint, fingerprint } from '../../src/eval/runner.js';
import { categories, type EvalReport, type EvalResult, type Fingerprints } from '../../src/eval/schema.js';

// Synthetic numeric/crypto boundary controls: never trusted-provider evidence.
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const current: Fingerprints = Object.fromEntries(['corpus', 'templates', 'policy', 'overrides', 'config', 'chain', 'engine'].map((key) => [key, fingerprint(key)])) as Fingerprints;
const repository = 'EveGoodEvening/auto-mode-gateway';
const commit = 'a'.repeat(40);
const ref = 'refs/tags/v0.1.0';
function reportFixture(): EvalReport {
  function row(id: string, label: 'allow' | 'block', variant: EvalResult['variant']): EvalResult {
    return { id: `${id}.${variant}`, base_id: id, variant, label, category: 'readonly', source_fingerprint: fingerprint('synthetic'), input_fingerprint: fingerprint(id), raw_outcome: label, effective_outcome: label, rule: 'synthetic-boundary', latency_ms: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, stages: [], error: false };
  }
  const baseline = Array.from({ length: 150 }, (_, index) => ({ ...row(`case-${index}`, index % 2 ? 'block' : 'allow', 'baseline'), category: categories[index % categories.length]! }));
  const injection = baseline.filter((entry) => entry.label === 'block').flatMap((entry) => (['clean', 'direct-override', 'owner-approved'] as const).map((variant) => ({ ...entry, id: `${entry.base_id}.${variant}`, variant, input_fingerprint: variant === 'clean' ? entry.input_fingerprint : fingerprint(`${entry.base_id}.${variant}`) })));
  const selection = { status: 'complete' as const, baseline, injection, metrics: calculateMetrics(baseline), suite_metrics: calculateMetrics([...baseline, ...injection]), injection_metrics: injectionMetrics(injection) };
  const measured = { mode: 'full' as const, configured_provider_count: 1, configured_chain_count: 1,
    selections: [{ ...selection, selection: 'provider[1]', kind: 'provider' as const }, { ...selection, selection: 'chain', kind: 'chain' as const }] };
  return { schema_version: 2, created_at: '2026-10-29T00:00:00.000Z', fingerprints: current, live_acceptance: 'unverified', ...measured, ...assessReport(measured) };
}
function signed(report: Buffer = Buffer.from(JSON.stringify(reportFixture())), fingerprints: Fingerprints = current) {
  const envelope = { version: 1, repository, commit, ref, identity: 'source', report_bytes: report.length,
    receipt: { report_sha256: createHash('sha256').update(report).digest('hex'), config_fingerprint: fingerprints.config, engine_fingerprint: fingerprints.engine, trusted_provider_run: true } };
  const authorization = Buffer.from(JSON.stringify(envelope));
  return { report, authorization, signature: sign(null, authorization, keys.privateKey), publicKey, repository, commit, ref, current: fingerprints };
}

describe('independent audit authorization release consumer', () => {
  it('accepts exact independently signed bytes and current complete full coverage', () => {
    const result = authorizeRelease(signed());
    expect(result.gates.accuracy.status).toBe('passed');
    expect(result.release_coverage.status).toBe('complete');
    expect(result.live_acceptance).toBe('unverified');
  });
  it('rejects evaluator-minted trust boolean without the external private key', () => {
    const input = signed();
    expect(() => authorizeRelease({ ...input, signature: Buffer.alloc(64) })).toThrow('signature');
    const other = generateKeyPairSync('ed25519');
    expect(() => authorizeRelease({ ...input, signature: sign(null, input.authorization, other.privateKey) })).toThrow('signature');
  });
  it('binds repository, commit and exact tag independently of passing metrics', () => {
    for (const change of [{ repository: 'attacker/fork' }, { commit: 'b'.repeat(40) }, { ref: 'refs/tags/v0.1.1' }]) {
      expect(() => authorizeRelease({ ...signed(), ...change })).toThrow('target mismatch');
    }
  });
  it('rejects reserialization and byte substitution on either signed boundary', () => {
    const input = signed();
    const authorization = Buffer.from(JSON.stringify(JSON.parse(input.authorization.toString()), null, 2));
    expect(() => authorizeRelease({ ...input, authorization })).toThrow('signature');
    const report = Buffer.from(input.report);
    report[0] = 0x20;
    expect(() => authorizeRelease({ ...input, report })).toThrow('SHA256');
  });
  it('rejects every stale fingerprint even under a genuine authorization signature', () => {
    for (const key of Object.keys(current) as (keyof Fingerprints)[]) {
      expect(() => authorizeRelease({ ...signed(), current: { ...current, [key]: fingerprint('changed') } })).toThrow('stale');
    }
  });
  it('uses the actual current SOURCE engine, never an engine selected from the archive', async () => {
    const sourceCurrent = { ...current, engine: await engineFingerprint() };
    const sourceReport = reportFixture();
    sourceReport.fingerprints = sourceCurrent;
    expect(authorizeRelease(signed(Buffer.from(JSON.stringify(sourceReport)), sourceCurrent)).fingerprints.engine).toBe(sourceCurrent.engine);
    const wrongMode = { ...sourceReport, fingerprints: { ...sourceCurrent, engine: fingerprint('different compiled executable bytes') } };
    const input = signed(Buffer.from(JSON.stringify(wrongMode)), sourceCurrent);
    expect(() => authorizeRelease(input)).toThrow('stale');
    const builtEnvelope = Buffer.from(JSON.stringify({ ...JSON.parse(input.authorization.toString()), identity: 'built' }));
    expect(() => authorizeRelease({ ...input, authorization: builtEnvelope, signature: sign(null, builtEnvelope, keys.privateKey) })).toThrow();
  });
  it('rejects a signed provider subset, failed accuracy and rules-only archive', () => {
    const subset = reportFixture();
    subset.selections = subset.selections.slice(0, 1);
    Object.assign(subset, assessReport(subset));
    expect(() => authorizeRelease(signed(Buffer.from(JSON.stringify(subset))))).toThrow('complete passing');
    const offline = reportFixture();
    offline.mode = 'rules-only';
    offline.configured_provider_count = 0;
    offline.configured_chain_count = 0;
    offline.selections = [{ ...offline.selections[0]!, selection: 'rules-only', kind: 'rules-only' }];
    Object.assign(offline, assessReport(offline));
    expect(() => authorizeRelease(signed(Buffer.from(JSON.stringify(offline))))).toThrow();
    const failed = reportFixture();
    for (const selection of failed.selections) {
      selection.baseline = selection.baseline.map((entry) => entry.label === 'allow' ? { ...entry, raw_outcome: 'block', effective_outcome: 'block' } : entry);
      selection.metrics = calculateMetrics(selection.baseline);
      selection.suite_metrics = calculateMetrics([...selection.baseline, ...selection.injection]);
    }
    Object.assign(failed, assessReport(failed));
    expect(() => authorizeRelease(signed(Buffer.from(JSON.stringify(failed))))).toThrow('complete passing');
  });
  it('rejects PR, fork and unprotected contexts before opening evidence or configuration', async () => {
    const allowed = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_REF_PROTECTED: 'true' };
    for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REPOSITORY: 'attacker/fork' }, { GITHUB_REF_PROTECTED: 'false' }, { GITHUB_REF: 'refs/heads/main' }]) {
      await expect(verifyReleaseDirectory('/not-opened', { ...allowed, ...change })).rejects.toThrow('context');
      await expect(preflightReleaseDirectory('/not-opened', { ...allowed, ...change })).rejects.toThrow('context');
    }
    await expect(verifyReleaseDirectory('/not-opened', allowed)).rejects.toThrow('prerequisites');
    await expect(preflightReleaseDirectory('/not-opened', allowed)).rejects.toThrow('prerequisites');
  });
  it('bounds actual file reads and rejects missing/empty/oversized archives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-boundary-'));
    try {
      const path = join(directory, 'evidence');
      await expect(readBoundedFile(path, 8)).rejects.toThrow();
      await writeFile(path, '');
      await expect(readBoundedFile(path, 8)).rejects.toThrow('bounds');
      await writeFile(path, '123456789');
      await expect(readBoundedFile(path, 8)).rejects.toThrow('bounds');
      await writeFile(path, '12345678');
      expect(await readBoundedFile(path, 8)).toEqual(Buffer.from('12345678'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not hide failed accuracy behind passing offline safety in summary artifacts', () => {
    const report = reportFixture();
    report.gates = { offline_safety: { status: 'passed', reasons: [] }, accuracy: { status: 'failed', reasons: ['safe-false-block-rate'] } };
    report.selections[0]!.metrics.raw_uncertain = 1;
    const summaries = evaluationSummaries(report);
    expect(summaries.safety.offline_safety.status).toBe('passed');
    expect(summaries.accuracy.accuracy.status).toBe('failed');
    expect(summaries.accuracy.selections[0]!.metrics.raw_uncertain).toBe(1);
    expect(summaries.accuracy.release_coverage).toEqual(report.release_coverage);
  });
});
