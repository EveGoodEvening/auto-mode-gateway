import type { Config } from '../config/schema.js';

type Route = Config['routes'][number];

export interface ResolvedRoute {
  route: Route;
  upstream: Config['upstreams'][string];
  pathname: string;
}

function inferProtocol(pathname: string): Route['protocol'] | undefined {
  if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')) return 'anthropic-messages';
  if (pathname === '/v1/responses') return 'openai-responses';
  if (pathname === '/v1/chat/completions') return 'openai-chat';
  return undefined;
}

/** Explicit segment prefixes take precedence over prefix-free protocol inference. */
export function resolveRoute(config: Config, pathname: string): ResolvedRoute | undefined {
  let route: Route | undefined;
  for (const candidate of config.routes) {
    const matches = candidate.prefix === '/' || pathname === candidate.prefix
      || pathname.startsWith(`${candidate.prefix}/`);
    if (matches && (!route || candidate.prefix.length > route.prefix.length)) route = candidate;
  }
  let upstreamPath = pathname;
  if (route) {
    if (route.prefix !== '/') upstreamPath = pathname.slice(route.prefix.length) || '/';
  } else {
    const protocol = inferProtocol(pathname);
    if (!protocol) return undefined;
    // The config schema rejects different upstreams for the same inferred protocol.
    route = config.routes.find((candidate) => candidate.protocol === protocol);
  }
  if (!route) return undefined;
  const upstream = config.upstreams[route.upstream];
  if (!upstream) return undefined;
  return { route, upstream, pathname: upstreamPath };
}
