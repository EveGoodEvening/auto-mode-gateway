import { describe, expect, it } from 'vitest';

import { configSchema } from '../../src/config/schema.js';

function validInput() {
  return {
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }],
    upstreams: { relay: { base_url: 'https://relay.example', api_key: 'disposable-relay' } },
    decision: {
      chain: ['trusted'],
      providers: {
        trusted: { kind: 'systemone', base_url: 'https://trusted.example', api_key: 'disposable-key', model: 'test-model' },
      },
    },
  };
}

function expectIssue(input: unknown, path: (string | number)[]) {
  const result = configSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected schema rejection');
  expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
}

describe('configuration defaults and supported shapes', () => {
  it('provides policy, safety, transport and optional-price defaults without inventing prices', () => {
    const result = configSchema.parse(validInput());
    expect(result.policy).toEqual({
      thresholds: { risk_block: 0.7, risk_allow: 0.3, intent_mismatch: 0.3, intent_risk: 0.5, outside_scope_allow: 0.5 },
      readonly_allow_extra: [], hard_deny_extra: [], sensitive_paths_extra: [],
    });
    expect(result.classifier_reroute).toEqual({ enabled: false, provider: 'second_stage' });
    expect(result.limits).toEqual({ request_body_bytes: 64000000, upstream_connect_timeout_ms: 10000, upstream_read_timeout_ms: 30000 });
    expect(result.trust_proxy).toBe(false);
    expect(result.log_level).toBe('info');
    expect(result.upstreams.relay?.auth_header).toBe('authorization');
    expect(result.upstreams.relay?.forward_safeguards).toBe(false);
    expect(result.upstreams.relay?.strip_beta).toBe(true);
    expect(result.routes[0]?.claude_delivery).toBe('auto');
    expect(result.routes[0]?.claude_delivery_by_version).toBeUndefined();
    expect(result.decision.providers.trusted?.envelope).toBe('none');
    expect(result.decision.providers.trusted?.pricing).toBeUndefined();
  });

  it('accepts all protocols, action mappings, delivery overrides and provider kinds', () => {
    const input = validInput();
    const result = configSchema.parse({
      ...input,
      routes: [
        { ...input.routes[0], claude_delivery: 'native', claude_delivery_by_version: { '2.1.311': 'rewrite' } },
        { prefix: '/codex', protocol: 'openai-responses', upstream: 'relay', claude_delivery: 'rewrite' },
        { prefix: '/workbuddy', protocol: 'openai-chat', upstream: 'relay', project_dirs: ['/project'], tool_map: {
          shell: { kind: 'command', arg: 'cmd' }, write: 'file_write', fetch: 'url', remote: 'mcp', status: 'other',
        } },
      ],
      decision: {
        ...input.decision,
        providers: { trusted: { ...input.decision.providers.trusted, kind: 'openai-decisions', pricing: { input_usd_per_million: 0, output_usd_per_million: 2 }, body_extra: { nested: [true, 1, null, 'text'] } } },
        second_stage: { base_url: 'https://trusted.example', api_key: 'key', pin: { provider: { only: ['anthropic'], allow_fallbacks: false } } },
      },
      classifier_reroute: { enabled: true, provider: 'second_stage', model_map: { 'claude-haiku-5-5': 'anthropic/claude-haiku-5.5' } },
      gate: { mode: 'shadow', on_provider_failure: 'allow' },
    });
    expect(result.routes[2]?.tool_map?.status).toBe('other');
    expect(result.decision.second_stage?.model).toBe('anthropic/claude-haiku-5.5');
    expect(result.decision.providers.trusted?.pricing?.input_usd_per_million).toBe(0);
  });

  it.each([
    { forward_safeguards: false, strip_beta: false },
    { forward_safeguards: false, strip_beta: true },
    { forward_safeguards: true, strip_beta: false },
    { forward_safeguards: true, strip_beta: true },
  ])('keeps safeguards forwarding and beta stripping independent: %j', (options) => {
    const input = validInput();
    const config = configSchema.parse({
      ...input,
      upstreams: { relay: { ...input.upstreams.relay, ...options } },
    });
    expect(config.upstreams.relay).toMatchObject(options);
  });

  it.each([false, true])('defaults to beta stripping with forward_safeguards=%s', (forward_safeguards) => {
    const input = validInput();
    const config = configSchema.parse({
      ...input,
      upstreams: { relay: { ...input.upstreams.relay, forward_safeguards } },
    });
    expect(config.upstreams.relay?.forward_safeguards).toBe(forward_safeguards);
    expect(config.upstreams.relay?.strip_beta).toBe(true);
  });

  it.each(['auto', 'native', 'rewrite'])('accepts explicit delivery selector %s without changing exact overrides', (claude_delivery) => {
    const input = validInput();
    const claude_delivery_by_version = { '2.1.311': 'native', '2.1.312': 'rewrite' };
    const config = configSchema.parse({
      ...input,
      routes: [{ ...input.routes[0], claude_delivery, claude_delivery_by_version }],
    });
    expect(config.routes[0]?.claude_delivery).toBe(claude_delivery);
    expect(config.routes[0]?.claude_delivery_by_version).toEqual(claude_delivery_by_version);
  });

  it.each([
    { provider: { only: ['anthropic'], allow_fallbacks: false } },
    { providerOptions: { gateway: { only: ['anthropic'] } } },
  ])('accepts trusted classifier target pin shape %j', (pin) => {
    const input = validInput();
    const config = configSchema.parse({
      ...input,
      decision: {
        ...input.decision,
        second_stage: { base_url: 'https://trusted.example', api_key: 'disposable-classifier', pin },
      },
      classifier_reroute: { enabled: true, provider: 'second_stage' },
    });
    expect(config.classifier_reroute).toEqual({ enabled: true, provider: 'second_stage' });
    expect(config.decision.second_stage?.pin).toEqual(pin);
  });

  it('fills defaults inside partially specified sections', () => {
    const config = configSchema.parse({ ...validInput(), listen: { port: 1 }, gate: { provider_timeout_ms: 1 }, policy: { thresholds: { risk_block: 1 } } });
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 1 });
    expect(config.gate.hold_keepalive_ms).toBe(5000);
    expect(config.policy.thresholds.risk_allow).toBe(0.3);
  });
});

