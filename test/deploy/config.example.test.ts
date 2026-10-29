import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/load.js';
import { createApp } from '../../src/server/app.js';

const example = fileURLToPath(new URL('../../deploy/config.example.yaml', import.meta.url));

// Explicit synthetic environment: tests never inherit operator credentials.
function environment(auditPath: string): NodeJS.ProcessEnv {
  return {
    AMP_TOKEN_CC: 'C13_FAKE_CC',
    AMP_TOKEN_CODEX: 'C13_FAKE_CODEX',
    AMP_TOKEN_WORKBUDDY: 'C13_FAKE_WORKBUDDY',
    AMP_ADMIN_TOKEN: 'C13_FAKE_ADMIN',
    RELAY_A_KEY: 'C13_FAKE_RELAY_A',
    RELAY_B_KEY: 'C13_FAKE_RELAY_B',
    OPENROUTER_API_KEY: 'C13_FAKE_OPENROUTER',
    CF_ACCOUNT_ID: 'C13_FAKE_ACCOUNT',
    CF_API_TOKEN: 'C13_FAKE_CF',
    CF_GATEWAY_ID: 'C13_FAKE_GATEWAY',
    AI_GATEWAY_API_KEY: 'C13_FAKE_VERCEL',
    PROJECT_DIR: '/workspace/project',
    AMP_AUDIT_PATH: auditPath,
  };
}

describe('deployment example consumed by the application', () => {
  it('separates public health, authenticated clients and remote administration without contacting a provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amp-deploy-example-'));
    try {
      const env = environment(join(directory, 'audit.jsonl'));
      const config = await loadConfig(example, env);
      config.log_level = 'silent';
      const app = createApp(config);
      expect((await app.request('/healthz')).status).toBe(200);
      expect((await app.request('/not-a-route')).status).toBe(401);
      for (const token of [env.AMP_TOKEN_CC, env.AMP_TOKEN_CODEX, env.AMP_TOKEN_WORKBUDDY]) {
        // 404, not 401: accepted client identity, no configured route/provider call.
        expect((await app.request('/not-a-route', { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
        expect((await app.request('/_amp/status', { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403);
      }
      const status = await app.request('/_amp/status', { headers: { authorization: `Bearer ${env.AMP_ADMIN_TOKEN}` } });
      expect(status.status).toBe(200);
      const text = await status.text();
      for (const [key, value] of Object.entries(env)) {
        if (key.includes('TOKEN') || key.includes('KEY')) expect(text).not.toContain(value);
      }
      await app.flushAudit();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['AMP_TOKEN_CC', 'AMP_TOKEN_CODEX', 'AMP_TOKEN_WORKBUDDY', 'AMP_ADMIN_TOKEN'])(
    'rejects an empty %s rather than deploying an empty credential',
    async (name) => {
      const env = environment('/app/audit/audit.jsonl');
      env[name] = '';
      await expect(loadConfig(example, env)).rejects.toThrow(/Invalid configuration/);
    },
  );

  it('fails closed when the private provider environment is incomplete', async () => {
    const env = environment('/app/audit/audit.jsonl');
    delete env.RELAY_A_KEY;
    await expect(loadConfig(example, env)).rejects.toThrow('Missing environment variable RELAY_A_KEY');
  });
});
