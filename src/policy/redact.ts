import { REDACTION_PATTERNS, REDACTION_SENSITIVE_KEYS } from './constants.js';

/** Configured credentials are literal strings, never regular expressions. */
export function redactText(text: string, credentials: readonly string[] = []): string {
  let result = text;
  // Longest first prevents a shorter credential from exposing the remainder.
  const literals = [...new Set(credentials.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  for (const credential of literals) result = result.split(credential).join('[REDACTED:credential]');
  for (const entry of REDACTION_PATTERNS) {
    const { pattern, type } = entry;
    const replacement = 'replacement' in entry ? entry.replacement : `[REDACTED:${type}]`;
    // Cloning avoids shared global/sticky lastIndex state between requests.
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return result;
}

/** Produces inert data properties, including __proto__/constructor, without
 * mutating input or invoking accessors. Cycles are preserved, not recursed forever.
 * Intended for JSON-shaped policy state and audit payloads, not class instances.
 */
export function redact<T>(value: T, credentials: readonly string[] = []): T {
  const seen = new WeakMap<object, object>();
  function visit(input: unknown): unknown {
    if (typeof input === 'string') return redactText(input, credentials);
    if (input === null || typeof input !== 'object') return input;
    const existing = seen.get(input);
    if (existing) return existing;
    const result: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : {};
    seen.set(input, result);
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const sensitiveKey = new RegExp(REDACTION_SENSITIVE_KEYS.source, REDACTION_SENSITIVE_KEYS.flags).test(key);
      const next = sensitiveKey && descriptor.value !== null && descriptor.value !== undefined
        ? '[REDACTED:credential]'
        : visit(descriptor.value);
      Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  return visit(value) as T;
}