describe('listener and credential safety', () => {
  it.each(['127.0.0.1', '127.12.34.56', '::1', '0:0:0:0:0:0:0:1'])('permits passthrough only for numeric loopback %s', (host) => {
    expect(configSchema.safeParse({ ...validInput(), listen: { host }, auth: { mode: 'passthrough' } }).success).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.2', '::ffff:127.0.0.1'])('rejects public/noncanonical loopback passthrough %s even with a token', (host) => {
    expectIssue({ ...validInput(), listen: { host }, auth: { mode: 'passthrough', client_tokens: ['disposable'] } }, ['auth', 'mode']);
  });

  it.each(['localhost', 'loopback.example', '127.1', '127.0.0.999'])('does not treat a hostname or ambiguous address as loopback %s', (host) => {
    expectIssue({ ...validInput(), listen: { host }, auth: { mode: 'passthrough', client_tokens: ['client'] } }, ['auth', 'mode']);
    expectIssue({ ...validInput(), listen: { host } }, ['auth', 'client_tokens']);
  });

  it('accepts normal hostname bindings in vault mode with client authentication', () => {
    expect(configSchema.safeParse({ ...validInput(), listen: { host: 'gateway.example' }, auth: { client_tokens: ['client'] } }).success).toBe(true);
  });

  it('requires client tokens independently of an admin token on a public listener', () => {
    expectIssue({ ...validInput(), listen: { host: '0.0.0.0' }, auth: { admin_token: 'admin' } }, ['auth', 'client_tokens']);
    expect(configSchema.safeParse({ ...validInput(), listen: { host: '::' }, auth: { client_tokens: ['client'] } }).success).toBe(true);
  });

  it('rejects empty and duplicate client tokens and disabled audit redaction', () => {
    expectIssue({ ...validInput(), auth: { client_tokens: [''] } }, ['auth', 'client_tokens', 0]);
    expectIssue({ ...validInput(), auth: { client_tokens: ['same', 'same'] } }, ['auth', 'client_tokens', 1]);
    expectIssue({ ...validInput(), audit: { redact: false } }, ['audit', 'redact']);
  });
});

