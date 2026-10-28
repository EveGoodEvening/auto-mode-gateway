import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import {
  isClassifierRequest, isSuspectedClassifierRequest, prepareClassifierTarget,
} from '../../src/protocols/anthropic/classifier-fingerprint.js';

const prefix = 'You are a security monitor for autonomous AI coding agents';
function request(model = 'claude-haiku-5-5') {
  return {
    model,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.311', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${prefix}\nSource prompt`, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inert classifier fixture' }] }],
    metadata: { user_id: 'fixture-attribution' },
    stop_sequences: ['</block>', '</severity>'],
    thinking: { type: 'enabled', budget_tokens: 1024 },
    cache_control: { type: 'ephemeral' },
    max_tokens: 100,
    stream: true,
  };
}
function config(base_url = 'https://openrouter.ai/api/v1'): Pick<Config, 'classifier_reroute' | 'decision'> {
  return {
    classifier_reroute: { enabled: true, provider: 'second_stage' },
    decision: {
      chain: ['fixture'], providers: {},
      second_stage: { kind: 'anthropic-messages', base_url, api_key: 'trusted-fixture-key', model: 'unused-stage-model' },
    },
  };
}
function prepare(body: unknown = request(), settings = config(), headers = new Headers()) {
  const prepared = prepareClassifierTarget(body, headers, settings);
  if (!prepared) throw new Error('Expected a prepared trusted target');
  return { ...prepared, json: JSON.parse(new TextDecoder().decode(prepared.body)) as Record<string, unknown> };
}

describe('actual Claude classifier source fingerprint', () => {
  it('matches any system text block, preserving attribution before the actual prefix', () => {
    expect(isClassifierRequest(request())).toBe(true);
    expect(isClassifierRequest({ system: [{ type: 'text', text: prefix }] })).toBe(true);
    expect(isClassifierRequest({ ...request(), tools: [] })).toBe(true);
  });

  it.each([null, undefined, {}, 'tools', [{ name: 'Bash' }]])('rejects nonempty or malformed tools: %j', (tools) => {
    expect(isClassifierRequest({ ...request(), tools })).toBe(false);
    expect(isSuspectedClassifierRequest({ ...request(), tools })).toBe(false);
  });

  it.each([
    null, {}, { system: prefix }, { system: [{ text: prefix }] },
    { system: [{ type: 'image', text: prefix }] },
    { system: [{ type: 'text', text: ` ${prefix}` }] },
    { system: [{ type: 'text', text: `preamble\n${prefix}` }] },
    { system: [{ type: 'text', text: prefix.toLowerCase() }] },
  ])('does not broaden the source fingerprint: %j', (body) => {
    expect(isClassifierRequest(body)).toBe(false);
  });

  it('reports only unmatched no-tools exact stop-sequence signals as suspected', () => {
    expect(isSuspectedClassifierRequest(request())).toBe(false);
    for (const signal of ['</block>', '</severity>']) {
      expect(isSuspectedClassifierRequest({ system: 'changed source', stop_sequences: [signal] })).toBe(true);
      expect(isSuspectedClassifierRequest({ tools: [], system: 'changed source', stop_sequences: [signal] })).toBe(true);
    }
    expect(isSuspectedClassifierRequest({ stop_sequences: ['prefix</block>', '</severity>suffix'] })).toBe(false);
    expect(isSuspectedClassifierRequest({ stop_sequences: '</block>' })).toBe(false);
  });
});

