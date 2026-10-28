import { createHash } from 'node:crypto';

export const CACHE_CAPACITY = 10_000;
export const CACHE_TTL_MS = 600_000;

/** Stable serialization also preserves the actual meaning of policy regexes. */
export function canonical(value: unknown): string {
  if (value instanceof RegExp) return JSON.stringify({ source: value.source, flags: value.flags });
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function cacheKey(material: unknown): string {
  return createHash('sha256').update(canonical(material)).digest('hex');
}

/** Each gate owns its cache; values cannot cross configuration/credential lifetimes. */
export class DecisionCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  constructor(
    private readonly capacity = CACHE_CAPACITY,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('Invalid cache bounds');
  }
  get size(): number { return this.entries.size; }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); }
}
