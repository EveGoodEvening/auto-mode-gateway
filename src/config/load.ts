import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

import { DEFAULT_CONFIG_PATH } from './defaults.js';
import { configSchema } from './schema.js';
import type { Config } from './schema.js';

type KeyPath = (string | number)[];

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((result, key) => {
    if (typeof key === 'number') return `${result}[${key}]`;
    const name = String(key);
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
      return result === '$' ? name : `${result}.${name}`;
    }
    return `${result}[${JSON.stringify(name)}]`;
  }, '$');
}

function interpolate(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: KeyPath,
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'string') {
    // Interpolate values only, after parsing. Environment contents are never YAML
    // syntax, coerced to another scalar type, or recursively expanded.
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      if (!Object.hasOwn(env, name) || env[name] === undefined) {
        throw new Error(`Missing environment variable ${name} at ${formatPath(path)}`);
      }
      return env[name];
    });
  }
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) {
    throw new Error(`Invalid YAML at ${formatPath(path)}: cyclic alias`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) => interpolate(item, env, [...path, index], ancestors));
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      result[key] = interpolate(item, env, [...path, key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Parse YAML, interpolate scalar values, then apply the shared schema/defaults. */
export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Config {
  let parsed: unknown;
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    // Parser diagnostics may contain source lines and secrets. Do not propagate
    // parser messages, source snippets, or causes to callers.
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error('Invalid YAML');
    }
    parsed = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    throw new Error('Invalid YAML at $: unable to parse configuration');
  }

  const result = configSchema.safeParse(interpolate(parsed, env, [], new Set()));
  if (!result.success) {
    // Zod messages for enums, unknown keys and refinements can echo input.
    // Codes and key paths are sufficient diagnostics without those values.
    const issues = result.error.issues.map(
      (issue) => `${formatPath(issue.path)} (${issue.code})`,
    );
    throw new Error(`Invalid configuration at ${issues.join('; ')}`);
  }
  return result.data;
}

export async function loadConfig(
  path: string = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // Filesystem messages may include user-controlled paths; keep them private.
    throw new Error('Unable to read configuration file at $');
  }
  return parseConfig(text, env);
}
