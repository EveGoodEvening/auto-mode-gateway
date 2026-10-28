import { isIP } from 'node:net';
import pkg from '../../package.json' with { type: 'json' };
import type { Config } from '../config/schema.js';
import type { GateStats } from '../gate/types.js';
import { authenticateAdmin } from './auth.js';

function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const canonical = new URL(`http://[${address}]`).hostname;
  return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
}

export function createStatus(config: Config, stats?: () => GateStats) {
  const startedAt = performance.now();
  return {
    response(headers: Headers, peerAddress: string | undefined): Response {
      if (!isLoopbackPeer(peerAddress) && !authenticateAdmin(headers, config.auth)) {
        return Response.json({ error: 'Management access requires a loopback peer or admin token.' }, {
          status: 403, headers: { 'cache-control': 'no-store' },
        });
      }
      const current = stats?.();
      const routes = config.routes.map(({ prefix, protocol, upstream }) => ({
        prefix, protocol, upstream,
        protected: stats !== undefined && config.gate.mode === 'enforce' && protocol === 'anthropic-messages',
      }));
      const providerHealth = Object.fromEntries(Object.keys(config.decision.providers).map((id) => {
        const health = current?.provider_health[id];
        return [id, !health || health.successes + health.failures === 0 ? 'unknown'
          : health.failures > 0 ? health.successes > 0 ? 'degraded' : 'unhealthy' : 'healthy'];
      }));
      return Response.json({
        version: pkg.version,
        uptime_seconds: Math.max(0, (performance.now() - startedAt) / 1000),
        transport: stats ? 'tool-use-gate' : 'unprotected-transparent',
        protected: routes.length > 0 && routes.every((route) => route.protected),
        gate_mode: config.gate.mode,
        routes,
        provider_health: providerHealth,
        counters: { allow: current?.allow ?? 0, block: current?.block ?? 0, uncertain: current?.uncertain ?? 0 },
        decisions: current?.decisions ?? 0,
        cache_hits: current?.cache_hits ?? 0,
        provider_failures: current?.provider_failures ?? 0,
      }, { headers: { 'cache-control': 'no-store' } });
    },
  };
}
