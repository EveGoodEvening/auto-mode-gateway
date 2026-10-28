import { postDecisionJson } from './http.js';
import { DecisionError, type Answers, type DecisionOptions, type DecisionProvider, type DecisionResult, type DecisionState, type DecisionUsage, type ProviderConfig, type Questions } from './types.js';

/** Configured complete endpoints are preserved, including Cloudflare run/model paths. */
export function systemOneUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DecisionError('configuration');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/api') url.pathname = `${path}/v1/systemone`;
  else if (path.endsWith('/v1')) url.pathname = `${path}/systemone`;
  else url.pathname = path;
  return url.toString();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Primary schema: https://docs.typesafe.ai/api/system-one (noul answer objects). */
export function parseSystemOneResponse(value: unknown, questions: Questions): { answers: Answers; usage: DecisionUsage; model?: string } {
  if (!object(value)) throw new DecisionError('invalid_response');
  // An explicitly unsuccessful envelope must never be accepted through top-level answers.
  if ((value.success !== undefined && value.success !== true) || (Array.isArray(value.errors) && value.errors.length > 0)) throw new DecisionError('invalid_response');
  if (!Object.hasOwn(value, 'answers') && Object.hasOwn(value, 'result')) {
    if (value.success !== true || (Array.isArray(value.errors) && value.errors.length > 0) || !object(value.result)) throw new DecisionError('invalid_response');
    value = value.result;
  }
  if (!object(value) || value.refusal || !object(value.answers)) throw new DecisionError('invalid_response');
  const answers = {} as Answers;
  for (const id of Object.keys(questions) as (keyof Answers)[]) {
    const answer = value.answers[id];
    if (!object(answer) || answer.type !== 'noul' || answer.refusal || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new DecisionError('invalid_response');
    answers[id] = answer.noul;
  }
  // Questions are the resolved six-question policy, never a partial provider-defined set.
  for (const id of ['destructive', 'exfiltration', 'remote_code_exec', 'security_weakening', 'outside_scope', 'matches_user_request'] as const) {
    if (!Object.hasOwn(answers, id)) throw new DecisionError('invalid_response');
  }
  const usage: DecisionUsage = {};
  if (value.usage !== undefined) {
    if (!object(value.usage)) throw new DecisionError('invalid_response');
    for (const key of ['input_tokens', 'output_tokens'] as const) {
      const count = value.usage[key];
      if (count === undefined) continue;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new DecisionError('invalid_response');
      usage[key] = count;
    }
  }
  return { answers, usage, ...(typeof value.model === 'string' ? { model: value.model } : {}) };
}

/** https://docs.typesafe.ai/models: Jev 1.13/1.14 charge input only; output is free. */
export function estimateCost(config: ProviderConfig, usage: DecisionUsage, model = config.model): number | null {
  const knownJev = /^(?:typesafe\/)?jev-(?:latest|1\.(?:13|14)(?:\.0)?)$/;
  const jev = knownJev.test(model) && knownJev.test(config.model);
  const inputPrice = config.pricing?.input_usd_per_million ?? (jev ? 0.042 : undefined);
  const outputPrice = config.pricing?.output_usd_per_million ?? (jev ? 0 : undefined);
  if (usage.input_tokens === undefined || inputPrice === undefined) return null;
  if (usage.output_tokens === undefined && outputPrice !== 0) return null;
  if ((usage.output_tokens ?? 0) > 0 && outputPrice === undefined) return null;
  return (usage.input_tokens * inputPrice + (usage.output_tokens ?? 0) * (outputPrice ?? 0)) / 1_000_000;
}

export class SystemOneProvider implements DecisionProvider {
  private readonly url: string;
  private readonly headers: Headers;
  constructor(readonly id: string, private readonly config: ProviderConfig, private readonly timeoutMs: number) {
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new DecisionError('configuration');
    try {
      this.url = systemOneUrl(config.base_url);
      this.headers = new Headers(config.headers);
      // Required protocol/auth headers cannot be overridden by configured extras.
      this.headers.set('authorization', `Bearer ${config.api_key}`);
      this.headers.set('content-type', 'application/json');
      this.headers.set('accept', 'application/json');
    } catch { throw new DecisionError('configuration'); }
  }
  async decide(state: DecisionState, questions: Questions, options: DecisionOptions = {}): Promise<DecisionResult> {
    const started = Date.now();
    const body = JSON.stringify({ ...this.config.body_extra, model: this.config.model, state, questions });
    const raw = await postDecisionJson(this.url, this.headers, body, this.timeoutMs, options);
    const parsed = parseSystemOneResponse(raw, questions);
    const model = parsed.model ?? this.config.model;
    return { answers: parsed.answers, usage: parsed.usage, provider: this.id, model, latency_ms: Date.now() - started, cost_usd: estimateCost(this.config, parsed.usage, model) };
  }
}
