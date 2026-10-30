import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const stepSchema = z.object({ name: z.string().optional(), uses: z.string().optional(), run: z.string().optional(), if: z.string().optional(), env: z.record(z.string(), z.string()).optional(), 'continue-on-error': z.boolean().optional(), with: z.record(z.string(), z.unknown()).optional() }).passthrough();
const jobSchema = z.object({ if: z.string().optional(), needs: z.string().optional(), permissions: z.record(z.string(), z.string()).optional(), env: z.record(z.string(), z.string()).optional(), steps: z.array(stepSchema) }).passthrough();
const workflowSchema = z.object({ on: z.record(z.string(), z.unknown()), permissions: z.record(z.string(), z.string()), jobs: z.record(z.string(), jobSchema) }).passthrough();
async function workflow(name: string) {
  const document = parseDocument(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'), { uniqueKeys: true });
  expect(document.errors).toEqual([]);
  expect(document.warnings).toEqual([]);
  return workflowSchema.parse(document.toJS() as unknown);
}

describe('workflow privilege and publication boundaries', () => {
  it('keeps every PR route read-only and isolated from secret-bearing jobs', async () => {
    const ci = await workflow('ci');
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push']);
    expect(ci.permissions).toEqual({ contents: 'read' });
    const offline = ci.jobs.offline!;
    expect(offline.permissions ?? ci.permissions).toEqual({ contents: 'read' });
    expect(offline.if).toBeUndefined();
    expect(JSON.stringify(offline)).not.toMatch(/secrets\./);
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (name === 'offline') continue;
      // Secret-bearing execution requires positive trusted-push AND protected-ref
      // predicates, never an OR branch allowing fork/same-repo PR execution.
      expect(job.if).toContain("github.event_name == 'push'");
      expect(job.if).toContain("github.repository == 'EveGoodEvening/auto-mode-gateway'");
      expect(job.if).toContain('github.ref_protected');
      expect(job.if).not.toContain('||');
      expect(job.permissions ?? ci.permissions).toEqual({ contents: 'read' });
    }
  });
  it('makes independent evidence a mandatory dominator of every publication step', async () => {
    const release = await workflow('release');
    expect(Object.keys(release.on)).toEqual(['push']);
    expect(release.on.push).toEqual({ tags: ['v*'] });
    expect(release.permissions).toEqual({ contents: 'read' });
    const preflight = release.jobs.preflight!;
    expect(preflight.if).toBeUndefined();
    expect(preflight.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(preflight)).not.toMatch(/secrets\./);
    for (const step of preflight.steps) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).not.toBe(true);
    }
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name === 'preflight') continue;
      expect(job.needs).toBe('preflight');
      expect(job.if).toContain('github.ref_protected');
      expect(job.if).not.toContain('||');
      expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
      const gate = job.steps.findIndex((step) => step.run?.includes('scripts/release-evidence.ts'));
      expect(gate).toBeGreaterThanOrEqual(0);
      const publications = job.steps.map((step, index) => ({ step, index })).filter(({ step }) => /docker push|npm publish/.test(step.run ?? ''));
      expect(publications).toHaveLength(2);
      for (const { step, index } of publications) {
        expect(index).toBeGreaterThan(gate);
        expect(step.if).toBeUndefined();
        for (const predecessor of job.steps.slice(gate, index + 1)) {
          expect(predecessor['continue-on-error']).not.toBe(true);
          expect(predecessor.if).toBeUndefined();
        }
      }
      expect(job.steps[gate]!.env?.RELEASE_AUDITOR_PUBLIC_KEY).toMatch(/^\$\{\{ vars\./);
      expect(job.steps[gate]!.env).not.toHaveProperty('RELEASE_AUDITOR_PRIVATE_KEY');
    }
  });
  it('pins action identities and prevents checkout-token persistence in both workflows', async () => {
    for (const name of ['ci', 'release']) {
      const parsed = await workflow(name);
      for (const job of Object.values(parsed.jobs)) for (const step of job.steps) {
        if (!step.uses) continue;
        expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
        if (step.uses.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });
});
