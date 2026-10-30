import { createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseConfig } from '../src/config/load.js';
import { assertFreshReport, MAX_ARCHIVED_REPORT_BYTES } from '../src/eval/metrics.js';
import { engineFingerprint, evaluationFingerprints } from '../src/eval/runner.js';
import { parseCorpus, receiptSchema, templatesSchema, type Fingerprints } from '../src/eval/schema.js';

export const releaseAuthorizationSchema = z.strictObject({
  version: z.literal(1),
  repository: z.literal('EveGoodEvening/auto-mode-gateway'),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  ref: z.string().regex(/^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/),
  identity: z.literal('source'),
  report_bytes: z.number().int().positive().max(MAX_ARCHIVED_REPORT_BYTES),
  receipt: receiptSchema,
});

/** The key is provisioned by an independent release owner, never by the evaluator.
 * Signature authenticates EXACT envelope bytes; receipt authenticates EXACT report bytes.
 * Repository-variable administrators and the external keyholder are trust roots.
 */
interface AuthorizationInput {
  report: Uint8Array; authorization: Uint8Array; signature: Uint8Array;
  publicKey: string; repository: string; commit: string; ref: string;
}
function authenticateAuthorization(input: AuthorizationInput) {
  if (input.authorization.byteLength === 0 || input.authorization.byteLength > 8192 || input.signature.byteLength !== 64
    || input.publicKey.length > 8192) throw new Error('Invalid release authorization bounds');
  const key = createPublicKey(input.publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, input.authorization, key, input.signature)) throw new Error('Independent release authorization signature rejected');
  const authorization = releaseAuthorizationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.authorization)) as unknown);
  if (authorization.repository !== input.repository || authorization.commit !== input.commit || authorization.ref !== input.ref
    || authorization.report_bytes !== input.report.byteLength) throw new Error('Release authorization target mismatch');
  return authorization;
}

export function authorizeRelease(input: AuthorizationInput & { current: Fingerprints }) {
  const authorization = authenticateAuthorization(input);
  return assertFreshReport(input.report, input.current, authorization.receipt);
}

/** Read one bounded regular-file snapshot; never trust size before an unbounded readFile. */
export async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error('Invalid evidence file bounds');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error('Evidence file changed while reading');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

function releaseContext(env: NodeJS.ProcessEnv) {
  // Reject PRs/forks/unprotected tags independently of YAML routing; a named
  // Environment does not establish protection or authorize provider provenance.
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REPOSITORY !== 'EveGoodEvening/auto-mode-gateway'
    || env.GITHUB_REF_PROTECTED !== 'true' || !env.GITHUB_REF?.startsWith('refs/tags/')) throw new Error('Release context is not authorized');
  if (!env.RELEASE_AUDITOR_PUBLIC_KEY) throw new Error('Release prerequisites missing');
  return { publicKey: env.RELEASE_AUDITOR_PUBLIC_KEY, repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA ?? '', ref: env.GITHUB_REF };
}
async function readEvidence(directory: string) {
  return {
    report: await readBoundedFile(resolve(directory, 'release-report.json'), MAX_ARCHIVED_REPORT_BYTES),
    authorization: await readBoundedFile(resolve(directory, 'release-authorization.json'), 8192),
    signature: await readBoundedFile(resolve(directory, 'release-authorization.sig'), 64),
  };
}
export async function preflightReleaseDirectory(directory: string, env: NodeJS.ProcessEnv) {
  const context = releaseContext(env);
  authenticateAuthorization({ ...context, ...await readEvidence(directory) });
}
export async function verifyReleaseDirectory(directory: string, env: NodeJS.ProcessEnv) {
  const context = releaseContext(env);
  if (!env.EVAL_CONFIG_YAML) throw new Error('Release prerequisites missing');
  const evidence = await readEvidence(directory);
  // Fully expanded configuration only: ambient CI env must not enter fingerprints.
  const config = parseConfig(env.EVAL_CONFIG_YAML, {});
  const rows = parseCorpus((await readBoundedFile('eval/cases.jsonl', 8 * 1024 * 1024)).toString('utf8'));
  const templates = templatesSchema.parse(JSON.parse((await readBoundedFile('eval/injection-templates.json', 1024 * 1024)).toString('utf8')) as unknown);
  const current = evaluationFingerprints({ rows, templates, rulesOnly: false, config, engine: await engineFingerprint() });
  return authorizeRelease({ ...context, ...evidence, current });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 4 && process.argv[2] === '--preflight') {
      await preflightReleaseDirectory(process.argv[3]!, process.env);
      process.stdout.write('release: protected tag and independent signature preflight accepted; full current evidence still REQUIRED\n');
    } else {
      if (process.argv.length !== 3) throw new Error();
      await verifyReleaseDirectory(process.argv[2]!, process.env);
      process.stdout.write('release: independent authorization and current SOURCE full-provider accuracy accepted\n');
    }
  } catch {
    process.stderr.write('release: evidence rejected; publication prohibited (details withheld)\n');
    process.exitCode = 1;
  }
}