describe('routing and reference integrity', () => {
  it.each(['relative', '/cc/', '/cc//tools', '/cc/../tools', '/cc?x=1', '/cc#x', '/%63c'])('rejects ambiguous prefix %s', (prefix) => {
    expectIssue({ ...validInput(), routes: [{ ...validInput().routes[0], prefix }] }, ['routes', 0, 'prefix']);
  });

  it('accepts root and nested prefixes for the same upstream', () => {
    const route = validInput().routes[0];
    expect(configSchema.safeParse({ ...validInput(), routes: [{ ...route, prefix: '/' }, { ...route, prefix: '/cc' }, { ...route, prefix: '/cc/nested' }] }).success).toBe(true);
  });

  it('rejects duplicate prefixes, unresolved upstreams and ambiguous no-prefix inference', () => {
    const input = validInput();
    expectIssue({ ...input, routes: [...input.routes, ...input.routes] }, ['routes', 1, 'prefix']);
    expectIssue({ ...input, routes: [{ ...input.routes[0], upstream: 'missing' }] }, ['routes', 0, 'upstream']);
    expectIssue({ ...input, upstreams: { ...input.upstreams, second: input.upstreams.relay }, routes: [...input.routes, { ...input.routes[0], prefix: '/other', upstream: 'second' }] }, ['routes', 1, 'upstream']);
  });

  it('rejects empty and unresolved or duplicate decision chains', () => {
    const input = validInput();
    expectIssue({ ...input, decision: { ...input.decision, chain: [] } }, ['decision', 'chain']);
    expectIssue({ ...input, decision: { ...input.decision, chain: ['missing'] } }, ['decision', 'chain', 0]);
    expectIssue({ ...input, decision: { ...input.decision, chain: ['trusted', 'trusted'] } }, ['decision', 'chain', 1]);
    expectIssue({ ...input, decision: { ...input.decision, providers: {} } }, ['decision', 'chain', 0]);
  });

  it('requires an Anthropic-compatible second stage for enabled rerouting', () => {
    expectIssue({ ...validInput(), classifier_reroute: { enabled: true } }, ['classifier_reroute', 'provider']);
    expectIssue({ ...validInput(), classifier_reroute: { enabled: true, provider: 'trusted' } }, ['classifier_reroute', 'provider']);
  });

  it.each(['*', '2.x', '>=2.1.311'])('rejects wildcard/range version override %s', (version) => {
    expect(configSchema.safeParse({ ...validInput(), routes: [{ ...validInput().routes[0], claude_delivery_by_version: { [version]: 'native' } }] }).success).toBe(false);
  });

  it('rejects unknown delivery modes and auto as an exact-version override', () => {
    const input = validInput();
    expectIssue({ ...input, routes: [{ ...input.routes[0], claude_delivery: 'automatic' }] }, ['routes', 0, 'claude_delivery']);
    expectIssue({ ...input, routes: [{ ...input.routes[0], claude_delivery_by_version: { '2.1.311': 'auto' } }] }, ['routes', 0, 'claude_delivery_by_version', '2.1.311']);
  });
});

