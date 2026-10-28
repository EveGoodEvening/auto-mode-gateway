import type { Answers } from '../decision/types.js';
import type { Config } from '../config/schema.js';
import type { RequestContext, ToolCall } from '../protocols/types.js';
import type { AuditStage } from '../audit/record.js';

export type Protocol = Config['routes'][number]['protocol'];
export type NormalizationRoute = Pick<Config['routes'][number], 'tool_map' | 'project_dirs'>;
export type ActionKind = 'command' | 'file_write' | 'url' | 'mcp' | 'other';
export type RecognizedExemption = 'read' | 'glob' | 'grep' | 'ls' | 'todo' | 'task';

/** Trusted caller context, never inferred from the gateway host's environment. */
export interface ActionContext {
  platform?: string;
  project_dir?: string;
  trusted_directories?: readonly string[];
  workdir?: string;
  home_dir?: string;
  userprofile?: string;
  git_branch?: string;
  request?: RequestContext;
  lastUserText?: string;
}

/** raw is audit-only: never serialize it into decision state or cache-key material. */
export interface Action {
  kind: ActionKind;
  tool: string;
  argv?: string[];
  text?: string;
  paths: string[];
  content_excerpt?: string;
  content_truncated: boolean;
  content_digest?: string;
  recognized_exemption?: RecognizedExemption;
  workdir?: string;
  url?: string;
  destructive?: boolean;
  execution_unavailable?: boolean;
  raw: ToolCall['raw'];
}

export interface GateContext extends ActionContext {
  signal?: AbortSignal;
  route?: string;
  protocol?: Protocol;
  agent_hint?: string;
  session_id?: string;
  delivery?: 'safeguard' | 'rewrite' | 'shadow' | 'passthrough';
}

export type Outcome = 'allow' | 'block' | 'uncertain';
export interface Verdict {
  outcome: Outcome;
  reasons: string[];
  probabilities?: Answers;
  provider?: string;
  rule?: string;
  latency_ms: number;
  cost_usd: number | null;
  policy_version: string;
  raw_outcome?: Outcome;
  cache_hit?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  stages?: AuditStage[];
}

export interface GateStats {
  decisions: number;
  allow: number;
  block: number;
  uncertain: number;
  cache_hits: number;
  provider_failures: number;
  provider_health: Record<string, { successes: number; failures: number }>;
}

export interface Gate {
  decide(action: Action, context: GateContext): Promise<Verdict>;
  stats(): GateStats;
  flushAudit(): Promise<void>;
}
