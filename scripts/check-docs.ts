import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { z } from 'zod';
import { configSchema } from '../src/config/schema.js';
import { parseConfig } from '../src/config/load.js';
import { registerInitCommand } from '../src/cli/init.js';

type JsonSchema = { $ref?: string; properties?: Record<string, JsonSchema>; additionalProperties?: boolean | JsonSchema; items?: JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[]; [key: string]: unknown };

/** Input schema, including optional/defaulted fields; arbitrary JSON remains one wildcard leaf. */
export function schemaKeys(schema: z.ZodType = configSchema): Set<string> {
  const root = z.toJSONSchema(schema, {
    io: 'input', unrepresentable: 'any',
    // z.json() is recursive arbitrary data, not additional configuration fields.
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodLazy) {
        for (const key of Object.keys(jsonSchema)) delete (jsonSchema as Record<string, unknown>)[key];
      }
    },
  }) as JsonSchema;
  const keys = new Set<string>();
  function visit(node: JsonSchema, path: string, ancestors: Set<JsonSchema>): void {
    if (ancestors.has(node)) return;
    const next = new Set(ancestors).add(node);
    if (node.$ref) {
      if (!node.$ref.startsWith('#/')) throw new Error('Unsupported external schema reference');
      let target: unknown = root;
      for (const segment of node.$ref.slice(2).split('/')) {
        target = (target as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      if (!target || typeof target !== 'object') throw new Error('Invalid schema reference');
      visit(target as JsonSchema, path, next);
      return;
    }
    for (const variants of [node.anyOf, node.oneOf, node.allOf]) {
      for (const variant of variants ?? []) visit(variant, path, next);
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const childPath = path ? `${path}.${name}` : name;
      keys.add(childPath);
      visit(child, childPath, next);
    }
    if (node.items) {
      keys.add(`${path}[]`);
      visit(node.items, `${path}[]`, next);
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      keys.add(`${path}.*`);
      visit(node.additionalProperties, `${path}.*`, next);
    }
  }
  visit(root, '', new Set());
  return keys;
}

export function documentedKeys(markdown: string): Set<string> {
  const start = '<!-- config-schema:start -->';
  const end = '<!-- config-schema:end -->';
  if (markdown.split(start).length !== 2 || markdown.split(end).length !== 2) throw new Error('Configuration key markers must occur exactly once');
  const section = markdown.slice(markdown.indexOf(start) + start.length, markdown.indexOf(end));
  const keys = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]!);
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw new Error('Configuration keys missing or duplicated');
  return new Set(keys);
}

export function compareKeys(documented: Set<string>, expected = schemaKeys()): void {
  const missing = [...expected].filter((key) => !documented.has(key));
  const unknown = [...documented].filter((key) => !expected.has(key));
  if (missing.length || unknown.length) throw new Error(`Configuration key mismatch: missing ${missing.sort().join(', ')}; unknown ${unknown.sort().join(', ')}`);
}

/** No caller/ambient environment values are copied, even for unknown interpolation names. */
export function fakeEnvironment(text: string): NodeJS.ProcessEnv {
  const known: Record<string, string> = {
    AMP_TOKEN_CC: 'documentation-fake-client-cc', AMP_TOKEN_CODEX: 'documentation-fake-client-codex',
    AMP_TOKEN_WORKBUDDY: 'documentation-fake-client-workbuddy', AMP_ADMIN_TOKEN: 'documentation-fake-admin',
    PROJECT_DIR: '/documentation-project', AMP_AUDIT_PATH: '/documentation-audit.jsonl',
    RELAY_A_KEY: 'documentation-fake-relay-a', RELAY_B_KEY: 'documentation-fake-relay-b',
    OPENROUTER_API_KEY: 'documentation-fake-openrouter', CF_ACCOUNT_ID: 'documentation-fake-account',
    CF_API_TOKEN: 'documentation-fake-cloudflare', CF_GATEWAY_ID: 'documentation-fake-gateway',
    AI_GATEWAY_API_KEY: 'documentation-fake-vercel',
  };
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1]!;
    if (Object.hasOwn(known, name)) env[name] = known[name];
  }
  return env;
}

export function validateConfigSnippet(text: string): void {
  // Construct the projection BEFORE interpolation. Do not print parsed config or diagnostics.
  const env = fakeEnvironment(text);
  try { parseConfig(text, env); } catch { throw new Error('Invalid documented configuration snippet'); }
}

export async function emittedInit(): Promise<{ config: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'amp-docs-'));
  const target = join(directory, 'config.yaml');
  const original = process.stdout.write;
  let output = '';
  let outputBytes = 0;
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      outputBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (outputBytes > 64 * 1024) throw new Error('Init output exceeded documentation bound');
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    const program = new Command().exitOverride();
    registerInitCommand(program);
    await program.parseAsync(['init', '--yes', '--config', target], { from: 'user' });
    return { config: await readFile(target, 'utf8'), output };
  } finally {
    process.stdout.write = original;
    await rm(directory, { recursive: true, force: true });
  }
}

