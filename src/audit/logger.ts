import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Config } from '../config/schema.js';
import { resolvePolicy, type EffectivePolicy } from '../policy/effective.js';
import { collectConfigSecrets, createAuditRecord, type AuditInput, type AuditSink } from './record.js';

export const AUDIT_FAILURE_DIAGNOSTIC = 'Audit log append failed; request processing continues.';
export interface AuditLoggerOptions {
  policy?: EffectivePolicy;
  diagnostic?: (message: string) => void;
}
export interface AuditLogger {
  append: AuditSink;
  flush(): Promise<void>;
}

/** A serialized async queue prevents interleaved JSONL records. Errors (including
 * serialization and diagnostic sink errors) never propagate into the gate. */
export function createAuditLogger(config: Config, options: AuditLoggerOptions = {}): AuditLogger {
  const policy = options.policy ?? resolvePolicy(config.policy);
  const credentials = collectConfigSecrets(config);
  const path = config.audit.path;
  const diagnostic = options.diagnostic ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  let pending = Promise.resolve();
  const failed = () => {
    try { diagnostic(AUDIT_FAILURE_DIAGNOSTIC); } catch { /* Diagnostics cannot break requests either. */ }
  };
  function append(input: AuditInput): Promise<void> {
    // Snapshot before enqueue: callers can reuse/mutate their action after deciding.
    let line: string;
    try {
      line = `${JSON.stringify(createAuditRecord(input, credentials, policy))}\n`;
    } catch {
      failed();
      return Promise.resolve();
    }
    pending = pending.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // Refuse a symlink at the final component and tighten pre-existing files.
      const file = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await file.chmod(0o600);
        await file.appendFile(line, 'utf8');
      } finally {
        await file.close();
      }
    }).catch(failed);
    return pending;
  }
  return { append, flush: () => pending };
}
