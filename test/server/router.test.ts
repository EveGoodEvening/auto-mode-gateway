import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { resolveRoute } from '../../src/server/router.js';

function fixture() {
  return configSchema.parse({
    routes: [
      { prefix: '/cc', protocol: 'anthropic-messages', upstream: 'anthropic' },
      { prefix: '/cc/nested', protocol: 'openai-chat', upstream: 'chat' },
      { prefix: '/codex', protocol: 'openai-responses', upstream: 'responses' },
    ],
    upstreams: {
      anthropic: { base_url: 'https://anthropic.example' },
      chat: { base_url: 'https://chat.example' },
      responses: { base_url: 'https://responses.example' },
    },
    decision: { chain: ['test'], providers: {
      test: { kind: 'systemone', base_url: 'https://decision.example', api_key: 'disposable', model: 'test' },
    } },
  });
}

describe('resolveRoute', () => {
  it('chooses the longest segment prefix independent of declaration order', () => {
    const config = fixture();
    const result = resolveRoute(config, '/cc/nested/v1/chat/completions');
    expect(result?.route.upstream).toBe('chat');
    expect(result?.pathname).toBe('/v1/chat/completions');
    expect(result?.upstream).toBe(config.upstreams.chat);
    config.routes.reverse();
    expect(resolveRoute(config, '/cc/nested/v1/chat/completions')?.route.upstream).toBe('chat');
  });

  it.each(['/ccx/v1/messages', '/cc-nested', '/unknown', '/v1/messagesOther', '/v1/responses/other'])('does not invent a route for %s', (path) => {
    expect(resolveRoute(fixture(), path)).toBeUndefined();
  });

  it.each([
    ['/cc', '/'], ['/cc/', '/'], ['/cc/api/hello', '/api/hello'],
    ['/cc/v1/models', '/v1/models'], ['/cc/v1/messages/count_tokens', '/v1/messages/count_tokens'],
    ['/cc/a%2Fb//raw', '/a%2Fb//raw'],
  ])('strips only the matched prefix from %s', (path, upstreamPath) => {
    expect(resolveRoute(fixture(), path)?.pathname).toBe(upstreamPath);
  });

  it.each([
    ['/v1/messages', 'anthropic'], ['/v1/messages/count_tokens', 'anthropic'],
    ['/v1/responses', 'responses'], ['/v1/chat/completions', 'chat'],
  ])('infers a configured protocol upstream for %s without stripping bytes', (path, upstream) => {
    const result = resolveRoute(fixture(), path);
    expect(result?.route.upstream).toBe(upstream);
    expect(result?.pathname).toBe(path);
  });

  it('leaves unknown unprefixed paths unresolved without a root route', () => {
    expect(resolveRoute(fixture(), '/v1/models')).toBeUndefined();
  });

  it('uses a root route as the explicit fallback without stripping the leading slash', () => {
    const config = fixture();
    config.routes.push({ prefix: '/', protocol: 'anthropic-messages', upstream: 'anthropic', claude_delivery: 'auto' });
    expect(resolveRoute(config, '/api/hello')?.pathname).toBe('/api/hello');
    expect(resolveRoute(config, '/v1/responses')?.route.upstream).toBe('anthropic');
    expect(resolveRoute(config, '/cc/nested/a')?.route.upstream).toBe('chat');
  });

  it('does not infer a protocol absent from configuration', () => {
    const config = fixture();
    config.routes = config.routes.filter((route) => route.protocol !== 'openai-responses');
    expect(resolveRoute(config, '/v1/responses')).toBeUndefined();
  });
});
