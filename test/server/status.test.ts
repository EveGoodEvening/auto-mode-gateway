import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { configSchema } from '../../src/config/schema.js';
import { createStatus } from '../../src/server/status.js';
import type { GateStats } from '../../src/gate/types.js';

function fixture() {
  return configSchema.parse({
    auth: { mode: 'vault', client_tokens: ['client-secret'], admin_token: 'admin-secret' },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay', project_dirs: ['/private/project'] }],
    upstreams: { relay: { base_url: 'https://relay.example', api_key: 'relay-secret' } },
    decision: { chain: ['trusted'], providers: {
      trusted: { kind: 'systemone', base_url: 'https://trusted.example', api_key: 'provider-secret', model: 'test' },
    } },
    trust_proxy: true,
  });
}

describe('management status', () => {
  it.each(['127.0.0.1', '127.15.20.30', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f01:203'])('allows the actual loopback peer %s', (peer) => {
    expect(createStatus(fixture()).response(new Headers(), peer).status).toBe(200);
  });

  it.each([undefined, 'localhost', '127.evil.example', '192.0.2.1', '::ffff:192.0.2.1', '::', '::1%lo', '127.0.0.1:1234'])('rejects non-loopback or missing socket identity %s', (peer) => {
    expect(createStatus(fixture()).response(new Headers(), peer).status).toBe(403);
  });

  it('never trusts forwarded identities or ordinary client tokens', () => {
    const status = createStatus(fixture());
    const headers = new Headers({
      'x-forwarded-for': '127.0.0.1', 'x-real-ip': '::1', forwarded: 'for=127.0.0.1',
      authorization: 'Bearer client-secret',
    });
    expect(status.response(headers, '192.0.2.1').status).toBe(403);
    expect(status.response(headers, undefined).status).toBe(403);
  });

  const adminHeaders: HeadersInit[] = [{ authorization: 'Bearer admin-secret' }, { 'x-api-key': 'admin-secret' }];
  it.each(adminHeaders)('allows remote access with a configured admin token %j', (headers) => {
    expect(createStatus(fixture()).response(new Headers(headers), '192.0.2.1').status).toBe(200);
  });

  it('remains remote-protected without an admin token, including passthrough mode', () => {
    const config = fixture();
    config.auth = { mode: 'passthrough', client_tokens: ['client-secret'] };
    expect(createStatus(config).response(new Headers({ authorization: 'Bearer client-secret' }), '192.0.2.1').status).toBe(403);
  });

  it('reports version, monotonic uptime, sanitized routes and actual decision health/counters', async () => {
    const stats: GateStats = { decisions: 6, allow: 2, block: 1, uncertain: 3, cache_hits: 1,
      provider_failures: 1, provider_health: { trusted: { successes: 0, failures: 1 } } };
    const status = createStatus(fixture(), () => stats);
    const response = status.response(new Headers(), '127.0.0.1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.version).toBe(pkg.version);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.uptime_seconds).toBeLessThan(10);
    expect(body.routes).toEqual([{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay', protected: true }]);
    expect(body.provider_health).toEqual({ trusted: 'unhealthy' });
    expect(body.counters).toEqual({ allow: 2, block: 1, uncertain: 3 });
    expect(body.protected).toBe(true);
    expect(body.transport).toBe('tool-use-gate');
    expect(body.decisions).toBe(6);
    expect(body.cache_hits).toBe(1);
    expect(body.provider_failures).toBe(1);
    for (const secret of ['client-secret', 'admin-secret', 'relay-secret', 'provider-secret', '/private/project', 'https://']) {
      expect(text).not.toContain(secret);
    }
    const untouched = await createStatus(fixture()).response(new Headers(), '127.0.0.1').json() as {
      provider_health: Record<string, string>;
      counters: { allow: number; block: number; uncertain: number };
    };
    expect(untouched.provider_health).toEqual({ trusted: 'unknown' });
    expect(untouched.counters).toEqual({ allow: 0, block: 0, uncertain: 0 });
  });

  it('does not advertise unfinished protocols or shadow as protected', async () => {
    const config = fixture();
    config.routes.push({ ...config.routes[0]!, prefix: '/cx', protocol: 'openai-responses' });
    config.routes.push({ ...config.routes[0]!, prefix: '/wb', protocol: 'openai-chat' });
    const stats: GateStats = { decisions: 0, allow: 0, block: 0, uncertain: 0, cache_hits: 0,
      provider_failures: 0, provider_health: {} };
    const status = createStatus(config, () => stats);
    const mixed = await status.response(new Headers(), '127.0.0.1').json() as { protected: boolean; routes: { protected: boolean }[] };
    expect(mixed.protected).toBe(false);
    expect(mixed.routes.map((route) => route.protected)).toEqual([true, true, false]);
    config.gate.mode = 'shadow';
    const shadow = await status.response(new Headers(), '127.0.0.1').json() as { protected: boolean; routes: { protected: boolean }[] };
    expect(shadow.protected).toBe(false);
    expect(shadow.routes.every((route) => !route.protected)).toBe(true);
  });

  it('prevents caching access-denied responses too', async () => {
    const response = createStatus(fixture()).response(new Headers(), '192.0.2.1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret');
  });
});
