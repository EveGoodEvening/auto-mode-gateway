import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { DEFAULT_AUDIT_PATH, DEFAULT_CONFIG_PATH } from '../../src/config/defaults.js';
import { loadConfig, parseConfig } from '../../src/config/load.js';

function minimalConfig() {
  return {
    routes: [{ prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay' }],
    upstreams: { relay: { base_url: 'https://relay.example', api_key: '${RELAY_KEY}' } },
    decision: {
      chain: ['trusted'],
      providers: {
        trusted: {
          kind: 'systemone', base_url: 'https://trusted.example', api_key: '${DECISION_KEY}', model: 'test-model',
        },
      },
    },
  };
}

const env = { RELAY_KEY: 'disposable-relay', DECISION_KEY: 'disposable-decision' };
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('parseConfig', () => {
  it('applies defaults while preserving native YAML booleans, numbers and strings', () => {
    const config = parseConfig(stringify(minimalConfig()), env);
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 8484 });
    expect(config.gate).toEqual({ mode: 'enforce', on_provider_failure: 'block', hold_keepalive_ms: 5000, provider_timeout_ms: 5000 });
    expect(config.auth).toEqual({ mode: 'vault', client_tokens: [] });
    expect(config.audit).toEqual({ path: DEFAULT_AUDIT_PATH, redact: true });
    expect(config.upstreams.relay?.forward_safeguards).toBe(false);
    expect(config.routes[0]?.claude_delivery).toBe('auto');
    expect(config.upstreams.relay?.api_key).toBe('disposable-relay');
  });

  it('reports a missing environment variable at its exact key path, never another secret', () => {
    expect(() => parseConfig(stringify(minimalConfig()), { RELAY_KEY: 'SECRET_DO_NOT_PRINT' }))
      .toThrow('Missing environment variable DECISION_KEY at decision.providers.trusted.api_key');
    try {
      parseConfig(stringify(minimalConfig()), { RELAY_KEY: 'SECRET_DO_NOT_PRINT' });
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_DO_NOT_PRINT');
    }
  });

  it('reports missing variables in nested arrays with an index', () => {
    const input = { ...minimalConfig(), routes: [{ ...minimalConfig().routes[0], project_dirs: ['${MISSING_PROJECT}'] }] };
    expect(() => parseConfig(stringify(input), env)).toThrow('routes[0].project_dirs[0]');
  });

  it('rejects passthrough on a public listener with a key path', () => {
    const input = { ...minimalConfig(), listen: { host: '0.0.0.0' }, auth: { mode: 'passthrough' } };
    expect(() => parseConfig(stringify(input), env)).toThrow(/auth\.mode|listen\.host/);
  });

  it('rejects an unknown protocol with its key path and without echoing the value', () => {
    const input = minimalConfig();
    input.routes[0]!.protocol = 'SECRET_INVALID_PROTOCOL';
    expect(() => parseConfig(stringify(input), env)).toThrow('routes[0].protocol');
    try {
      parseConfig(stringify(input), env);
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_INVALID_PROTOCOL');
    }
  });

  it('treats multiline, quote, colon and alias syntax in env values as inert strings', () => {
    const secret = 'quoted: "value"\nlisten:\n  host: 0.0.0.0\n---\n&anchor *alias ${UNSET}';
    const config = parseConfig(stringify(minimalConfig()), { ...env, RELAY_KEY: secret });
    expect(config.upstreams.relay?.api_key).toBe(secret);
    expect(config.listen.host).toBe('127.0.0.1');
  });

  it('interpolates repeated and embedded references once, without coercing strings', () => {
    const input = minimalConfig();
    input.decision.providers.trusted.model = '${PREFIX}-${SUFFIX}-${PREFIX}';
    const config = parseConfig(stringify(input), { ...env, PREFIX: 'false', SUFFIX: '123' });
    expect(config.decision.providers.trusted?.model).toBe('false-123-false');
    expect(() => parseConfig(stringify({ ...input, listen: { port: '${PORT}' } }), { ...env, PREFIX: 'x', SUFFIX: 'y', PORT: '8484' }))
      .toThrow('listen.port');
  });

  it('accepts an explicitly empty env value where the string field permits it', () => {
    const input = minimalConfig();
    const yaml = stringify({ ...input, upstreams: { relay: { ...input.upstreams.relay, extra_headers: { 'x-empty': '${EMPTY}' } } } });
    const config = parseConfig(yaml, { ...env, EMPTY: '' });
    expect(config.upstreams.relay?.extra_headers?.['x-empty']).toBe('');
  });

  it('does not read inherited environment properties', () => {
    const inherited = Object.create(env) as NodeJS.ProcessEnv;
    expect(() => parseConfig(stringify(minimalConfig()), inherited)).toThrow('RELAY_KEY');
  });

  it('uses process.env when env is omitted', () => {
    vi.stubEnv('RELAY_KEY', env.RELAY_KEY);
    vi.stubEnv('DECISION_KEY', env.DECISION_KEY);
    expect(parseConfig(stringify(minimalConfig())).upstreams.relay?.api_key).toBe(env.RELAY_KEY);
  });

  it.each([
    'upstreams: [SECRET_YAML',
    'listen: {}\nlisten: {}\n# SECRET_YAML',
    '---\nlisten: {}\n---\nauth: {}\n# SECRET_YAML',
    'value: !unknown SECRET_YAML',
  ])('sanitizes malformed, duplicate, multi-document and unsupported-tag YAML', (yaml) => {
    expect(() => parseConfig(yaml, {})).toThrow('Invalid YAML at $');
    try {
      parseConfig(yaml, {});
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_YAML');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('rejects cyclic aliases without overflowing the stack', () => {
    expect(() => parseConfig('loop: &loop [*loop]', {})).toThrow(/Invalid YAML at .*cyclic alias/);
  });

  it('rejects YAML alias expansion beyond the parser limit without exposing source', () => {
    const yaml = 'a: &a [SECRET_ALIAS, SECRET_ALIAS]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]';
    expect(() => parseConfig(yaml, {})).toThrow('Invalid YAML at $');
  });

  it.each(['', 'null', '[]', '42', 'false'])('rejects a non-object root with a root key path', (yaml) => {
    expect(() => parseConfig(yaml, {})).toThrow('Invalid configuration at $');
  });
});

describe('loadConfig', () => {
  it('loads the complete deployment example using only disposable explicit env values', async () => {
    const example = await readFile(new URL('../../deploy/config.example.yaml', import.meta.url), 'utf8');
    const exampleEnv = Object.fromEntries(
      [...example.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => [match[1], `disposable-${match[1]}`]),
    );
    const config = await loadConfig(new URL('../../deploy/config.example.yaml', import.meta.url).pathname, exampleEnv);
    expect(config.routes.map((route) => route.protocol)).toEqual(['anthropic-messages', 'openai-responses', 'openai-chat']);
    expect(config.decision.chain).toHaveLength(3);
    expect(config.classifier_reroute.enabled).toBe(true);
    expect(config.decision.second_stage?.pin).toEqual({ provider: { only: ['anthropic'], allow_fallbacks: false } });
    expect(config.upstreams['relay-a']?.api_key).toBe('disposable-RELAY_A_KEY');
    expect(config.decision.providers['clef-cf']?.base_url).toContain('disposable-CF_ACCOUNT_ID');
  });

  it('loads an explicit file and env without mutating env', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amp-config-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'config.yaml');
    await writeFile(path, stringify(minimalConfig()));
    const frozenEnv = Object.freeze({ ...env });
    expect((await loadConfig(path, frozenEnv)).upstreams.relay?.api_key).toBe(env.RELAY_KEY);
    expect(frozenEnv).toEqual(env);
  });

  it('sanitizes filesystem failures', async () => {
    await expect(loadConfig('/nonexistent/SECRET_PATH/config.yaml', {})).rejects.toThrow('Unable to read configuration file at $');
    await expect(loadConfig('/nonexistent/SECRET_PATH/config.yaml', {})).rejects.not.toThrow('SECRET_PATH');
  });

  it('exports the documented home-based default config path', () => {
    expect(DEFAULT_CONFIG_PATH).toMatch(/\/\.config\/auto-mode-proxy\/config\.yaml$/);
  });
});
