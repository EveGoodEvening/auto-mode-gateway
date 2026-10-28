import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { configSchema } from '../../src/config/schema.js';
import { createStatus } from '../../src/server/status.js';

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

  it('reports version, monotonic uptime, sanitized routes, unknown provider health and independent counters', async () => {
    const status = createStatus(fixture());
    status.counters.allow = 2;
    status.counters.block = 1;
    status.counters.uncertain = 3;
    status.providerHealth.trusted = 'unhealthy';
    const response = status.response(new Headers(), '127.0.0.1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.version).toBe(pkg.version);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.uptime_seconds).toBeLessThan(10);
    expect(body.routes).toEqual([{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }]);
    expect(body.provider_health).toEqual({ trusted: 'unhealthy' });
    expect(body.counters).toEqual({ allow: 2, block: 1, uncertain: 3 });
    expect(body.protected).toBe(false);
    expect(body.transport).toBe('unprotected-transparent');
    for (const secret of ['client-secret', 'admin-secret', 'relay-secret', 'provider-secret', '/private/project', 'https://']) {
      expect(text).not.toContain(secret);
    }
    const untouched = await createStatus(fixture()).response(new Headers(), '127.0.0.1').json() as {
      provider_health: typeof status.providerHealth;
      counters: typeof status.counters;
    };
    expect(untouched.provider_health).toEqual({ trusted: 'unknown' });
    expect(untouched.counters).toEqual({ allow: 0, block: 0, uncertain: 0 });
  });

  it('prevents caching access-denied responses too', async () => {
    const response = createStatus(fixture()).response(new Headers(), '192.0.2.1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('secret');
  });
});