export function checkAgentSnippets(output: string, documents: { claude: string; codex: string; workbuddy: string }): void {
  const markers = ['Claude Code CLI:', 'Claude Desktop:', 'Codex CLI / Desktop (', 'model_provider = ',
    '# Codex classifier', 'WorkBuddy (', 'Full Chat Completions URL:', 'API Key:'];
  const positions = markers.map((marker) => {
    if (output.split(marker).length !== 2) throw new Error('Init setup section markers are missing or duplicated');
    return output.indexOf(marker);
  });
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) {
    throw new Error('Init setup sections are out of order');
  }

  const claude = output.slice(positions[0]!, positions[1]!);
  const exports = new Map<string, string>();
  for (const line of claude.split('\n').filter((line) => line.startsWith('export '))) {
    const declaration = /^export ([A-Z_][A-Z0-9_]*)=(.+)$/.exec(line);
    if (!declaration || exports.has(declaration[1]!)) throw new Error('Init Claude setup declarations are invalid or duplicated');
    exports.set(declaration[1]!, declaration[2]!);
    if (declaration[1] !== 'ANTHROPIC_AUTH_TOKEN' && !documents.claude.includes(line)) {
      throw new Error('Claude guide differs from emitted init setup');
    }
  }
  if (!['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
    'CLAUDE_CODE_AUTO_MODE_MODEL'].every((name) => exports.has(name))) {
    throw new Error('Init Claude setup declarations are incomplete');
  }

  const toml = output.slice(positions[3]!, positions[4]!).split('\n').map((line) => line.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  let tableIndex = -1;
  for (const [index, line] of toml.entries()) {
    if (line.startsWith('[')) {
      if (line !== '[model_providers.amp]' || tableIndex !== -1) throw new Error('Init Codex setup table is invalid or duplicated');
      tableIndex = index;
    } else {
      const declaration = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (!declaration || fields.has(declaration[1]!) || (declaration[1] === 'model_provider') !== (tableIndex === -1)) {
        throw new Error('Init Codex setup declarations are invalid, duplicated or misplaced');
      }
      fields.set(declaration[1]!, declaration[2]!);
    }
    if (!documents.codex.includes(line)) throw new Error('Codex guide differs from emitted init setup');
  }
  if (tableIndex !== 1 || !['model_provider', 'name', 'base_url', 'env_key', 'wire_api', 'supports_websockets'].every((name) => fields.has(name))) {
    throw new Error('Init Codex setup declarations are incomplete');
  }

  const workbuddy = output.slice(positions[5]!);
  const urls = [...workbuddy.matchAll(/^Full Chat Completions URL: (\S+)$/gm)];
  if (urls.length !== 1 || !documents.workbuddy.includes(urls[0]![1]!)) throw new Error('WorkBuddy guide differs from emitted init setup');
  const token = exports.get('ANTHROPIC_AUTH_TOKEN')?.match(/^'(amp_[A-Za-z0-9_-]{43})'$/)?.[1];
  const codexTokens = [...output.slice(positions[2]!, positions[3]!).matchAll(/^export AMP_TOKEN='([^'\r\n]+)'$/gm)];
  const workbuddyTokens = [...workbuddy.matchAll(/^API Key: (\S+)$/gm)];
  if (!token || codexTokens.length !== 1 || codexTokens[0]![1] !== token
    || workbuddyTokens.length !== 1 || workbuddyTokens[0]![1] !== token) {
    throw new Error('Init agent token setup is inconsistent');
  }
}

export async function checkDocumentation(root = resolve(import.meta.dirname, '..')): Promise<void> {
  const load = (path: string) => readFile(join(root, path), 'utf8');
  const [reference, claude, codex, workbuddy, example, english, chinese] = await Promise.all([
    load('docs/config.md'), load('docs/agents/claude-code.md'), load('docs/agents/codex.md'), load('docs/agents/workbuddy.md'), load('deploy/config.example.yaml'), load('README.md'), load('README.zh-CN.md'),
  ]);
  compareKeys(documentedKeys(reference));
  const snippets = [...reference.matchAll(/```yaml\s+amp-config\n([\s\S]*?)```/g)];
  if (snippets.length === 0) throw new Error('Complete documented configuration snippet missing');
  for (const block of snippets) validateConfigSnippet(block[1]!);
  validateConfigSnippet(example);
  const generated = await emittedInit();
  validateConfigSnippet(generated.config);
  checkAgentSnippets(generated.output, { claude, codex, workbuddy });
  for (const readme of [english, chinese]) checkAgentSnippets(generated.output, { claude: readme, codex: readme, workbuddy: readme });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkDocumentation().then(() => process.stdout.write('Documentation schema, configuration and emitted init snippets agree.\n')).catch(() => {
    process.stderr.write('Documentation validation failed; run the documentation tests for bounded diagnostics.\n');
    process.exitCode = 1;
  });
}