describe('trusted classifier target preparation', () => {
  it('leaves disabled actual classifiers and suspected/nonmatching requests on the relay', () => {
    const settings = config('not-a-valid-target');
    settings.classifier_reroute.enabled = false;
    expect(prepareClassifierTarget(request(), new Headers(), settings)).toBeUndefined();
    settings.classifier_reroute.enabled = true;
    expect(prepareClassifierTarget({ stop_sequences: ['</block>'] }, new Headers(), settings)).toBeUndefined();
    expect(prepareClassifierTarget({ ...request(), tools: [{ name: 'Bash' }] }, new Headers(), settings)).toBeUndefined();
  });

  it('reroutes exact classifiers with tools:[] while preserving the empty tools field', () => {
    const result = prepare({ ...request(), tools: [] });
    expect(result.json.tools).toEqual([]);
    expect(result.url.href).toBe('https://openrouter.ai/api/v1/messages');
    expect(result.json.model).toBe('anthropic/claude-haiku-5.5');
    expect(result.headers.get('authorization')).toBe('Bearer trusted-fixture-key');
  });

  it.each([
    ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5'],
    ['claude-sonnet-5', 'anthropic/claude-sonnet-5'],
    ['claude-opus-4-6', 'anthropic/claude-opus-4.6'],
    ['claude-sonnet-4-5-20250929', 'anthropic/claude-sonnet-4.5-20250929'],
    ['claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4-20250514'],
    ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5'],
  ])('maps source model %s to %s', (source, expected) => {
    expect(prepare(request(source)).json.model).toBe(expected);
  });

  it('preserves every source field except model and routing pin without mutating its inputs', () => {
    const body = request();
    const snapshot = structuredClone(body);
    const settings = config();
    const result = prepare(body, settings);
    const rest = { ...result.json };
    delete rest.model;
    delete rest.provider;
    const source: Record<string, unknown> = { ...body };
    delete source.model;
    expect(rest).toEqual(source);
    expect(body).toEqual(snapshot);
    expect(settings.decision.second_stage?.model).toBe('unused-stage-model');
    expect(result.url.href).toBe('https://openrouter.ai/api/v1/messages');
  });

  it('enforces OpenRouter first-party pin against source and configured fallback weakening', () => {
    const settings = config();
    settings.decision.second_stage!.pin = { provider: { only: ['untrusted'], allow_fallbacks: true, sort: 'latency' } };
    const result = prepare({ ...request(), provider: { only: ['untrusted'], allow_fallbacks: true, data_collection: 'deny' } }, settings);
    expect(result.json.provider).toEqual({ only: ['anthropic'], allow_fallbacks: false, sort: 'latency', data_collection: 'deny' });
  });

  it.each(['https://ai-gateway.vercel.sh', 'https://ai-gateway.vercel.sh/v1/'])('pins Vercel first-party routing for %s', (base) => {
    const settings = config(base);
    settings.decision.second_stage!.pin = { providerOptions: { gateway: { only: ['untrusted'], order: ['untrusted'] } } };
    const result = prepare({ ...request(), providerOptions: { gateway: { only: ['untrusted'] }, other: { value: true } } }, settings);
    expect(result.url.href).toBe('https://ai-gateway.vercel.sh/v1/messages');
    expect(result.json.model).toBe('anthropic/claude-haiku-5.5');
    expect(result.json.providerOptions).toEqual({ gateway: { only: ['anthropic'], order: ['untrusted'] }, other: { value: true } });
    expect(result.headers.get('authorization')).toBe('Bearer trusted-fixture-key');
  });

  it('replaces all incoming credentials with only trusted target authentication', () => {
    const headers = new Headers({
      authorization: 'Bearer relay-secret', 'x-api-key': 'client-secret', 'api-key': 'other-secret',
      'proxy-authorization': 'proxy-secret', cookie: 'private-session', 'x-relay-secret': 'custom-secret',
      'cf-aig-authorization': 'Bearer cloudflare-relay-secret',
      'anthropic-beta': 'dangerous-tool-use-2026-09-03,other-beta',
      'anthropic-version': '2023-06-01', 'content-length': '999', host: 'relay.example',
    });
    const original = [...headers];
    const settings = config();
    settings.decision.second_stage!.headers = { 'x-api-key': 'wrong-scheme-secret', 'x-trusted-extension': 'retained' };
    const result = prepare(request(), settings, headers);
    expect(result.headers.get('authorization')).toBe('Bearer trusted-fixture-key');
    for (const name of ['x-api-key', 'api-key', 'proxy-authorization', 'cookie', 'cf-aig-authorization', 'x-relay-secret', 'content-length', 'host']) {
      expect(result.headers.has(name)).toBe(false);
    }
    expect(result.headers.get('x-trusted-extension')).toBe('retained');
    expect(result.headers.get('anthropic-beta')).toBe(headers.get('anthropic-beta'));
    expect(JSON.stringify([...result.headers])).not.toContain('relay-secret');
    expect([...headers]).toEqual(original);
  });

  it('uses native Anthropic x-api-key and bare source model, not the second-stage configured model', () => {
    const result = prepare(request(), config('https://api.anthropic.com'));
    expect(result.url.href).toBe('https://api.anthropic.com/v1/messages');
    expect(result.json.model).toBe('claude-haiku-5-5');
    expect(result.headers.get('x-api-key')).toBe('trusted-fixture-key');
    expect(result.headers.has('authorization')).toBe(false);
  });

  it('uses Cloudflare bare model and cf-aig auth without original provider credentials', () => {
    const settings = config('https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic');
    settings.decision.second_stage!.headers = { 'cf-aig-gateway-id': 'gateway', authorization: 'Bearer wrong', 'x-api-key': 'wrong' };
    const result = prepare(request(), settings, new Headers({ authorization: 'Bearer relay' }));
    expect(result.url.href).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages');
    expect(result.json.model).toBe('claude-haiku-5-5');
    expect(result.headers.get('cf-aig-authorization')).toBe('Bearer trusted-fixture-key');
    expect(result.headers.get('cf-aig-gateway-id')).toBe('gateway');
    expect(result.headers.has('authorization')).toBe(false);
    expect(result.headers.has('x-api-key')).toBe(false);
  });

  it('honors explicit mappings without bypassing known target namespace validation', () => {
    const settings = config();
    settings.classifier_reroute.model_map = { 'claude-haiku-5-5': 'anthropic/claude-sonnet-5' };
    expect(prepare(request(), settings).json.model).toBe('anthropic/claude-sonnet-5');
    settings.classifier_reroute.model_map['claude-haiku-5-5'] = 'other/model';
    expect(() => prepare(request(), settings)).toThrow('Anthropic Claude model slug');
    settings.decision.second_stage!.base_url = 'https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic';
    expect(() => prepare(request(), settings)).toThrow('bare Claude model ID');
  });

  it('requires an exact own explicit model mapping for unknown configured gateway hosts', () => {
    const settings = config('http://127.0.0.1:9999/trusted');
    expect(() => prepare(request(), settings)).toThrow('explicit model_map');
    settings.classifier_reroute.model_map = { 'claude-haiku-5-5': 'fixture-model' };
    const result = prepare(request(), settings);
    expect(result.url.href).toBe('http://127.0.0.1:9999/trusted/messages');
    expect(result.json.model).toBe('fixture-model');
    expect(result.headers.get('authorization')).toBe('Bearer trusted-fixture-key');
    settings.classifier_reroute.model_map = Object.create({ 'claude-haiku-5-5': 'inherited' }) as Record<string, string>;
    expect(() => prepare(request(), settings)).toThrow('explicit model_map');
  });

  it.each([
    'https://openrouter.ai/wrong', 'https://ai-gateway.vercel.sh/api/v1',
    'https://api.anthropic.com/relay', 'https://gateway.ai.cloudflare.com/v1/account/gateway/compat',
    'http://openrouter.ai/api/v1', 'https://openrouter.ai:9999/api/v1',
    'https://key@openrouter.ai/api/v1', 'https://openrouter.ai/api/v1?key=secret',
    'https://openrouter.ai/api/v1#fragment', 'file:///tmp/classifier',
  ])('rejects invalid trusted URL family even with explicit mapping: %s', (base) => {
    const settings = config(base);
    settings.classifier_reroute.model_map = { 'claude-haiku-5-5': 'anthropic/claude-haiku-5.5' };
    expect(() => prepare(request(), settings)).toThrow();
  });

  it('does not infer known-provider trust from a hostname substring', () => {
    const settings = config('https://openrouter.ai.attacker.test/api/v1');
    expect(() => prepare(request(), settings)).toThrow('explicit model_map');
  });

  it('throws on enabled missing provider or unmappable model rather than returning relay fallback', () => {
    const settings = config();
    delete settings.decision.second_stage;
    expect(() => prepare(request(), settings)).toThrow('not configured');
    expect(() => prepare(request('unknown-model'))).toThrow('model slug');
    expect(() => prepare({ ...request(), model: null })).toThrow('no model');
  });
});
