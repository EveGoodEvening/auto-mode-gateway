import { describe, expect, it } from 'vitest';

import { configSchema } from '../../src/config/schema.js';
import { clientAddressForLog, createLogger } from '../../src/util/log.js';

const secrets = ['fake-client-9x', 'fake-admin-9x', 'fake-upstream-9x', 'fake-upstream-header-9x', 'fake-provider-9x', 'fake-provider-header-9x', 'fake-review-9x', 'fake-review-header-9x'];
function configuration() {
  return configSchema.parse({
    auth: { mode: 'vault', client_tokens: [secrets[0]], admin_token: secrets[1] },
    upstreams: { mock: { base_url: 'http://127.0.0.1:1', api_key: secrets[2], extra_headers: { 'x-custom': secrets[3]! } } },
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'mock' }],
    decision: {
      chain: ['mock'],
      providers: { mock: { kind: 'systemone', base_url: 'http://127.0.0.1:1', api_key: secrets[4], model: 'mock', headers: { 'x-custom': secrets[5]! } } },
      second_stage: { base_url: 'http://127.0.0.1:1', api_key: secrets[6], headers: { 'x-custom': secrets[7]! } },
    },
    // Mandatory credential masking must not depend on configurable regexes.
    policy: { redaction_patterns: [], redaction_sensitive_keys: { source: '^never-match$' } },
  });
}
function capture() {
  let text = '';
  const logger = createLogger(configuration(), { write(chunk: string) { text += chunk; } });
  return { logger, text: () => text, rows: () => text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('diagnostic logger credential boundary', () => {
  it.each(['authorization', 'Authorization', 'AUTHORIZATION', 'x-api-key', 'X-API-Key', 'cf-aig-authorization', 'Cf-Aig-Authorization'])('masks %s at arbitrary nesting while preserving safe fields', (name) => {
    const output = capture();
    const input = { request: { nested: [{ headers: { [name]: 'fake-unconfigured-header-42', 'x-request-id': 'safe-trace-42' } }] }, status: 413, allowed: false };
    output.logger.info(input, 'Safe diagnostic');
    expect(output.text()).not.toContain('fake-unconfigured-header-42');
    expect(output.rows()[0]).toMatchObject({ ...input, request: { nested: [{ headers: { [name]: '[REDACTED:credential]', 'x-request-id': 'safe-trace-42' } }] }, msg: 'Safe diagnostic' });
    expect(input.request.nested[0]!.headers[name]).toBe('fake-unconfigured-header-42');
  });

  it('redacts every configured credential in messages, nested errors, bindings, and dynamic property names', () => {
    const output = capture();
    const full = secrets.join(' | ');
    const error = new Error(`Transport ${full}`, { cause: new Error(`Cause ${full}`) });
    output.logger.child({ component: 'safe-child', [secrets[0]!]: full }).error({ err: error, nested: [full], count: 0 }, 'Failed %s', full);
    for (const secret of secrets) expect(output.text()).not.toContain(secret);
    expect(output.rows()[0]).toMatchObject({ component: 'safe-child', count: 0, nested: [expect.stringContaining('[REDACTED:credential]')], err: { message: expect.stringContaining('Transport'), cause: { message: expect.stringContaining('Cause') } }, msg: expect.stringContaining('Failed') });
  });

  it('redacts before any consumer output boundary and omits unsafe pre-truncated excerpts', () => {
    const output = capture();
    const secret = secrets[2]!;
    const content = `${'a'.repeat(2040)}${secret} safe-suffix`;
    output.logger.info({ content, nested: { content_truncated: true, content_excerpt: content.slice(0, 2048), content_digest: 'safe-digest' } }, content);
    expect(output.text()).not.toContain(secret);
    expect(output.text()).not.toContain(content.slice(0, 2048));
    expect(output.rows()[0]).toMatchObject({ nested: { content_truncated: true, content_digest: 'safe-digest' }, content: expect.stringContaining('safe-suffix'), msg: expect.stringContaining('safe-suffix') });
    expect((output.rows()[0]!.nested as Record<string, unknown>)).not.toHaveProperty('content_excerpt');
  });

  it('handles native Headers and does not invoke accessors or custom serialization', () => {
    const output = capture();
    let invoked = 0;
    const dangerous = { safe: 'retained', get credential() { invoked++; return secrets[0]; }, toJSON() { invoked++; return secrets[0]; } };
    output.logger.info({ headers: new Headers({ Authorization: 'fake-native-header-42', 'x-request-id': 'safe-native-id' }), dangerous }, 'Safe');
    expect(invoked).toBe(0);
    expect(output.text()).not.toContain('fake-native-header-42');
    expect(output.rows()[0]).toMatchObject({ headers: { authorization: '[REDACTED:credential]', 'x-request-id': 'safe-native-id' }, dangerous: { safe: 'retained' } });
  });

  it('uses fixed diagnostics rather than partially sanitized cyclic data or serializer exceptions', () => {
    const output = capture();
    const cycle: Record<string, unknown> = { secret: secrets[0] };
    cycle.self = cycle;
    output.logger.error({ cycle, safe: 'not-serialized' }, 'Serialization failure');
    for (const secret of secrets) expect(output.text()).not.toContain(secret);
    expect(output.rows()[0]).toMatchObject({ diagnostic: 'Log value could not be serialized', msg: 'Serialization failure' });
    expect(output.rows()[0]).not.toHaveProperty('safe');
  });
});

describe('forwarded address logging only', () => {
  it.each([false, true])('retains the peer without XFF, trust=%s', (trusted) => {
    expect(clientAddressForLog(new Headers(), '203.0.113.7', trusted)).toBe('203.0.113.7');
  });
  it('ignores forwarded addresses unless explicitly trusted', () => {
    const headers = new Headers({ 'x-forwarded-for': '127.0.0.1, 198.51.100.9' });
    expect(clientAddressForLog(headers, '203.0.113.7', false)).toBe('203.0.113.7');
    expect(clientAddressForLog(headers, '203.0.113.7', true)).toBe('127.0.0.1');
  });
  it.each(['not-an-ip', ', 127.0.0.1', '127.0.0.1:1234', '"127.0.0.1"', '[::1]'])('falls back to the peer for malformed first address %s', (forwarded) => {
    expect(clientAddressForLog(new Headers({ 'x-forwarded-for': forwarded }), '203.0.113.7', true)).toBe('203.0.113.7');
  });
  it('accepts a bare IPv6 address and never fabricates a missing peer', () => {
    expect(clientAddressForLog(new Headers({ 'x-forwarded-for': '2001:db8::1, 192.0.2.1' }), undefined, true)).toBe('2001:db8::1');
    expect(clientAddressForLog(new Headers(), undefined, false)).toBeUndefined();
  });
});
