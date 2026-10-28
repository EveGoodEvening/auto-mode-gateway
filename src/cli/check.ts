import type { Command } from 'commander';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { createDecisionProvider } from '../decision/chain.js';
import { resolvePolicy } from '../policy/effective.js';
import type { DecisionState } from '../policy/state-builder.js';

const QUESTION_IDS = [
  'destructive', 'exfiltration', 'remote_code_exec', 'security_weakening',
  'outside_scope', 'matches_user_request',
] as const;

function canaryState(): DecisionState {
  return {
    action: { tool: 'canary', command: 'printf AMP_CANARY', workdir: '/canary' },
    environment: { platform: 'canary', project_dir: '/canary', trusted_directories: ['/canary'] },
    user_request: 'Print AMP_CANARY without changing files or accessing the network.',
  };
}

/** Check each configured provider, not just the first successful chain entry. */
export async function checkProviders(config: Config): Promise<boolean> {
  const policy = resolvePolicy(config.policy);
  let successful = true;
  let ordinal = 0;
  for (const [id, providerConfig] of Object.entries(config.decision.providers)) {
    const label = `provider[${++ordinal}]`;
    const started = performance.now();
    if (providerConfig.kind !== 'systemone') {
      process.stdout.write(`${label} unsupported (adapter requires C09) latency_ms=0\n`);
      successful = false;
      continue;
    }
    try {
      const provider = createDecisionProvider(id, providerConfig, config.gate.provider_timeout_ms);
      const result = await provider.decide(canaryState(), policy.questions, {
        signal: AbortSignal.timeout(60_000), deadline_ms: Date.now() + 60_000,
      });
      // Project only the six known finite numbers; never print provider-controlled
      // IDs, model names, URLs, response text or arbitrary exception messages.
      const answers = Object.fromEntries(QUESTION_IDS.map((key) => {
        const probability = result.answers[key];
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
          throw new Error('Invalid canary probability');
        }
        return [key, probability];
      }));
      process.stdout.write(`${label} ok latency_ms=${Math.round(performance.now() - started)} answers=${JSON.stringify(answers)}\n`);
    } catch {
      successful = false;
      process.stdout.write(`${label} failed latency_ms=${Math.round(performance.now() - started)} (provider unavailable or invalid response)\n`);
    }
  }
  return successful;
}

export function registerCheckCommand(program: Command): void {
  program.command('check')
    .description('Validate configuration and send a fixed canary to each decision provider.')
    .option('--config <path>', 'configuration file path')
    .action(async (options: { config?: string }) => {
      const config = await loadConfig(options.config);
      if (!await checkProviders(config)) process.exitCode = 1;
    });
}
