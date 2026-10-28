import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Command, InvalidArgumentError } from 'commander';

import { collectConfigSecrets, sanitizeAuditValue } from '../audit/record.js';
import { loadConfig } from '../config/load.js';
import { DEFAULT_POLICY, resolvePolicy, type EffectivePolicy } from '../policy/effective.js';

const MALFORMED_RECORD = '[audit: malformed record omitted]';

/** Bounded line history; malformed source bytes are never echoed to stdout. */
export async function readAuditTail(path: string, count = 10, credentials: readonly string[] = [], policy: EffectivePolicy = DEFAULT_POLICY): Promise<string[]> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('Invalid audit line count');
  const history: string[] = [];
  let next = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let formatted: string;
      try {
        const value: unknown = JSON.parse(line);
        if (value === null || Array.isArray(value) || typeof value !== 'object') {
          formatted = MALFORMED_RECORD;
        } else {
          formatted = JSON.stringify(sanitizeAuditValue(value, credentials, policy));
        }
      } catch {
        formatted = MALFORMED_RECORD;
      }
      if (history.length < count) history.push(formatted);
      else { history[next] = formatted; next = (next + 1) % count; }
    }
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error('Unable to read audit log', { cause: error });
  } finally {
    lines.close();
    stream.destroy();
  }
  return next === 0 ? history : [...history.slice(next), ...history.slice(0, next)];
}

function parseLineCount(value: string): number {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new InvalidArgumentError('Expected an integer from 1 to 10000.');
  }
  return count;
}

export function registerAuditCommand(program: Command): void {
  program.command('audit').description('Read sanitized local audit records.')
    .command('tail')
    .description('Print the last audit lines as sanitized JSONL; omit malformed source bytes.')
    .option('--config <path>', 'configuration file path')
    .option('-n, --lines <count>', 'number of lines (1-10000)', parseLineCount, 10)
    .action(async (options: { config?: string; lines: number }) => {
      const config = await loadConfig(options.config);
      const policy = resolvePolicy(config.policy);
      const lines = await readAuditTail(config.audit.path, options.lines, collectConfigSecrets(config), policy);
      for (const line of lines) process.stdout.write(`${line}\n`);
    });
}
