import { describe, expect, it } from 'vitest';
import { CACHE_CAPACITY, CACHE_TTL_MS, DecisionCache, cacheKey } from '../../src/gate/cache.js';

describe('decision LRU', () => {
  it('expires exactly at 600 seconds without extending TTL on access', () => {
    let clock = 0;
    const cache = new DecisionCache<number>(undefined, undefined, () => clock);
    cache.set('a', 1);
    clock = CACHE_TTL_MS - 1;
    expect(cache.get('a')).toBe(1);
    clock += 1;
    expect(cache.get('a')).toBeUndefined();
  });
  it('evicts the least recently used of 10000 entries', () => {
    const cache = new DecisionCache<number>();
    for (let i = 0; i < CACHE_CAPACITY; i++) cache.set(String(i), i);
    expect(cache.get('0')).toBe(0);
    cache.set('new', 5);
    expect(cache.size).toBe(CACHE_CAPACITY);
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('0')).toBe(0);
  });
  it('refreshes replacement TTL and isolates instances', () => {
    let clock = 0;
    const first = new DecisionCache<number>(2, 10, () => clock);
    const second = new DecisionCache<number>(2, 10, () => clock);
    first.set('a', 1);
    clock = 8;
    first.set('a', 2);
    clock = 10;
    expect(first.get('a')).toBe(2);
    expect(second.get('a')).toBeUndefined();
    clock = 18;
    expect(first.get('a')).toBeUndefined();
  });
  it('canonicalizes object order but retains arrays and policy regex semantics', () => {
    expect(cacheKey({ a: 1, b: { x: 2 } })).toBe(cacheKey({ b: { x: 2 }, a: 1 }));
    expect(cacheKey(['first', 'second'])).not.toBe(cacheKey(['second', 'first']));
    expect(cacheKey(/one/iu)).not.toBe(cacheKey(/two/iu));
    expect(cacheKey(/one/i)).not.toBe(cacheKey(/one/u));
    expect(cacheKey({ credential: 'inert-secret' })).not.toContain('inert-secret');
  });
  it('rejects unbounded or empty cache settings', () => {
    expect(() => new DecisionCache(0)).toThrow();
    expect(() => new DecisionCache(1, Infinity)).toThrow();
  });
});