describe('numeric, URL and strict object boundaries', () => {
  it.each([1, 65535])('accepts port boundary %i', (port) => {
    expect(configSchema.safeParse({ ...validInput(), listen: { port } }).success).toBe(true);
  });
  it.each([0, 65536, 1.5, '8484', Number.NaN, Infinity])('rejects invalid port %s without coercion', (port) => {
    expectIssue({ ...validInput(), listen: { port } }, ['listen', 'port']);
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe integer timeout/limit %s', (value) => {
    expectIssue({ ...validInput(), gate: { provider_timeout_ms: value } }, ['gate', 'provider_timeout_ms']);
    expectIssue({ ...validInput(), limits: { request_body_bytes: value } }, ['limits', 'request_body_bytes']);
  });

  it.each([-0.001, 1.001, Number.NaN, Infinity])('rejects probability outside finite [0,1]: %s', (value) => {
    expectIssue({ ...validInput(), policy: { thresholds: { intent_mismatch: value } } }, ['policy', 'thresholds', 'intent_mismatch']);
  });

  it('accepts probability endpoints and rejects inverted allow/block thresholds', () => {
    expect(configSchema.safeParse({ ...validInput(), policy: { thresholds: { risk_allow: 0, risk_block: 1, intent_mismatch: 0, intent_risk: 1, outside_scope_allow: 1 } } }).success).toBe(true);
    expectIssue({ ...validInput(), policy: { thresholds: { risk_allow: 0.7, risk_block: 0.7 } } }, ['policy', 'thresholds', 'risk_allow']);
  });

  it.each(['false', 'true', 0, 1, null])('requires actual independent booleans for forwarding and beta options: %s', (value) => {
    const input = validInput();
    expectIssue({ ...input, upstreams: { relay: { ...input.upstreams.relay, forward_safeguards: value } } }, ['upstreams', 'relay', 'forward_safeguards']);
    expectIssue({ ...input, upstreams: { relay: { ...input.upstreams.relay, strip_beta: value } } }, ['upstreams', 'relay', 'strip_beta']);
  });

  it.each(['file:///tmp/key', 'ftp://relay.example', 'https://user:secret@relay.example', 'https://relay.example?key=secret', 'https://relay.example#secret'])('rejects unsafe endpoint %s', (base_url) => {
    expectIssue({ ...validInput(), upstreams: { relay: { base_url } } }, ['upstreams', 'relay', 'base_url']);
  });

  it('rejects header injection, negative prices, invalid regexes and unknown fields', () => {
    const input = validInput();
    expectIssue({ ...input, upstreams: { relay: { ...input.upstreams.relay, extra_headers: { 'x-test': 'value\r\nx-api-key: secret' } } } }, ['upstreams', 'relay', 'extra_headers', 'x-test']);
    expectIssue({ ...input, decision: { ...input.decision, providers: { trusted: { ...input.decision.providers.trusted, pricing: { input_usd_per_million: -1 } } } } }, ['decision', 'providers', 'trusted', 'pricing', 'input_usd_per_million']);
    expectIssue({ ...input, policy: { hard_deny_extra: ['['] } }, ['policy', 'hard_deny_extra', 0]);
    expectIssue({ ...input, gate: { mode: 'enforce', misspelled_security_setting: true } }, ['gate']);
    expectIssue({ ...input, misspelled_security_setting: true }, []);
  });

  it('rejects empty mandatory collections', () => {
    expectIssue({ ...validInput(), routes: [] }, ['routes']);
    expectIssue({ ...validInput(), upstreams: {} }, ['upstreams']);
  });

  it.each([
    { source: '[' }, { source: 'valid', flags: 'gg' },
    { source: 'valid', flags: 'z' }, { source: 'valid', flags: 'uv' },
    { source: 'valid', unknown: true },
  ])('rejects malformed RegexSpec %j in every regex replacement category', (pattern) => {
    for (const policy of [
      { hard_deny_patterns: [{ id: 'custom', pattern }] },
      { hard_deny_target_patterns: { root: pattern } },
      { redaction_patterns: [{ type: 'custom', pattern }] },
      { redaction_sensitive_keys: pattern },
    ]) expect(configSchema.safeParse({ ...validInput(), policy }).success).toBe(false);
  });

  it.each([
    { version: ' ' }, { questions: { unknown: {} } },
    { questions: { destructive: { type: 'noul' } } },
    { questions: { destructive: { criteria: { true: '' } } } },
    { questions: { destructive: { instructions: ' ' } } },
    { hard_deny_patterns: [{ id: '', pattern: { source: 'x' } }] },
    { redaction_patterns: [{ type: '', pattern: { source: 'x' } }] },
    { readonly_positional_limits: { uniq: -1 } },
    { readonly_positional_limits: { uniq: 1.5 } },
    { user_request_max_chars: 1001 }, { user_request_max_chars: 0 },
    { write_content_max_bytes: 2049 }, { write_content_max_bytes: 0 },
  ])('rejects invalid full-policy override %j', (policy) => {
    expect(configSchema.safeParse({ ...validInput(), policy }).success).toBe(false);
  });

  it('accepts full policy categories with strict partial question and regex shapes', () => {
    const policy = {
      version: 'reviewed-local', questions: { destructive: { criteria: { true: 'Locally destructive.' } } },
      readonly_programs: [], readonly_git_subcommands: [], shell_unsafe_programs: [], shell_interpreters: [],
      find_unsafe_arguments: [], git_unsafe_arguments: [], readonly_unsafe_arguments: { local: [] },
      readonly_positional_limits: { local: 0 }, download_programs: [], file_write_programs: [],
      inplace_write_programs: [], hard_deny_commands: [], hard_deny_patterns: [],
      hard_deny_target_patterns: { root: { source: '^/$', flags: 'i' } }, sensitive_path_globs: [],
      redaction_patterns: [], redaction_sensitive_keys: { source: '^custom$' },
      user_request_max_chars: 1, write_content_max_bytes: 1,
    };
    expect(configSchema.parse({ ...validInput(), policy }).policy).toMatchObject(policy);
  });
});
