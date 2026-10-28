import { QUESTIONS } from '../policy/constants.js';
import { postDecisionJson } from './http.js';
import { estimateCost } from './systemone.js';
import { DecisionError, type Answers, type DecisionOptions, type DecisionProvider, type DecisionResult, type DecisionState, type DecisionUsage, type ProviderConfig, type QuestionId, type Questions } from './types.js';

const questionIds = Object.keys(QUESTIONS) as QuestionId[];

/** Both native OpenAI and Vercel expose POST /v1/decisions; preserve complete endpoints. */
export function openAIDecisionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DecisionError('configuration');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) url.pathname = '/v1/decisions';
  else if (path.endsWith('/v1')) url.pathname = `${path}/decisions`;
  else url.pathname = path;
  return url.toString();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** https://developers.openai.com/api/reference/resources/decisions/methods/create */
export function parseOpenAIDecisionsResponse(value: unknown): { answers: Answers; usage: DecisionUsage; model?: string } {
  if (!object(value) || value.refusal || value.error || !Array.isArray(value.answers) || value.answers.length !== questionIds.length) throw new DecisionError('invalid_response');
  const answers = {} as Answers;
  for (const answer of value.answers) {
    if (!object(answer) || answer.type !== 'predicate' || answer.refusal || typeof answer.name !== 'string' || !Object.hasOwn(QUESTIONS, answer.name)) throw new DecisionError('invalid_response');
    const name = answer.name as QuestionId;
    if (Object.hasOwn(answers, name) || typeof answer.probability !== 'number' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new DecisionError('invalid_response');
    answers[name] = answer.probability;
  }
  for (const name of questionIds) {
    if (!Object.hasOwn(answers, name)) throw new DecisionError('invalid_response');
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

/** https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions */
export class OpenAIDecisionsProvider implements DecisionProvider {
  private readonly url: string;
  private readonly headers: Headers;
  constructor(readonly id: string, private readonly config: ProviderConfig, private readonly timeoutMs: number) {
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new DecisionError('configuration');
    try {
      this.url = openAIDecisionsUrl(config.base_url);
      this.headers = new Headers(config.headers);
      this.headers.set('authorization', `Bearer ${config.api_key}`);
      this.headers.set('content-type', 'application/json');
      this.headers.set('accept', 'application/json');
    } catch { throw new DecisionError('configuration'); }
  }
  async decide(state: DecisionState, questions: Questions, options: DecisionOptions = {}): Promise<DecisionResult> {
    const started = Date.now();
    const predicates = questionIds.map((name) => {
      const question = questions[name];
      return { type: 'predicate', name, instructions: `${question.instructions}\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}` };
    });
    const body = JSON.stringify({ ...this.config.body_extra, model: this.config.model, input: JSON.stringify(state), questions: predicates });
    const raw = await postDecisionJson(this.url, this.headers, body, this.timeoutMs, options);
    const parsed = parseOpenAIDecisionsResponse(raw);
    const model = parsed.model ?? this.config.model;
    return { answers: parsed.answers, usage: parsed.usage, provider: this.id, model, latency_ms: Date.now() - started, cost_usd: estimateCost(this.config, parsed.usage, model) };
  }
}
