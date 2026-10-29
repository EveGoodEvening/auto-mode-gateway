import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'amp-package-assets-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function run(args: string[]) {
  const child = spawn(process.execPath, ['--import', tsx, '--import', 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("offline network forbidden")}', cli, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
  return await promise;
}

describe('evaluation assets independent of the caller working directory', () => {
  it('validates the real default corpus without caller checkout files or configuration', async () => {
    const result = await run(['eval', '--validate']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('validated 150 cases');
    expect(result.stderr).toBe('');
    expect(await readdir(directory)).toEqual([]);
  });

  it('runs the real offline gate and archives a complete honest report outside the checkout', async () => {
    const result = await run(['eval', '--rules-only']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const reports = await readdir(join(directory, 'eval/reports'));
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(join(directory, 'eval/reports', reports[0]!), 'utf8')) as {
      mode: string; selected_gate: string; gates: { offline_safety: { status: string } };
      release_coverage: { status: string };
    };
    expect(report.mode).toBe('rules-only');
    expect(report.selected_gate).toBe('offline-safety');
    expect(report.gates.offline_safety.status).toBe('passed');
    expect(report.release_coverage.status).toBe('incomplete');
    expect(result.stdout).toContain('live_acceptance=unverified');
  }, 25_000);

  it('honors an explicit corpus path rather than silently falling back to bundled data', async () => {
    await writeFile(join(directory, 'invalid.jsonl'), '{}\n');
    const result = await run(['eval', '--validate', '--corpus', 'invalid.jsonl']);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('validated');
    expect(result.stderr).toContain('eval:');
  });
});
