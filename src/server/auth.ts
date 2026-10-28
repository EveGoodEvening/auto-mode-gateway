import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config/schema.js';

function credentials(headers: Headers): string[] {
  const values: string[] = [];
  const bearer = /^Bearer[\t ]+(\S+)$/i.exec(headers.get('authorization') ?? '');
  if (bearer?.[1]) values.push(bearer[1]);
  const apiKey = headers.get('x-api-key');
  if (apiKey) values.push(apiKey);
  return values;
}

/** Fixed-size digests avoid length-dependent timingSafeEqual rejection. */
function matchesToken(headers: Headers, tokens: readonly string[]): boolean {
  const supplied = credentials(headers).map((value) => createHash('sha256').update(value).digest());
  let matched = 0;
  for (const token of tokens) {
    const expected = createHash('sha256').update(token).digest();
    for (const candidate of supplied) matched |= Number(timingSafeEqual(candidate, expected));
  }
  return matched !== 0;
}

export function authenticate(headers: Headers, auth: Config['auth']): boolean {
  return auth.mode === 'passthrough' || matchesToken(headers, auth.client_tokens);
}

/** Management credentials are deliberately independent from client credentials. */
export function authenticateAdmin(headers: Headers, auth: Config['auth']): boolean {
  return auth.admin_token !== undefined && matchesToken(headers, [auth.admin_token]);
}

/** Hop-by-hop filtering belongs to the transport, after configured headers are applied. */
export function buildUpstreamHeaders(
  headers: Headers,
  upstream: Config['upstreams'][string],
  authMode: Config['auth']['mode'],
): Headers {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(upstream.extra_headers ?? {})) {
    // Passthrough means configured extras cannot replace the client's credentials.
    if (authMode === 'passthrough' && ['authorization', 'x-api-key'].includes(name.toLowerCase())) continue;
    result.set(name, value);
  }
  if (authMode === 'vault') {
    result.delete('authorization');
    result.delete('x-api-key');
    if (upstream.api_key !== undefined) {
      if (upstream.auth_header === 'authorization' || upstream.auth_header === 'both') {
        result.set('authorization', `Bearer ${upstream.api_key}`);
      }
      if (upstream.auth_header === 'x-api-key' || upstream.auth_header === 'both') {
        result.set('x-api-key', upstream.api_key);
      }
    }
  }
  return result;
}
