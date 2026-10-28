import { isIP } from 'node:net';
import { z } from 'zod';
import { DEFAULT_AUDIT_PATH } from './defaults.js';
import * as policyDefaults from '../policy/constants.js';

const nonempty = z.string().refine((value) => value.trim().length > 0, 'Must not be empty');
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value), 'Invalid identifier');
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const probability = z.number().min(0).max(1);
const httpUrl = z.string().refine((value) => {
  try {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code <= 32 || code === 127) return false;
    }
    const url = new URL(value);
    return /^https?:\/\//.test(value)
      && ['http:', 'https:'].includes(url.protocol) && url.hostname.length > 0
      && !url.username && !url.password && !url.hash && !url.search;
  } catch {
    return false;
  }
}, 'Must be an HTTP(S) URL without embedded credentials, query or fragment');
const headers = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  z.string().refine((value) => !/[\r\n\0]/.test(value), 'Invalid header value'),
);
const jsonObject = z.record(z.string(), z.json());
const pricing = z.strictObject({
  // Missing prices remain unknown; adapters must not turn them into zero cost.
  input_usd_per_million: z.number().nonnegative().optional(),
  output_usd_per_million: z.number().nonnegative().optional(),
});
const actionKind = z.enum(['command', 'file_write', 'url', 'mcp', 'other']);
const toolMapping = z.union([
  actionKind,
  z.strictObject({ kind: actionKind, arg: nonempty.optional() }),
]);
const routeSchema = z.strictObject({
  prefix: z.string().refine(
    (value) => value === '/' || /^\/[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*$/.test(value),
    'Must be a canonical absolute segment prefix without a trailing slash',
  ),
  protocol: z.enum(['anthropic-messages', 'openai-responses', 'openai-chat']),
  upstream: identifier,
  project_dirs: z.array(nonempty).optional(),
  tool_map: z.record(nonempty, toolMapping).optional(),
  claude_delivery: z.enum(['auto', 'native', 'rewrite']).default('auto'),
  // Exact observed versions only, never wildcard/range selectors.
  claude_delivery_by_version: z.record(
    z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/),
    z.enum(['native', 'rewrite']),
  ).optional(),
});
const upstreamSchema = z.strictObject({
  base_url: httpUrl,
  api_key: nonempty.optional(),
  auth_header: z.enum(['authorization', 'x-api-key', 'both']).default('authorization'),
  forward_safeguards: z.boolean().default(false),
  // Independent of safeguards forwarding; only the dangerous beta is removed.
  strip_beta: z.boolean().default(true),
  extra_headers: headers.optional(),
});
const providerSchema = z.strictObject({
  kind: z.enum(['systemone', 'openai-decisions']),
  base_url: httpUrl,
  api_key: nonempty,
  model: nonempty,
  headers: headers.optional(),
  envelope: z.enum(['none', 'cloudflare']).default('none'),
  body_extra: jsonObject.optional(),
  pricing: pricing.optional(),
});
const secondStageSchema = z.strictObject({
  kind: z.literal('anthropic-messages').default('anthropic-messages'),
  base_url: httpUrl,
  api_key: nonempty,
  model: nonempty.default('anthropic/claude-haiku-5.5'),
  headers: headers.optional(),
  pin: jsonObject.optional(),
  pricing: pricing.optional(),
});
const thresholds = z.strictObject({
  risk_block: probability.default(policyDefaults.THRESHOLDS.risk_block),
  risk_allow: probability.default(policyDefaults.THRESHOLDS.risk_allow),
  intent_mismatch: probability.default(policyDefaults.THRESHOLDS.intent_mismatch),
  intent_risk: probability.default(policyDefaults.THRESHOLDS.intent_risk),
  outside_scope_allow: probability.default(policyDefaults.THRESHOLDS.outside_scope_allow),
}).prefault({});

