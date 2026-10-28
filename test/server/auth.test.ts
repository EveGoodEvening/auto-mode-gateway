import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import { authenticate, authenticateAdmin, buildUpstreamHeaders } from '../../src/server/auth.js';

const vault: Config['auth'] = { mode: 'vault', client_tokens: ['amp_first', 'amp_é'], admin_token: 'admin-only' };
const upstream: Config['upstreams'][string] = {
  base_url: 'https://relay.example', api_key: 'upstream-secret', auth_header: 'authorization', forward_safeguards: false, strip_beta: true,
};

describe('authenticate', () => {
  it.each([
    { authorization: 'Bearer amp_first' }, { authorization: 'bEaReR amp_first' },
    { 'x-api-key': 'amp_first' }, { 'x-api-key': 'amp_é' },
    { authorization: 'Bearer wrong', 'x-api-key': 'amp_first' },
  ])('accepts a configured vault token through either credential header: %j', (headers) => {
    expect(authenticate(new Headers(headers as Record<string, string>), vault)).toBe(true);
  });

  it.each([
    {}, { authorization: 'Basic amp_first' }, { authorization: 'Bearer' },
    { authorization: 'Bearer amp_first extra' }, { authorization: 'Bearer amp_firstx' },
    { authorization: 'Bearer a' }, { 'x-api-key': 'AMP_FIRST' },
    { authorization: 'Bearer admin-only' }, { authorization: 'Bearer amp_first, Bearer wrong' },
  ])('rejects missing, malformed or unconfigured credentials: %j', (headers) => {
    expect(authenticate(new Headers(headers as Record<string, string>), vault)).toBe(false);
  });

  it('rejects all vault credentials when no client tokens exist', () => {
    expect(authenticate(new Headers({ 'x-api-key': 'anything' }), { mode: 'vault', client_tokens: [] })).toBe(false);
  });

  it('leaves passthrough authentication to the upstream', () => {
    expect(authenticate(new Headers(), { ...vault, mode: 'passthrough' })).toBe(true);
  });

  it('keeps management auth separate from client tokens and passthrough mode', () => {
    expect(authenticateAdmin(new Headers({ authorization: 'Bearer admin-only' }), vault)).toBe(true);
    expect(authenticateAdmin(new Headers({ 'x-api-key': 'admin-only' }), vault)).toBe(true);
    expect(authenticateAdmin(new Headers({ authorization: 'Bearer amp_first' }), vault)).toBe(false);
    expect(authenticateAdmin(new Headers(), { ...vault, mode: 'passthrough' })).toBe(false);
    expect(authenticateAdmin(new Headers({ 'x-api-key': 'amp_first' }), { mode: 'vault', client_tokens: ['amp_first'] })).toBe(false);
  });
});

describe('buildUpstreamHeaders', () => {
  it.each(['authorization', 'x-api-key', 'both'] as const)('replaces both client headers using upstream %s mode', (auth_header) => {
    const input = new Headers({ authorization: 'Bearer client-secret', 'x-api-key': 'client-secret', 'anthropic-beta': 'test-beta' });
    const output = buildUpstreamHeaders(input, { ...upstream, auth_header }, 'vault');
    expect(output.get('authorization')).toBe(auth_header === 'x-api-key' ? null : 'Bearer upstream-secret');
    expect(output.get('x-api-key')).toBe(auth_header === 'authorization' ? null : 'upstream-secret');
    expect(output.get('anthropic-beta')).toBe('test-beta');
    expect(input.get('authorization')).toBe('Bearer client-secret');
  });

  it('removes client credentials even if the upstream has no key', () => {
    const withoutKey: Config['upstreams'][string] = { base_url: upstream.base_url, auth_header: 'authorization', forward_safeguards: false, strip_beta: true };
    const output = buildUpstreamHeaders(new Headers({ authorization: 'Bearer client-secret', 'x-api-key': 'client-secret' }), withoutKey, 'vault');
    expect(output.has('authorization')).toBe(false);
    expect(output.has('x-api-key')).toBe(false);
  });

  it('applies extra headers before authoritative vault credentials', () => {
    const output = buildUpstreamHeaders(new Headers({ 'x-claude-code-test': 'keep' }), {
      ...upstream, extra_headers: { Authorization: 'Bearer wrong', 'X-API-Key': 'wrong', 'cf-aig-authorization': 'Bearer gateway', 'x-custom': 'configured' },
    }, 'vault');
    expect(output.get('authorization')).toBe('Bearer upstream-secret');
    expect(output.has('x-api-key')).toBe(false);
    expect(output.get('cf-aig-authorization')).toBe('Bearer gateway');
    expect(output.get('x-claude-code-test')).toBe('keep');
    expect(output.get('x-custom')).toBe('configured');
  });

  it('preserves passthrough credentials unchanged despite configured key and credential extras', () => {
    const input = new Headers({ authorization: 'Basic original', 'x-api-key': 'original-key', 'anthropic-version': '2023-06-01' });
    const output = buildUpstreamHeaders(input, {
      ...upstream, extra_headers: { Authorization: 'Bearer replacement', 'x-api-key': 'replacement', 'x-custom': 'configured' },
    }, 'passthrough');
    expect(output.get('authorization')).toBe('Basic original');
    expect(output.get('x-api-key')).toBe('original-key');
    expect(output.get('anthropic-version')).toBe('2023-06-01');
    expect(output.get('x-custom')).toBe('configured');
  });
});
