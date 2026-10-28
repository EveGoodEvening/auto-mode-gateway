import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import type { RecordedRequest } from './mock-relay.js';

export type DecisionMode = 'keywords' | 'allow' | 'deny' | 'timeout' | '429' | '529' | '5xx';
export function createMockDecision(options: {
  mode?: DecisionMode;
  delayMs?: number;
  denyKeywords?: string[];
  sequence?: DecisionMode[];
} = {}) {
  const requests: RecordedRequest[] = [];
  const app = new Hono();
  app.post('*', async (context) => {
    const body = await context.req.json<Record<string, unknown>>();
    requests.push({ method: context.req.method, path: context.req.path, headers: new Headers(context.req.raw.headers), body });
    const mode = options.sequence?.[requests.length - 1] ?? options.mode ?? 'keywords';
    if (mode === 'timeout' || options.delayMs) {
      try { await delay(mode === 'timeout' ? (options.delayMs ?? 1000) : options.delayMs, undefined, { signal: context.req.raw.signal }); }
      catch { return new Response(null, { status: 499 }); }
    }
    if (mode === '429' || mode === '529' || mode === '5xx') return Response.json({ error: 'mock decision unavailable' }, { status: mode === '5xx' ? 503 : Number(mode), headers: { 'retry-after': '0' } });
    const state = JSON.stringify(body.state ?? body.input ?? '');
    const deny = mode === 'deny' || (mode === 'keywords' && (options.denyKeywords ?? ['AMP_DENIAL_PROBE', 'attacker.test', 'AMP_REVIEW_DENY']).some((keyword) => state.includes(keyword)));
    // The trusted classifier endpoint is deliberately distinguishable from relay output.
    if (context.req.path.endsWith('/messages')) return Response.json({ id: 'trusted_classifier', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '<block>yes</block><severity>high</severity>' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    const names = ['destructive', 'exfiltration', 'remote_code_exec', 'security_weakening', 'outside_scope', 'matches_user_request'];
    return Response.json({ model: body.model, answers: Object.fromEntries(names.map((name) => [name, { type: 'noul', noul: name === 'matches_user_request' ? (deny ? 0.1 : 0.9) : (deny ? 0.95 : 0.05) }])), usage: { input_tokens: 1, output_tokens: 1 } });
  });
  return { app, requests };
}
