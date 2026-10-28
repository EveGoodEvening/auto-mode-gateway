import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';

const cli = resolve('src/cli/index.ts');
const secrets = {
  RELAY_A_KEY: 'disposable-anthropic-secret',
  RELAY_B_KEY: 'disposable-openai-secret',
  OPENROUTER_API_KEY: 'disposable-decision-secret',
};
let home: string;

interface Result { code: number | null; stdout: string; stderr: string }
function runInit(args: string[], answers?: string[]): Promise<Result> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Result>();
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'init', ...args], {
    env: { ...process.env, ...secrets, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  let stdout = '';
  let stderr = '';
  let answered = 0;
  const messages = ['anthropic base URL', 'openai base URL', 'decision base URL', 'Decision model'];
  child.on('error', reject);
  const answerPrompt = () => {
    const message = messages[answered];
    if (answers && message && `${stdout}${stderr}`.includes(message)) {
      child.stdin.write(`${answers[answered++] ?? ''}\n`);
    }
  };
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); answerPrompt(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); answerPrompt(); });
  child.stdin.on('error', () => { /* A failed process may already have closed stdin. */ });
  child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  return promise;
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'amp-init-test-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('init command actual process behavior', () => {
  it('creates a loadable private default configuration without resolving provider secrets', async () => {
    const result = await runInit(['--yes']);
    expect(result.code).toBe(0);
    const path = join(home, '.config/auto-mode-proxy/config.yaml');
    const text = await readFile(path, 'utf8');
    expect(text).toContain('${RELAY_A_KEY}');
    expect(text).toContain('${RELAY_B_KEY}');
    expect(text).toContain('${OPENROUTER_API_KEY}');
    for (const secret of Object.values(secrets)) {
      expect(text).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    await expect(loadConfig(path, {})).rejects.toThrow('Missing environment variable RELAY_A_KEY');
    const config = await loadConfig(path, secrets);
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 8484 });
    expect(config.gate.on_provider_failure).toBe('block');
    expect(config.upstreams['relay-a']?.api_key).toBe(secrets.RELAY_A_KEY);
    expect(config.upstreams['relay-b']?.base_url).toBe('https://api.openai.com/v1');
    expect(config.decision.providers['jev-openrouter']?.model).toBe('typesafe/jev-1.14');
    expect(config.auth.client_tokens).toHaveLength(1);
    const token = config.auth.client_tokens[0]!;
    expect(token).toMatch(/^amp_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(await readdir(dirname(path))).toEqual(['config.yaml']);
  });

  it('prints the real generated token and all three source-aligned setup snippets', async () => {
    const path = join(home, 'custom.yaml');
    const result = await runInit(['--yes', '--config', path]);
    expect(result.code).toBe(0);
    const config = await loadConfig(path, secrets);
    const token = config.auth.client_tokens[0]!;
    expect(result.stdout).toContain(`export ANTHROPIC_AUTH_TOKEN='${token}'`);
    expect(result.stdout).toContain('http://127.0.0.1:8484/cc');
    expect(result.stdout).toContain('export ANTHROPIC_API_KEY=""');
    expect(result.stdout).toContain('export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1');
    expect(result.stdout).toContain('CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5');
    expect(result.stdout).toContain('Desktop does not read');
    expect(result.stdout).toContain('HTTPS gateway');
    expect(result.stdout).toContain(`export AMP_TOKEN='${token}'`);
    expect(result.stdout.indexOf('model_provider = "amp"')).toBeLessThan(result.stdout.indexOf('[model_providers.amp]'));
    expect(result.stdout).toContain('base_url = "http://127.0.0.1:8484/codex/v1"');
    expect(result.stdout).toContain('env_key = "AMP_TOKEN"');
    expect(result.stdout).toContain('wire_api = "responses"');
    expect(result.stdout).toContain('supports_websockets = false');
    expect(result.stdout).toContain('launchctl setenv');
    expect(result.stdout).toContain('setx AMP_TOKEN');
    expect(result.stdout).toContain('http://127.0.0.1:8484/workbuddy/v1/chat/completions');
    expect(result.stdout).toContain(`API Key: ${token}`);
    expect(result.stdout).toContain('自动审批, not 完全访问');
    expect(result.stdout).toContain('not yet verified');
  });

  it('uses real Inquirer prompts to save chosen endpoint and model values', async () => {
    const path = join(home, 'interactive.yaml');
    const result = await runInit(['--config', path], [
      'http://127.0.0.1:19001', 'http://127.0.0.1:19002/v1',
      'http://127.0.0.1:19003/v1', 'chosen-model',
    ]);
    expect(result.code).toBe(0);
    const config = await loadConfig(path, secrets);
    expect(config.upstreams['relay-a']?.base_url).toBe('http://127.0.0.1:19001');
    expect(config.upstreams['relay-b']?.base_url).toBe('http://127.0.0.1:19002/v1');
    expect(config.decision.providers['jev-openrouter']?.base_url).toBe('http://127.0.0.1:19003/v1');
    expect(config.decision.providers['jev-openrouter']?.model).toBe('chosen-model');
  }, 20_000);

  it('rejects existing files without force without changing data or exposing a token', async () => {
    const path = join(home, 'existing.yaml');
    await writeFile(path, 'original');
    const result = await runInit(['--yes', '--config', path]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--force');
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(result.stdout + result.stderr).not.toMatch(/amp_[A-Za-z0-9_-]{43}/);
    expect(await readdir(home)).toEqual(['existing.yaml']);
  });

  it('explicit force replaces a regular file privately without modifying hard-link peers', async () => {
    const path = join(home, 'existing.yaml');
    const peer = join(home, 'hardlink.yaml');
    await writeFile(path, 'original');
    await chmod(path, 0o644);
    await link(path, peer);
    const result = await runInit(['--yes', '--force', '--config', path]);
    expect(result.code).toBe(0);
    await expect(loadConfig(path, secrets)).resolves.toBeDefined();
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(peer, 'utf8')).toBe('original');
  });

  it.each([false, true])('rejects a symlink destination even with force=%s', async (force) => {
    const victim = join(home, 'victim');
    const path = join(home, 'config.yaml');
    await writeFile(victim, 'do not overwrite');
    await symlink(victim, path);
    const result = await runInit(['--yes', '--config', path, ...(force ? ['--force'] : [])]);
    expect(result.code).not.toBe(0);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(victim, 'utf8')).toBe('do not overwrite');
    expect(result.stdout + result.stderr).not.toMatch(/amp_[A-Za-z0-9_-]{43}/);
  });

  it('rejects symlink parent directories and dangling symlinks', async () => {
    const linked = join(home, 'linked');
    await symlink(home, linked);
    const result = await runInit(['--yes', '--force', '--config', join(linked, 'config.yaml')]);
    expect(result.code).not.toBe(0);
    expect(await readdir(home)).toEqual(['linked']);
    const dangling = join(home, 'dangling');
    await symlink(join(home, 'missing'), dangling);
    expect((await runInit(['--yes', '--force', '--config', dangling])).code).not.toBe(0);
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
  });

  it('rejects a directory destination without replacing it', async () => {
    const result = await runInit(['--yes', '--force', '--config', home]);
    expect(result.code).not.toBe(0);
    expect((await lstat(home)).isDirectory()).toBe(true);
    expect(await readdir(home)).toEqual([]);
    expect(result.stdout + result.stderr).not.toMatch(/amp_[A-Za-z0-9_-]{43}/);
  });

  it('rejects invalid prompted endpoints without publishing a file or issuing a token', async () => {
    const path = join(home, 'bad.yaml');
    const result = await runInit(['--config', path], [
      'https://user:prompt-secret@example.com', '', '', '',
    ]);
    expect(result.code).not.toBe(0);
    // Inquirer echoes entered answers by design; only the controlled error must
    // not repeat the value, and no generated token/config may be published.
    expect(result.stderr).toContain('Invalid endpoint or model');
    expect(result.stdout + result.stderr).not.toMatch(/amp_[A-Za-z0-9_-]{43}/);
    expect(await readdir(home)).toEqual([]);
  }, 20_000);
});
