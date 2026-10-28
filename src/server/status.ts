import { isIP } from 'node:net';
import pkg from '../../package.json' with { type: 'json' };
import type { Config } from '../config/schema.js';
import { authenticateAdmin } from './auth.js';

function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const canonical = new URL(`http://[${address}]`).hostname;
  return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
}

export function createStatus(config: Config) {
  const startedAt = performance.now();
  const counters = { allow: 0, block: 0, uncertain: 0 };
  // No provider checks or gate decisions have run at this transparent transport stage.
  const providerHealth: Record<string, 'unknown' | 'healthy' | 'unhealthy'> = Object.fromEntries(
    Object.keys(config.decision.providers).map((id) => [id, 'unknown' as const]),
  );
  return {
    counters,
    providerHealth,
    response(headers: Headers, peerAddress: string | undefined): Response {
      if (!isLoopbackPeer(peerAddress) && !authenticateAdmin(headers, config.auth)) {
        return Response.json({ error: 'Management access requires a loopback peer or admin token.' }, {
          status: 403, headers: { 'cache-control': 'no-store' },
        });
      }
      return Response.json({
        version: pkg.version,
        uptime_seconds: Math.max(0, (performance.now() - startedAt) / 1000),
        transport: 'unprotected-transparent',
        protected: false,
        routes: config.routes.map(({ prefix, protocol, upstream }) => ({ prefix, protocol, upstream })),
        provider_health: { ...providerHealth },
        counters: { ...counters },
      }, { headers: { 'cache-control': 'no-store' } });
    },
  };
}
