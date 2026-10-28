import type { Config } from '../config/schema.js';
import * as defaults from './constants.js';

export type QuestionId = keyof typeof defaults.QUESTIONS;
export interface RegexSpec { readonly source: string; readonly flags?: string }
export interface PolicyQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}
export interface EffectivePolicy {
  readonly version: string;
  readonly questions: Readonly<Record<QuestionId, PolicyQuestion>>;
  readonly thresholds: Readonly<Record<keyof typeof defaults.THRESHOLDS, number>>;
  readonly user_request_max_chars: number;
  readonly write_content_max_bytes: number;
  readonly readonly_programs: readonly string[];
  readonly readonly_git_subcommands: readonly string[];
  readonly shell_unsafe_programs: readonly string[];
  readonly shell_interpreters: readonly string[];
  readonly find_unsafe_arguments: readonly string[];
  readonly git_unsafe_arguments: readonly string[];
  readonly readonly_unsafe_arguments: Readonly<Record<string, readonly string[]>>;
  readonly readonly_positional_limits: Readonly<Record<string, number>>;
  readonly download_programs: readonly string[];
  readonly file_write_programs: readonly string[];
  readonly inplace_write_programs: readonly string[];
  readonly hard_deny_commands: readonly string[];
  readonly hard_deny_target_patterns: Readonly<Record<keyof typeof defaults.HARD_DENY_TARGET_PATTERNS, RegExp>>;
  readonly hard_deny_patterns: readonly { readonly id: string; readonly pattern: RegExp }[];
  readonly sensitive_path_globs: readonly string[];
  readonly redaction_patterns: readonly { readonly type: string; readonly pattern: RegExp; readonly replacement?: string }[];
  readonly redaction_sensitive_keys: RegExp;
}

function compile(spec: RegexSpec): RegExp { return new RegExp(spec.source, spec.flags); }

/** Resolve once at the configuration boundary; all consumers share this value.
 * Invalid regexes supplied directly throw rather than silently dropping protection.
 */
export function resolvePolicy(overrides: Partial<Config['policy']> = {}): EffectivePolicy {
  const questions = {} as Record<QuestionId, PolicyQuestion>;
  for (const id of Object.keys(defaults.QUESTIONS) as QuestionId[]) {
    const base = defaults.QUESTIONS[id];
    const replacement = overrides.questions?.[id];
    questions[id] = {
      type: 'noul',
      instructions: replacement?.instructions ?? base.instructions,
      criteria: { ...base.criteria, ...replacement?.criteria },
    };
  }
  const targets = defaults.HARD_DENY_TARGET_PATTERNS;
  return {
    version: overrides.version ?? defaults.POLICY_VERSION,
    questions,
    thresholds: { ...defaults.THRESHOLDS, ...overrides.thresholds },
    user_request_max_chars: overrides.user_request_max_chars ?? defaults.USER_REQUEST_MAX_CHARS,
    write_content_max_bytes: overrides.write_content_max_bytes ?? defaults.WRITE_CONTENT_MAX_BYTES,
    readonly_programs: [...(overrides.readonly_programs ?? defaults.READONLY_PROGRAMS), ...(overrides.readonly_allow_extra ?? [])],
    readonly_git_subcommands: overrides.readonly_git_subcommands ?? defaults.READONLY_GIT_SUBCOMMANDS,
    shell_unsafe_programs: overrides.shell_unsafe_programs ?? defaults.SHELL_UNSAFE_PROGRAMS,
    shell_interpreters: overrides.shell_interpreters ?? defaults.SHELL_INTERPRETERS,
    find_unsafe_arguments: overrides.find_unsafe_arguments ?? defaults.FIND_UNSAFE_ARGUMENTS,
    git_unsafe_arguments: overrides.git_unsafe_arguments ?? defaults.GIT_UNSAFE_ARGUMENTS,
    readonly_unsafe_arguments: { ...defaults.READONLY_UNSAFE_ARGUMENTS, ...overrides.readonly_unsafe_arguments },
    readonly_positional_limits: { ...defaults.READONLY_POSITIONAL_LIMITS, ...overrides.readonly_positional_limits },
    download_programs: overrides.download_programs ?? defaults.DOWNLOAD_PROGRAMS,
    file_write_programs: overrides.file_write_programs ?? defaults.FILE_WRITE_PROGRAMS,
    inplace_write_programs: overrides.inplace_write_programs ?? defaults.INPLACE_WRITE_PROGRAMS,
    hard_deny_commands: overrides.hard_deny_commands ?? defaults.HARD_DENY_COMMANDS,
    hard_deny_target_patterns: {
      root: compile(overrides.hard_deny_target_patterns?.root ?? targets.root),
      home: compile(overrides.hard_deny_target_patterns?.home ?? targets.home),
      authorized_keys: compile(overrides.hard_deny_target_patterns?.authorized_keys ?? targets.authorized_keys),
      device: compile(overrides.hard_deny_target_patterns?.device ?? targets.device),
    },
    hard_deny_patterns: [
      ...(overrides.hard_deny_patterns ?? defaults.HARD_DENY_PATTERNS).map(({ id, pattern }) => ({ id, pattern: compile(pattern) })),
      ...(overrides.hard_deny_extra ?? []).map((source) => ({ id: 'configured-hard-deny', pattern: new RegExp(source, 'iu') })),
    ],
    sensitive_path_globs: [...(overrides.sensitive_path_globs ?? defaults.SENSITIVE_PATH_GLOBS), ...(overrides.sensitive_paths_extra ?? [])],
    redaction_patterns: (overrides.redaction_patterns ?? defaults.REDACTION_PATTERNS).map((entry) => ({
      type: entry.type,
      pattern: compile(entry.pattern),
      ...('replacement' in entry && entry.replacement !== undefined ? { replacement: entry.replacement } : {}),
    })),
    redaction_sensitive_keys: compile(overrides.redaction_sensitive_keys ?? defaults.REDACTION_SENSITIVE_KEYS),
  };
}
export const DEFAULT_POLICY: EffectivePolicy = resolvePolicy();
