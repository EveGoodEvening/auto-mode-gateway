import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { checkAgentSnippets, compareKeys, documentedKeys, emittedInit, fakeEnvironment, schemaKeys, validateConfigSnippet } from '../../scripts/check-docs.js';

const reference = (keys: string[]) => '<!-- config-schema:start -->\n' + keys.map((key) => `| \`${key}\` | field |`).join('\n') + '\n<!-- config-schema:end -->';

describe('documentation configuration contract', () => {
  it('retains optional union members, record values and nested array fields', () => {
    const schema = z.object({ routes: z.array(z.object({ map: z.record(z.string(), z.union([z.string(), z.object({ kind: z.string(), arg: z.string().optional() })])).optional() })) });
    expect(schemaKeys(schema)).toEqual(new Set(['routes', 'routes[]', 'routes[].map', 'routes[].map.*', 'routes[].map.*.kind', 'routes[].map.*.arg']));
  });

  it('treats arbitrary recursive JSON extensions as wildcard values rather than invented config descendants', () => {
    expect(schemaKeys(z.object({ extension: z.record(z.string(), z.json()).optional() }))).toEqual(new Set(['extension', 'extension.*']));
  });

  it('rejects omitted and invented documented input keys independently', () => {
    const expected = new Set(['routes', 'routes[].prefix']);
    expect(() => compareKeys(documentedKeys(reference(['routes'])), expected)).toThrow('missing routes[].prefix');
    expect(() => compareKeys(documentedKeys(reference(['routes', 'routes[].prefix', 'routes[].invented'])), expected)).toThrow('unknown routes[].invented');
    expect(() => documentedKeys(reference(['routes', 'routes']))).toThrow('duplicated');
  });

  it('projects fake values before interpolation, without copying ambient models or credentials', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'ambient-private-model');
    vi.stubEnv('RELAY_A_KEY', 'ambient-private-secret');
    vi.stubEnv('UNKNOWN_DOCUMENTATION_KEY', 'ambient-private-unknown');
    try {
      const text = 'api_key: ${RELAY_A_KEY}\nmodel: ${OPENROUTER_API_KEY}';
      expect(fakeEnvironment(text)).toEqual({ RELAY_A_KEY: 'documentation-fake-relay-a', OPENROUTER_API_KEY: 'documentation-fake-openrouter' });
      expect(Object.getPrototypeOf(fakeEnvironment(text))).toBeNull();
      const snippet = 'routes: [{prefix: /cc, protocol: anthropic-messages, upstream: relay}]\nupstreams: {relay: {base_url: https://example.invalid}}\ndecision:\n  chain: [trusted]\n  providers:\n    trusted: {kind: systemone, base_url: https://example.invalid, api_key: "${RELAY_A_KEY}", model: "${OPENROUTER_API_KEY}"}\n';
      validateConfigSnippet(snippet);
      expect(fakeEnvironment('${UNKNOWN_DOCUMENTATION_KEY}')).toEqual({});
      expect(() => validateConfigSnippet(snippet.replace('${RELAY_A_KEY}', '${UNKNOWN_DOCUMENTATION_KEY}'))).toThrow('Invalid documented configuration snippet');
      expect(() => validateConfigSnippet(snippet + 'unknown_private_field: ambient-private-secret\n')).toThrow('Invalid documented configuration snippet');
      try { validateConfigSnippet(snippet + 'unknown_private_field: ambient-private-secret\n'); } catch (error) {
        expect(String(error)).not.toContain('ambient-private-secret');
        expect(String(error)).not.toContain('ambient-private-model');
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('checks actual emitted init configuration and rejects a broken agent endpoint', async () => {
    const generated = await emittedInit();
    validateConfigSnippet(generated.config);
    const [claude, codex, workbuddy] = await Promise.all([
      readFile(new URL('../../docs/agents/claude-code.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/agents/codex.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/agents/workbuddy.md', import.meta.url), 'utf8'),
    ]);
    checkAgentSnippets(generated.output, { claude, codex, workbuddy });
    expect(() => checkAgentSnippets(generated.output, { claude, codex: codex.replace('/codex/v1', '/codex/v1/responses'), workbuddy })).toThrow('Codex guide differs');
    expect(generated.config.includes('${RELAY_A_KEY}')).toBe(true);
    expect(generated.output.includes('ambient-private-secret')).toBe(false);
  });

  const malformedEmissions: [string, (output: string) => string][] = [
    ['absent Claude start', (output) => output.replace('Claude Code CLI:', '')],
    ['renamed Claude start', (output) => output.replace('Claude Code CLI:', 'Changed Claude heading:')],
    ['absent Claude end', (output) => output.replace('Claude Desktop:', '')],
    ['renamed Claude end', (output) => output.replace('Claude Desktop:', 'Changed Desktop heading:')],
    ['duplicate Claude start', (output) => output.replace('Claude Code CLI:', 'Claude Code CLI:\nClaude Code CLI:')],
    ['duplicate Claude end', (output) => output + '\nClaude Desktop:\n'],
    ['reversed Claude boundaries', (output) => output.replace(/Claude Code CLI:|Claude Desktop:/g, (heading) => heading === 'Claude Code CLI:' ? 'Claude Desktop:' : 'Claude Code CLI:')],
    ['empty Claude section', (output) => output.replace(/Claude Code CLI:[\s\S]*?Claude Desktop:/, 'Claude Code CLI:\nClaude Desktop:')],
    ['renamed Codex section', (output) => output.replace('Codex CLI / Desktop (', 'Changed Codex section (')],
    ['renamed WorkBuddy section', (output) => output.replace('WorkBuddy (', 'Changed WorkBuddy section (')],
    ['absent Codex start declaration', (output) => output.replace('model_provider = "amp"\n', '')],
    ['absent Codex end marker', (output) => output.replace('# Codex classifier', '# Changed classifier')],
    ['duplicate Codex end marker', (output) => output + '\n# Codex classifier\n'],
    ['empty Codex section', (output) => output.replace(/model_provider = "amp"[\s\S]*?# Codex classifier/, '# Codex classifier')],
    ['duplicate Claude declaration', (output) => output.replace('export ANTHROPIC_API_KEY=""', 'export ANTHROPIC_API_KEY=""\nexport ANTHROPIC_API_KEY=""')],
    ['duplicate Codex declaration', (output) => output.replace('wire_api = "responses"', 'wire_api = "responses"\nwire_api = "responses"')],
    ['reordered Codex table boundary', (output) => output.replace('model_provider = "amp"\n\n[model_providers.amp]', '[model_providers.amp]\nmodel_provider = "amp"')],
  ];
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_GATEWAY_HINT_HEADERS', 'CLAUDE_CODE_AUTO_MODE_MODEL']) {
    malformedEmissions.push([`missing Claude ${key}`, (output) => output.replace(new RegExp(`^export ${key}=.*\\n`, 'm'), '')]);
  }
  for (const key of ['name', 'base_url', 'env_key', 'wire_api', 'supports_websockets']) {
    malformedEmissions.push([`missing Codex ${key}`, (output) => output.replace(new RegExp(`^${key} = .*\\n`, 'm'), '')]);
  }

  it.each(malformedEmissions)('rejects malformed actual init emission: %s', async (_name, mutate) => {
    const generated = await emittedInit();
    const [claude, codex, workbuddy] = await Promise.all([
      readFile(new URL('../../docs/agents/claude-code.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/agents/codex.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/agents/workbuddy.md', import.meta.url), 'utf8'),
    ]);
    let rejected = false;
    try { checkAgentSnippets(mutate(generated.output), { claude, codex, workbuddy }); } catch { rejected = true; }
    // Only a boolean can enter assertion diagnostics; emitted tokens stay private.
    expect(rejected).toBe(true);
  });
});
