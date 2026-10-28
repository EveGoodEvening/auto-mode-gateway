import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Config } from '../config/schema.js';
import { resolvePolicy, type EffectivePolicy } from '../policy/effective.js';
import { collectConfigSecrets, createAuditRecord, sanitizeAuditValue, type AuditInput, type AuditSink } from './record.js';

export const AUDIT_FAILURE_DIAGNOSTIC = 'Audit log append failed; request processing continues.';
export interface AuditLoggerOptions {
  policy?: EffectivePolicy;
  diagnostic?: (message: string) => void;
}
export interface AuditLogger {
  appendEvent(input: { event: 'suspected_classifier'; route: string; protocol: Config['routes'][number]['protocol']; session_id?: string }): Promise<void>;
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
  function enqueue(record: unknown): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
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
  return {
    append(input: AuditInput) {
      // Snapshot before enqueue; never retain mutable execution input.
      try { return enqueue(createAuditRecord(input, credentials, policy)); }
      catch { failed(); return Promise.resolve(); }
    },
    appendEvent(input) {
      // No action, verdict or provider success is invented for a fingerprint hint.
      try {
        return enqueue(sanitizeAuditValue({ ts: new Date().toISOString(), event: input.event, route: input.route,
          protocol: input.protocol, session_id: input.session_id ?? null }, credentials, policy));
      } catch { failed(); return Promise.resolve(); }
    },
    flush: () => pending,
  };
}