/** JSON/YAML-safe regexes are validated before any runtime policy is resolved. */
export const regexSpecSchema = z.strictObject({
  source: z.string(),
  flags: z.string().optional(),
}).refine(({ source, flags }) => {
  try { new RegExp(source, flags); return true; } catch { return false; }
}, 'Must be a valid regular expression with supported, unique flags');
const questionOverride = z.strictObject({
  instructions: nonempty.optional(),
  criteria: z.strictObject({ true: nonempty.optional(), false: nonempty.optional() }).optional(),
});
const stringList = z.array(nonempty);
const policySchema = z.strictObject({
  version: nonempty.optional(),
  questions: z.strictObject({
    destructive: questionOverride.optional(),
    exfiltration: questionOverride.optional(),
    remote_code_exec: questionOverride.optional(),
    security_weakening: questionOverride.optional(),
    outside_scope: questionOverride.optional(),
    matches_user_request: questionOverride.optional(),
  }).optional(),
  thresholds,
  user_request_max_chars: positiveInteger.max(policyDefaults.USER_REQUEST_MAX_CHARS).optional(),
  write_content_max_bytes: positiveInteger.max(policyDefaults.WRITE_CONTENT_MAX_BYTES).optional(),
  readonly_programs: stringList.optional(),
  readonly_git_subcommands: stringList.optional(),
  shell_unsafe_programs: stringList.optional(),
  shell_interpreters: stringList.optional(),
  find_unsafe_arguments: stringList.optional(),
  git_unsafe_arguments: stringList.optional(),
  readonly_unsafe_arguments: z.record(nonempty, stringList).optional(),
  readonly_positional_limits: z.record(nonempty, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional(),
  download_programs: stringList.optional(),
  file_write_programs: stringList.optional(),
  inplace_write_programs: stringList.optional(),
  hard_deny_commands: stringList.optional(),
  hard_deny_target_patterns: z.strictObject({
    root: regexSpecSchema.optional(), home: regexSpecSchema.optional(),
    authorized_keys: regexSpecSchema.optional(), device: regexSpecSchema.optional(),
  }).optional(),
  hard_deny_patterns: z.array(z.strictObject({ id: nonempty, pattern: regexSpecSchema })).optional(),
  sensitive_path_globs: stringList.optional(),
  redaction_patterns: z.array(z.strictObject({
    type: nonempty, pattern: regexSpecSchema, replacement: z.string().optional(),
  })).optional(),
  redaction_sensitive_keys: regexSpecSchema.optional(),
  readonly_allow_extra: stringList.default([]),
  hard_deny_extra: z.array(nonempty.refine((value) => {
    try { new RegExp(value, 'iu'); return true; } catch { return false; }
  }, 'Must be a valid regular expression')).default([]),
  sensitive_paths_extra: stringList.default([]),
}).prefault({});

// DNS names (including localhost) are not trusted as loopback security identities.
function isLoopback(host: string): boolean {
  return (isIP(host) === 4 && host.split('.')[0] === '127')
    || (isIP(host) === 6 && new URL(`http://[${host}]`).hostname === '[::1]');
}

export const configSchema = z.strictObject({
  listen: z.strictObject({
    host: nonempty.default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8484),
  }).prefault({}),
  auth: z.strictObject({
    mode: z.enum(['vault', 'passthrough']).default('vault'),
    client_tokens: z.array(nonempty).default([]),
    // Absent means status remains loopback-only, not unauthenticated remote access.
    admin_token: nonempty.optional(),
  }).prefault({}),
  routes: z.array(routeSchema).min(1),
  upstreams: z.record(identifier, upstreamSchema).refine(
    (value) => Object.keys(value).length > 0, 'At least one upstream is required',
  ),
  gate: z.strictObject({
    mode: z.enum(['enforce', 'shadow']).default('enforce'),
    on_provider_failure: z.enum(['block', 'allow']).default('block'),
    hold_keepalive_ms: positiveInteger.default(5000),
    provider_timeout_ms: positiveInteger.default(5000),
  }).prefault({}),
  decision: z.strictObject({
    chain: z.array(identifier).min(1),
    providers: z.record(identifier, providerSchema),
    second_stage: secondStageSchema.optional(),
  }),
  classifier_reroute: z.strictObject({
    enabled: z.boolean().default(false),
    // Only second_stage is an Anthropic-compatible trusted target in this schema.
    provider: z.literal('second_stage').default('second_stage'),
    model_map: z.record(nonempty, nonempty).optional(),
  }).prefault({}),
  audit: z.strictObject({
    path: nonempty.default(DEFAULT_AUDIT_PATH),
    redact: z.literal(true).default(true),
  }).prefault({}),
  policy: policySchema,
  log_level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Forwarded addresses are logging metadata only, never management authorization.
  trust_proxy: z.boolean().default(false),
  limits: z.strictObject({
    request_body_bytes: positiveInteger.default(64_000_000),
    upstream_connect_timeout_ms: positiveInteger.default(10_000),
    upstream_read_timeout_ms: positiveInteger.default(30_000),
  }).prefault({}),
}).superRefine((config, context) => {
  const issue = (path: (string | number)[], message: string) => {
    context.addIssue({ code: 'custom', path, message });
  };
  if (!isLoopback(config.listen.host)) {
    if (config.auth.mode === 'passthrough') {
      issue(['auth', 'mode'], 'Passthrough requires a loopback listen.host');
    }
    if (config.auth.client_tokens.length === 0) {
      issue(['auth', 'client_tokens'], 'Non-loopback listeners require client tokens');
    }
  }
  const tokens = new Set<string>();
  config.auth.client_tokens.forEach((token, index) => {
    if (tokens.has(token)) issue(['auth', 'client_tokens', index], 'Duplicate client token');
    tokens.add(token);
  });
  const prefixes = new Set<string>();
  const inferredUpstreams = new Map<string, string>();
  config.routes.forEach((route, index) => {
    if (!Object.hasOwn(config.upstreams, route.upstream)) {
      issue(['routes', index, 'upstream'], 'Unknown upstream reference');
    }
    if (prefixes.has(route.prefix)) issue(['routes', index, 'prefix'], 'Duplicate route prefix');
    prefixes.add(route.prefix);
    // Prefix-free protocol inference must resolve to exactly one upstream.
    const upstream = inferredUpstreams.get(route.protocol);
    if (upstream !== undefined && upstream !== route.upstream) {
      issue(['routes', index, 'upstream'], 'Ambiguous upstream for prefix-free protocol inference');
    }
    inferredUpstreams.set(route.protocol, route.upstream);
  });
  const chain = new Set<string>();
  config.decision.chain.forEach((provider, index) => {
    if (!Object.hasOwn(config.decision.providers, provider)) {
      issue(['decision', 'chain', index], 'Unknown decision provider reference');
    }
    if (chain.has(provider)) issue(['decision', 'chain', index], 'Duplicate decision provider reference');
    chain.add(provider);
  });
  if (config.classifier_reroute.enabled && !config.decision.second_stage) {
    issue(['classifier_reroute', 'provider'], 'Enabled classifier reroute requires decision.second_stage');
  }
  if (config.policy.thresholds.risk_allow >= config.policy.thresholds.risk_block) {
    issue(['policy', 'thresholds', 'risk_allow'], 'Allow threshold must be below block threshold');
  }
});

export type Config = z.infer<typeof configSchema>;
