import type { Config } from '../../config/schema.js';

const CLASSIFIER_PREFIX = 'You are a security monitor for autonomous AI coding agents';
type ObjectValue = Record<string, unknown>;
type TargetFamily = 'openrouter' | 'vercel' | 'cloudflare' | 'anthropic' | 'explicit';

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasNoTools(body: ObjectValue): boolean {
  return !Object.hasOwn(body, 'tools') || (Array.isArray(body.tools) && body.tools.length === 0);
}

/** Only absent or explicitly empty tools satisfy the source's no-tools condition. */
export function isClassifierRequest(body: unknown): boolean {
  return object(body) && hasNoTools(body) && Array.isArray(body.system)
    && body.system.some((block: unknown) => object(block) && block.type === 'text'
      && typeof block.text === 'string' && block.text.startsWith(CLASSIFIER_PREFIX));
}

export function isSuspectedClassifierRequest(body: unknown): boolean {
  return object(body) && hasNoTools(body) && !isClassifierRequest(body)
    && Array.isArray(body.stop_sequences)
    && body.stop_sequences.some((stop: unknown) => stop === '</block>' || stop === '</severity>');
}

export interface PreparedClassifierTarget {
  url: URL;
  headers: Headers;
  body: Uint8Array;
}

function target(base: string): { url: URL; family: TargetFamily } {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid trusted classifier target URL');
  }
  const path = url.pathname.replace(/\/+$/, '');
  let family: TargetFamily = 'explicit';
  let valid = true;
  switch (url.hostname) {
    case 'openrouter.ai': family = 'openrouter'; valid = path === '/api/v1'; break;
    case 'ai-gateway.vercel.sh': family = 'vercel'; valid = path === '' || path === '/v1'; break;
    case 'api.anthropic.com': family = 'anthropic'; valid = path === '' || path === '/v1'; break;
    case 'gateway.ai.cloudflare.com':
      family = 'cloudflare'; valid = /^\/v1\/[^/]+\/[^/]+\/anthropic$/.test(path); break;
  }
  if (!valid || (family !== 'explicit' && (url.protocol !== 'https:' || (url.port && url.port !== '443')))) {
    throw new Error('Invalid known-provider classifier URL family');
  }
  const prefix = (family === 'anthropic' || family === 'vercel') && path === '' ? '/v1' : path;
  url.pathname = `${prefix}${family === 'cloudflare' ? '/v1' : ''}/messages`;
  return { url, family };
}

function mapModel(model: unknown, family: TargetFamily, overrides: Record<string, string> | undefined): string {
  if (typeof model !== 'string' || !model) throw new Error('Classifier request has no model');
  const mapped = overrides && Object.hasOwn(overrides, model) ? overrides[model] : undefined;
  if (family === 'explicit') {
    if (!mapped?.trim()) throw new Error('Unknown classifier target requires an explicit model_map entry');
    return mapped;
  }
  const bare = /^claude-(?:sonnet|haiku|opus)-\d+(?:-\d+)?(?:-\d{8})?$/;
  const slug = /^anthropic\/claude-(?:sonnet|haiku|opus)-\d+(?:\.\d+)?(?:-\d{8})?$/;
  if (family === 'cloudflare' || family === 'anthropic') {
    const result = mapped ?? model;
    if (!bare.test(result)) throw new Error('Classifier target requires a bare Claude model ID');
    return result;
  }
  const result = mapped ?? (slug.test(model) ? model : model.replace(
    /^claude-(sonnet|haiku|opus)-(\d+)(?:-(\d{1,3}))?(-\d{8})?$/,
    (_match, name: string, major: string, minor: string | undefined, date: string | undefined) =>
      `anthropic/claude-${name}-${major}${minor ? `.${minor}` : ''}${date ?? ''}`,
  ));
  if (!slug.test(result)) throw new Error('Classifier target requires an Anthropic Claude model slug');
  return result;
}

/** Pure preparation: undefined means relay; any matched-target error must fail closed, not retry the relay. */
export function prepareClassifierTarget(
  body: unknown,
  incomingHeaders: Headers,
  config: Pick<Config, 'classifier_reroute' | 'decision'>,
): PreparedClassifierTarget | undefined {
  if (!config.classifier_reroute.enabled || !isClassifierRequest(body)) return undefined;
  if (!object(body)) return undefined;
  const provider = config.decision.second_stage;
  if (!provider) throw new Error('Trusted classifier provider is not configured');
  const { url, family } = target(provider.base_url);
  const model = mapModel(body.model, family, config.classifier_reroute.model_map);
  // Allowlist client protocol headers, never transport client/relay auth, cookies or arbitrary key headers.
  const headers = new Headers();
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta']) {
    const value = incomingHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers.set(name, value);
  // Even trusted extra headers cannot accidentally retain credentials for a different auth scheme.
  for (const name of ['authorization', 'x-api-key', 'api-key', 'proxy-authorization', 'cookie', 'cf-aig-authorization', 'host', 'content-length']) {
    headers.delete(name);
  }
  headers.set('content-type', 'application/json');
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  if (family === 'cloudflare') headers.set('cf-aig-authorization', `Bearer ${provider.api_key}`);
  else if (family === 'anthropic') headers.set('x-api-key', provider.api_key);
  else headers.set('authorization', `Bearer ${provider.api_key}`);

  // Only model/routing pin change. Nested source content is never normalized or reconstructed.
  const prepared: ObjectValue = { ...body, model };
  const pin = provider.pin ?? {};
  if (family === 'openrouter') {
    prepared.provider = {
      ...(object(body.provider) ? body.provider : {}),
      ...(object(pin.provider) ? pin.provider : {}),
      only: ['anthropic'], allow_fallbacks: false,
    };
  } else if (family === 'vercel') {
    const options = object(body.providerOptions) ? body.providerOptions : {};
    const pinned = object(pin.providerOptions) ? pin.providerOptions : {};
    prepared.providerOptions = {
      ...options, ...pinned,
      gateway: {
        ...(object(options.gateway) ? options.gateway : {}),
        ...(object(pinned.gateway) ? pinned.gateway : {}),
        only: ['anthropic'],
      },
    };
  } else {
    // Explicit/native targets may have trusted routing extensions, never replace source content.
    for (const key of ['provider', 'providerOptions']) {
      if (Object.hasOwn(pin, key)) prepared[key] = pin[key];
    }
  }
  return { url, headers, body: new TextEncoder().encode(JSON.stringify(prepared)) };
}
