import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import type { Command } from 'commander';
import { stringify } from 'yaml';
import { DEFAULT_CONFIG_PATH } from '../config/defaults.js';
import { configSchema } from '../config/schema.js';
import { generateToken } from './token.js';

interface InitOptions {
  config: string;
  yes?: boolean;
  force?: boolean;
}

const defaults = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  decision: 'https://openrouter.ai/api/v1',
  model: 'typesafe/jev-1.14',
};

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Walk rather than recursive mkdir: never traverse a pre-existing symlink.
async function prepareDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await prepareDirectory(parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('unsafe-directory');
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    const trustedOwner = entry.uid === 0 || entry.uid === uid;
    // Shared sticky roots such as /tmp protect each user's child entries;
    // non-sticky writable ancestors let another user swap a checked directory.
    const sharedStickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (!trustedOwner || ((entry.mode & 0o022) !== 0 && !sharedStickyRoot)) {
      throw new Error('unsafe-directory-permissions');
    }
  }
}

async function checkTarget(path: string, force: boolean): Promise<void> {
  const entry = await statIfPresent(path);
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('unsafe-target');
  if (entry && !force) throw new Error('existing-target');
}

async function writePrivate(path: string, text: string, force: boolean): Promise<void> {
  const temporary = join(dirname(path), `.amp-init-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await checkTarget(path, force);
    if (force) {
      // Rename replaces the directory entry, never writes through a symlink or
      // hard link. The new inode retains its private mode, even on overwrite.
      await rename(temporary, path);
    } else {
      // An exclusive hard-link publish is atomic and cannot overwrite a target
      // created since checkTarget. The temporary inode is already complete.
      await link(temporary, path);
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function snippets(token: string): string {
  return `
Setup guidance only: agent compatibility and protection are not yet verified.
C08 implements Claude Messages enforcement only; parent verification is pending.
Codex/Responses and WorkBuddy/Chat are unprotected until their adapter rollouts.
Do not send real tool traffic to those routes. Shadow mode does not block tools.
Native delivery is not proof that this client supports safeguard_results.
The issued client token below is a secret; do not paste this output into logs.

Claude Code CLI:
export ANTHROPIC_BASE_URL='http://127.0.0.1:8484/cc'
export ANTHROPIC_AUTH_TOKEN='${token}'
export ANTHROPIC_API_KEY=""
# Recommended gateway metadata hints (not proof of native capability):
export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
# Optional classifier cost hint; requires a configured trusted classifier route:
export CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5
Claude Desktop: on platforms exposing Developer Mode → Configure Third-Party
Inference, use http://127.0.0.1:8484/cc and the client token above. That GUI
configuration route has not been exercised on Linux; Desktop does not read
ANTHROPIC_BASE_URL. Official Linux Desktop 4.29 connected accountlessly in local
mock QA using /etc/claude-desktop/managed-settings.json with gateway settings and
the static AMP client token; the helper alternative is documented but unexercised.
See docs/agents/claude-code.md for the validated setup.
Select the explicit Code view; the generic home/new-chat view is not Code.
If your installed Desktop rejects loopback, use your own HTTPS gateway.

Codex CLI / Desktop (future protected rollout; setup only):
export AMP_TOKEN='${token}'
# Merge into ~/.codex/config.toml. Keep model_provider at the TOP LEVEL,
# before any [table] headers (not inside an existing table):
model_provider = "amp"

[model_providers.amp]
name = "auto-mode-proxy"
base_url = "http://127.0.0.1:8484/codex/v1"
env_key = "AMP_TOKEN"
wire_api = "responses"
supports_websockets = false
# Desktop must inherit AMP_TOKEN: macOS launchctl setenv AMP_TOKEN <token>;
# Windows setx AMP_TOKEN <token>, then restart the GUI. These persist a secret.

WorkBuddy (future protected rollout; setup only):
Settings > Models > Add model > Custom (设置 > 模型 > 添加模型 > 自定义)
Full Chat Completions URL: http://127.0.0.1:8484/workbuddy/v1/chat/completions
API Key: ${token}
Enable tool calls; choose AI 智能审批 = 自动审批, not 完全访问.
`;
}

export function registerInitCommand(program: Command): void {
  program.command('init')
    .description('Generate a private configuration and print unverified agent setup guidance')
    .option('--config <path>', 'Configuration destination', DEFAULT_CONFIG_PATH)
    .option('-y, --yes', 'Use documented default endpoints without prompting (secrets stay ENV references)')
    .option('--force', 'Explicitly replace an existing regular file; symlinks are always rejected')
    .addHelpText('after', '\nDefaults: Anthropic https://api.anthropic.com; OpenAI https://api.openai.com/v1;\nSystem One https://openrouter.ai/api/v1, typesafe/jev-1.14 (not live-verified).\nSet RELAY_A_KEY, RELAY_B_KEY and OPENROUTER_API_KEY before loading the config.\nNo secret fallback is generated. --yes writes a fresh client token into the private file\nand prints it intentionally for agent setup; keep stdout private.\n')
    .action(async (options: InitOptions, command: Command) => {
      const target = resolve(options.config);
      try {
        // Refuse an existing destination before asking questions or issuing a token.
        await checkTarget(target, options.force === true);
        await prepareDirectory(dirname(target));
        const settings = { ...defaults };
        if (!options.yes) {
          for (const key of ['anthropic', 'openai', 'decision', 'model'] as const) {
            settings[key] = await input({
              message: `${key === 'model' ? 'Decision model' : `${key} base URL`} (no credentials)`,
              default: defaults[key],
            });
          }
        }
        const token = generateToken();
        const config = {
          listen: { host: '127.0.0.1', port: 8484 },
          auth: { mode: 'vault', client_tokens: [token] },
          routes: [
            { prefix: '/cc', protocol: 'anthropic-messages', upstream: 'relay-a' },
            { prefix: '/codex', protocol: 'openai-responses', upstream: 'relay-b' },
            { prefix: '/workbuddy', protocol: 'openai-chat', upstream: 'relay-b' },
          ],
          upstreams: {
            'relay-a': { base_url: settings.anthropic, api_key: '${RELAY_A_KEY}', auth_header: 'x-api-key' },
            'relay-b': { base_url: settings.openai, api_key: '${RELAY_B_KEY}', auth_header: 'authorization' },
          },
          gate: { mode: 'enforce', on_provider_failure: 'block' },
          decision: {
            chain: ['jev-openrouter'],
            providers: {
              'jev-openrouter': {
                kind: 'systemone', base_url: settings.decision,
                api_key: '${OPENROUTER_API_KEY}', model: settings.model,
              },
            },
          },
        };
        if (!configSchema.safeParse(config).success) {
          command.error('Invalid endpoint or model: use HTTP(S) URLs without credentials, query or fragment, and a nonempty model.');
        }
        // Literal ENV references are intentionally not expanded during generation.
        const text = '# Set RELAY_A_KEY, RELAY_B_KEY and OPENROUTER_API_KEY before loading.\n'
          + '# Default provider/model are setup guidance, not live-verified.\n'
          + '# Contains a private client token. Keep this file and setup output secret.\n'
          + stringify(config);
        await writePrivate(target, text, options.force === true);
        process.stdout.write(`Created private configuration at ${JSON.stringify(target)}.\n`
          + 'Required secrets: RELAY_A_KEY, RELAY_B_KEY, OPENROUTER_API_KEY (no defaults).\n'
          + snippets(token));
      } catch (error) {
        if (error instanceof Error && error.message === 'existing-target') {
          command.error('Configuration already exists; use --force to explicitly replace a regular file.');
        }
        command.error('Unable to initialize configuration. Use a writable directory without symlinks and a regular-file destination; no token was printed.');
      }
    });
}
