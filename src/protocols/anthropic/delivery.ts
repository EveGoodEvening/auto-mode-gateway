import type { RequestContext } from '../types.js';

export interface ClaudeScope { identity?: string; route: string; session?: string; version?: string }
export interface ClaudeRoute { claude_delivery?: 'auto' | 'native' | 'rewrite'; claude_delivery_by_version?: Record<string, 'native' | 'rewrite'> }
interface Session { touched: number; nativeAt?: number; rewrite: boolean }

/** Process-local evidence only; eviction restores the original opt-in semantics. */
export function createClaudeDeliveryState(now: () => number = Date.now) {
  const sessions = new Map<string, Session>();
  function key(scope: ClaudeScope): string | undefined {
    if (!scope.identity || !scope.route || !scope.session || !scope.version) return undefined;
    // Request metadata is untrusted and must not create unbounded retained keys.
    const parts = [scope.identity, scope.route, scope.session, scope.version];
    if (parts.some(part => part.length > 1024)) return undefined;
    return JSON.stringify(parts);
  }
  function entry(scope: ClaudeScope, create = false): Session | undefined {
    const time = now();
    for (const [id, session] of sessions) if (time - session.touched >= 30 * 60_000) sessions.delete(id);
    const id = key(scope);
    if (!id) return undefined;
    let session = sessions.get(id);
    if (!session && create) {
      if (sessions.size >= 1024) sessions.delete(sessions.keys().next().value!);
      session = { touched: time, rewrite: false };
    }
    if (session) { session.touched = time; sessions.delete(id); sessions.set(id, session); }
    return session;
  }
  return {
    select(context: RequestContext, scope: ClaudeScope, route: ClaudeRoute): 'native' | 'rewrite' {
      if (context.safeguards === undefined) return 'rewrite';
      if (route.claude_delivery && route.claude_delivery !== 'auto') return route.claude_delivery;
      const overrides = route.claude_delivery_by_version;
      const override = scope.version && overrides && Object.hasOwn(overrides, scope.version) ? overrides[scope.version] : undefined;
      if (override) return override;
      return entry(scope)?.rewrite ? 'rewrite' : 'native';
    },
    observeRequest(scope: ClaudeScope, classifier: boolean): boolean {
      const session = entry(scope);
      if (!session) return false;
      const fallback = classifier && session.nativeAt !== undefined && now() - session.nativeAt >= 0 && now() - session.nativeAt <= 30_000;
      // The next actual request consumes the correlation window, including unrelated model turns.
      delete session.nativeAt;
      if (fallback) session.rewrite = true;
      return fallback;
    },
    nativeDelivered(scope: ClaudeScope): void {
      const session = entry(scope, true);
      if (session) session.nativeAt = now();
    },
  };
}
