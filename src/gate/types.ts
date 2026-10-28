import type { Config } from '../config/schema.js';
import type { RequestContext, ToolCall } from '../protocols/types.js';

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
