# Configuration reference

The authoritative input contract is [`src/config/schema.ts`](../src/config/schema.ts); [`src/config/load.ts`](../src/config/load.ts) parses YAML (JSON is a YAML-compatible alternative), interpolates string **values** and applies schema defaults. Unknown object keys, duplicate YAML keys, invalid URLs, cycles and invalid fields fail loading. Configuration is not TOML; Codex's separate client file is TOML.

Default file: `~/.config/auto-mode-proxy/config.yaml`. `init`, `serve`, `check`, `eval` and `audit tail` accept `--config <path>`; check each command's help for its other options. There is no global host/port override. `serve --log-level <level>` overrides only the loaded log level. `init --yes` uses documented endpoint/model defaults, `--force` explicitly replaces an existing regular file; neither verifies a provider. `check` sends potentially billed canaries, not an offline-only validation. `token new` issues a secret but does not insert it into the configuration.

`${NAME}` expansion happens once, after YAML parsing, only in strings, never keys. An absent referenced variable fails; an empty value can subsequently fail schema validation. Values cannot inject YAML or recursively expand another reference. All referenced variables across the file must be available even for unused routes/providers. Keep files private and separate server credentials from agent client tokens. Use an authorized secret-provisioning mechanism; do not publish expanded configuration or init output.

## Complete minimal example

This is a complete fake-value example, **not** a functioning provider account or a live-verified model/endpoint claim. Replace fake credentials privately and choose authorized endpoints/models before real use. `init --yes` generates the same three protocol routes, fresh client token and literal secret ENV references rather than these fake literals.

```yaml amp-config
listen: { host: 127.0.0.1, port: 8484 }
auth:
  mode: vault
  client_tokens: [example-only-client-token]
routes:
  - { prefix: /cc, protocol: anthropic-messages, upstream: relay-a }
  - { prefix: /codex, protocol: openai-responses, upstream: relay-b }
  - { prefix: /workbuddy, protocol: openai-chat, upstream: relay-b }
upstreams:
  relay-a:
    base_url: https://api.anthropic.com
    api_key: example-only-anthropic-key
    auth_header: x-api-key
  relay-b:
    base_url: https://api.openai.com/v1
    api_key: example-only-openai-key
    auth_header: authorization
gate: { mode: enforce, on_provider_failure: block }
decision:
  chain: [jev-openrouter]
  providers:
    jev-openrouter:
      kind: systemone
      base_url: https://openrouter.ai/api/v1
      api_key: example-only-decision-key
      model: typesafe/jev-1.14
```

## Field notation and validation

The tables between the markers are the documented schema key set consumed by `npm run docs:check`. They include containers, array elements (`[]`), record values (`*`) and all union branches. A JSON extension's wildcard is an arbitrary JSON **value**, not a recursively enumerated configuration schema. “Optional” means absent is accepted; defaults apply when omitted, not when explicitly null. Unless noted otherwise, strings are nonempty after trimming, integer values are safe integers, and strict objects reject unknown fields.

Provider/upstream identifiers start with an ASCII letter/digit followed by letters/digits/`_`/`-`; `__proto__`, `prototype` and `constructor` are forbidden. HTTP(S) URLs cannot contain embedded credentials, whitespace/control characters, query or fragment. Use HTTPS outside explicitly owned loopback fixtures. Header names must be HTTP tokens, values cannot contain CR/LF/NUL. Extension objects accept JSON, not functions/undefined.

<!-- config-schema:start -->

### Listener, authentication and routes

| Key | Type / default / behavior |
| --- | --- |
| `listen` | Object; omitted uses defaults. |
| `listen.host` | Nonempty string; `127.0.0.1`. Literal loopback IP required for loopback privileges; DNS names including `localhost` are not security identities. |
| `listen.port` | Integer 1–65535; `8484`. |
| `auth` | Object; defaults below. |
| `auth.mode` | `vault` (default) or `passthrough`. Vault substitutes server-held relay credentials; passthrough forwards client credentials and is allowed only on literal loopback. |
| `auth.client_tokens` | Array; `[]`. Must be nonempty on non-loopback listeners, with no duplicates. Keep nonempty even locally for vault protection. |
| `auth.client_tokens[]` | Nonempty client secret; issued by init/token new, provisioned to agents rather than relay keys. |
| `auth.admin_token` | Optional nonempty management secret. Absent keeps `/_amp/status` loopback-only; forwarded IP never grants access. |
| `routes` | Required nonempty array. Prefixes unique; referenced upstreams must exist. |
| `routes[]` | Strict route object. |
| `routes[].prefix` | Required `/` or canonical absolute segment prefix using ASCII letters/digits/`_~ -` (without spaces), no trailing slash except `/`. Longest matching route prefix is selected. |
| `routes[].protocol` | Required `anthropic-messages`, `openai-responses` or `openai-chat`. |
| `routes[].upstream` | Required upstream identifier. Multiple routes for the same protocol must name the same upstream, so prefix-free inference is unambiguous. |
| `routes[].project_dirs` | Optional trusted client-project directory array. Do not substitute the gateway server's HOME or broaden roots to hide missing context. |
| `routes[].project_dirs[]` | Nonempty client directory string. |
| `routes[].tool_map` | Optional record keyed by actual tool names; mappings do not grant semantic safety. |
| `routes[].tool_map.*` | Action-kind string or strict `{kind,arg?}` object. |
| `routes[].tool_map.*.kind` | Required in object form: `command`, `file_write`, `url`, `mcp`, `other`. |
| `routes[].tool_map.*.arg` | Optional nonempty actual argument-field name. |
| `routes[].claude_delivery` | `auto` (default), `native`, `rewrite`. Native requires original safeguards opt-in; explicit native/rewrite overrides version selection. |
| `routes[].claude_delivery_by_version` | Optional record of exact observed semver strings, never wildcard/ranges; used when route delivery is auto. |
| `routes[].claude_delivery_by_version.*` | `native` or `rewrite`. For Claude 2.1.311 use the evidence-backed rewrite override; native strict client replay failed. |

### Generation upstreams and gate

| Key | Type / default / behavior |
| --- | --- |
| `upstreams` | Required nonempty identifier-keyed record. |
| `upstreams.*` | Strict generation-relay configuration. This relay is not the trusted decision chain. |
| `upstreams.*.base_url` | Required HTTP(S) base URL; preserve intended `/v1` suffix according to relay API. |
| `upstreams.*.api_key` | Optional nonempty relay credential. Vault operation needs the actual authorized credential unless the upstream intentionally needs none. |
| `upstreams.*.auth_header` | `authorization` (default), `x-api-key`, `both`; controls server-side relay credential replacement. |
| `upstreams.*.forward_safeguards` | Boolean; `false`. Controls forwarding request safeguards, not trusting upstream results. Enforce discards upstream safeguard results regardless. |
| `upstreams.*.strip_beta` | Boolean; `true`. Independently removes only `dangerous-tool-use-2026-09-03` in enforce; preserve unrelated beta values. Do not disable without actual upstream evidence. Shadow preserves original safeguards/beta. |
| `upstreams.*.extra_headers` | Optional header record; not a way to bypass protected auth/hop-by-hop handling. |
| `upstreams.*.extra_headers.*` | Header string; treat credential-valued headers as secrets. |
| `gate` | Object; defaults below. |
| `gate.mode` | `enforce` (default) or `shadow`. Shadow forwards original bytes without blocking/waiting; audit decisions are hypothetical. |
| `gate.on_provider_failure` | `block` (default) or `allow`. Explicit fail-open weakens availability-failure protection, not structural hard blocks or malformed reviewer-result blocks. |
| `gate.hold_keepalive_ms` | Positive integer; `5000`. Keepalive interval while awaiting held tool decisions. |
| `gate.provider_timeout_ms` | Positive integer; `5000`. Per-provider timeout; independent whole-response/decision bounds still apply. |

### Decision chain and second stage

| Key | Type / default / behavior |
| --- | --- |
| `decision` | Required strict object. |
| `decision.chain` | Required nonempty ordered failover list. No duplicate or unknown provider references. |
| `decision.chain[]` | Configured provider identifier. |
| `decision.providers` | Required identifier-keyed provider record; every configured entry matters for check/full release coverage, not only selected chain entries. |
| `decision.providers.*` | Strict provider object. |
| `decision.providers.*.kind` | Required `systemone` or `openai-decisions`. |
| `decision.providers.*.base_url` | Required HTTP(S) API base/full endpoint; see endpoint rules below. |
| `decision.providers.*.api_key` | Required nonempty trusted provider credential. |
| `decision.providers.*.model` | Required nonempty provider model ID; no implicit default here. |
| `decision.providers.*.headers` | Optional trusted-provider header record. Mandatory protocol/auth headers remain adapter-controlled. |
| `decision.providers.*.headers.*` | Header string, e.g. a gateway ID; credential values remain secrets. |
| `decision.providers.*.envelope` | `none` (default) or `cloudflare`; Cloudflare envelope responses must indicate success and contain valid answers. |
| `decision.providers.*.body_extra` | Optional arbitrary JSON extension record; cannot override core model/state/questions. Match the actual provider API; not all extensions are forwarded to every adapter. |
| `decision.providers.*.body_extra.*` | Arbitrary JSON value. |
| `decision.providers.*.pricing` | Optional strict per-million-token price object; missing prices remain unknown, not zero (recognized Jev input/output defaults are adapter-specific estimates). |
| `decision.providers.*.pricing.input_usd_per_million` | Optional nonnegative number. |
| `decision.providers.*.pricing.output_usd_per_million` | Optional nonnegative number. |
| `decision.second_stage` | Optional strict trusted Anthropic Messages reviewer. Only gray results invoke it; absent reviewer leaves gray blocked. |
| `decision.second_stage.kind` | Literal `anthropic-messages`; default same. |
| `decision.second_stage.base_url` | Required HTTP(S) Messages base, not a blindly duplicated `/messages` suffix; known-host restrictions below. |
| `decision.second_stage.api_key` | Required nonempty trusted reviewer/gateway credential. |
| `decision.second_stage.model` | Nonempty string; `anthropic/claude-haiku-5.5`. Gateway-specific slug/native ID must actually be supported. |
| `decision.second_stage.headers` | Optional header record; adapter replaces protected credential headers. |
| `decision.second_stage.headers.*` | Header string. |
| `decision.second_stage.pin` | Optional JSON routing record. Runtime only uses `provider` and `providerOptions`; known-host first-party pinning remains enforced. |
| `decision.second_stage.pin.*` | Arbitrary JSON routing value; not an arbitrary reviewer body override. |
| `decision.second_stage.pricing` | Optional strict price object. |
| `decision.second_stage.pricing.input_usd_per_million` | Optional nonnegative number. |
| `decision.second_stage.pricing.output_usd_per_million` | Optional nonnegative number. |
| `classifier_reroute` | Object; defaults below. Exact Anthropic-shaped security-monitor fingerprint only, not native Codex/WorkBuddy classifier support. |
| `classifier_reroute.enabled` | Boolean; `false`. Enabling requires configured `decision.second_stage`. |
| `classifier_reroute.provider` | Literal `second_stage`; default same; not an arbitrary provider ID. |
| `classifier_reroute.model_map` | Optional record from actual client classifier model ID to trusted target model ID. |
| `classifier_reroute.model_map.*` | Nonempty model string; verify gateway-specific slugs. |

### Audit, logging and transport limits

| Key | Type / default / behavior |
| --- | --- |
| `audit` | Object; defaults below. Protect audit files even though redacted. |
| `audit.path` | Nonempty path; `~/.local/state/auto-mode-proxy/audit.jsonl` resolved from the process home in the default. Arbitrary literal `~` inside a custom path is not shell-expanded by the YAML loader. |
| `audit.redact` | Literal `true`; cannot disable redaction. |
| `log_level` | `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent`. |
| `trust_proxy` | Boolean; `false`. Forwarded addresses are logging metadata only, never management authorization. Enable only behind your authorized proxy. |
| `limits` | Object; defaults below. These do not replace fixed response safety bounds. |
| `limits.request_body_bytes` | Positive integer; `64000000` (decimal 64 MB). Oversized inbound requests return 413. |
| `limits.upstream_connect_timeout_ms` | Positive integer; `10000`. |
| `limits.upstream_read_timeout_ms` | Positive integer; `30000`. |

### Effective policy

All optional replacement lists retain defaults when omitted, but an explicit empty replacement can remove protection. Record entries replace only those entries; extras append after replacements. Changes invalidate prior reports even if version text is unchanged. See [tuning](tuning.md) and the current [data-only defaults](../src/policy/constants.ts).

| Key | Type / default / behavior |
| --- | --- |
| `policy` | Object; resolves the shared default policy when omitted. |
| `policy.version` | Optional nonempty identity override; source default `c12.1`. |
| `policy.questions` | Optional strict six-question override object; noul question types remain fixed. |
| `policy.questions.destructive` | Optional question override. |
| `policy.questions.destructive.instructions` | Optional nonempty instructions. |
| `policy.questions.destructive.criteria` | Optional strict true/false criteria override. |
| `policy.questions.destructive.criteria.true` | Optional nonempty true criterion. |
| `policy.questions.destructive.criteria.false` | Optional nonempty false criterion. |
| `policy.questions.exfiltration` | Optional question override. |
| `policy.questions.exfiltration.instructions` | Optional nonempty instructions. |
| `policy.questions.exfiltration.criteria` | Optional criteria object. |
| `policy.questions.exfiltration.criteria.true` | Optional nonempty true criterion. |
| `policy.questions.exfiltration.criteria.false` | Optional nonempty false criterion. |
| `policy.questions.remote_code_exec` | Optional question override. |
| `policy.questions.remote_code_exec.instructions` | Optional nonempty instructions. |
| `policy.questions.remote_code_exec.criteria` | Optional criteria object. |
| `policy.questions.remote_code_exec.criteria.true` | Optional nonempty true criterion. |
| `policy.questions.remote_code_exec.criteria.false` | Optional nonempty false criterion. |
| `policy.questions.security_weakening` | Optional question override. |
| `policy.questions.security_weakening.instructions` | Optional nonempty instructions. |
| `policy.questions.security_weakening.criteria` | Optional criteria object. |
| `policy.questions.security_weakening.criteria.true` | Optional nonempty true criterion. |
| `policy.questions.security_weakening.criteria.false` | Optional nonempty false criterion. |
| `policy.questions.outside_scope` | Optional question override. |
| `policy.questions.outside_scope.instructions` | Optional nonempty instructions. |
| `policy.questions.outside_scope.criteria` | Optional criteria object. |
| `policy.questions.outside_scope.criteria.true` | Optional nonempty true criterion. |
| `policy.questions.outside_scope.criteria.false` | Optional nonempty false criterion. |
| `policy.questions.matches_user_request` | Optional question override. |
| `policy.questions.matches_user_request.instructions` | Optional nonempty instructions. |
| `policy.questions.matches_user_request.criteria` | Optional criteria object. |
| `policy.questions.matches_user_request.criteria.true` | Optional nonempty true criterion. |
| `policy.questions.matches_user_request.criteria.false` | Optional nonempty false criterion. |
| `policy.thresholds` | Object; defaults below. All values probabilities in [0,1]; risk_allow must be strictly below risk_block. |
| `policy.thresholds.risk_block` | Probability; `0.70`. Any of the four risk probabilities at/above this blocks first. |
| `policy.thresholds.risk_allow` | Probability; `0.30`. All four risks at/below this plus outside-scope boundary permits allow. |
| `policy.thresholds.intent_mismatch` | Probability; `0.30`. User-match at/below this plus intent_risk condition blocks. |
| `policy.thresholds.intent_risk` | Probability; `0.50`. Any four-risk value at/above this plus mismatch condition blocks. |
| `policy.thresholds.outside_scope_allow` | Probability; `0.50`. Outside-scope at/below this is needed for allow. Remaining results are gray. |
| `policy.user_request_max_chars` | Optional positive integer ≤1000; may only lower the latest-user-text limit. |
| `policy.write_content_max_bytes` | Optional positive integer ≤2048 UTF-8 bytes; truncated writes still block independently of providers/fail-open. |
| `policy.readonly_programs` | Optional replacement membership list; cannot expand beyond audited metadata capabilities. |
| `policy.readonly_programs[]` | Nonempty program name. |
| `policy.readonly_git_subcommands` | Optional replacement membership filter; cannot authorize helper-capable Git beyond restricted rev-parse metadata forms. |
| `policy.readonly_git_subcommands[]` | Nonempty subcommand string. |
| `policy.shell_unsafe_programs` | Optional replacement unsafe-wrapper/program list. |
| `policy.shell_unsafe_programs[]` | Nonempty string. |
| `policy.shell_interpreters` | Optional replacement interpreter list. |
| `policy.shell_interpreters[]` | Nonempty string. |
| `policy.find_unsafe_arguments` | Optional replacement unsafe-find-argument list. |
| `policy.find_unsafe_arguments[]` | Nonempty string. |
| `policy.git_unsafe_arguments` | Optional replacement unsafe-Git-argument list. |
| `policy.git_unsafe_arguments[]` | Nonempty string. |
| `policy.readonly_unsafe_arguments` | Optional program-keyed replacement-entry record. |
| `policy.readonly_unsafe_arguments.*` | List of disallowed argument strings for this entry. |
| `policy.readonly_unsafe_arguments.*[]` | Nonempty string. |
| `policy.readonly_positional_limits` | Optional program-keyed replacement-entry record. |
| `policy.readonly_positional_limits.*` | Nonnegative safe integer maximum positional arguments. |
| `policy.download_programs` | Optional replacement downloader list. |
| `policy.download_programs[]` | Nonempty program string. |
| `policy.file_write_programs` | Optional replacement write-program list. |
| `policy.file_write_programs[]` | Nonempty program string. |
| `policy.inplace_write_programs` | Optional replacement in-place-write list. |
| `policy.inplace_write_programs[]` | Nonempty program string. |
| `policy.hard_deny_commands` | Optional replacement hard-deny command list. |
| `policy.hard_deny_commands[]` | Nonempty command string. |
| `policy.hard_deny_target_patterns` | Optional strict replacement-entry object. RegexSpec is `{source,flags?}`; invalid/duplicate/unsupported flags fail loading. |
| `policy.hard_deny_target_patterns.root` | Optional root-target RegexSpec. |
| `policy.hard_deny_target_patterns.root.source` | Required regex source string (may be empty). |
| `policy.hard_deny_target_patterns.root.flags` | Optional valid JavaScript regex flags. |
| `policy.hard_deny_target_patterns.home` | Optional home-target RegexSpec. |
| `policy.hard_deny_target_patterns.home.source` | Required regex source string. |
| `policy.hard_deny_target_patterns.home.flags` | Optional regex flags. |
| `policy.hard_deny_target_patterns.authorized_keys` | Optional authorized-keys RegexSpec. |
| `policy.hard_deny_target_patterns.authorized_keys.source` | Required regex source string. |
| `policy.hard_deny_target_patterns.authorized_keys.flags` | Optional regex flags. |
| `policy.hard_deny_target_patterns.device` | Optional device-target RegexSpec. |
| `policy.hard_deny_target_patterns.device.source` | Required regex source string. |
| `policy.hard_deny_target_patterns.device.flags` | Optional regex flags. |
| `policy.hard_deny_patterns` | Optional replacement pattern array. |
| `policy.hard_deny_patterns[]` | Strict pattern entry. |
| `policy.hard_deny_patterns[].id` | Required nonempty rule ID. |
| `policy.hard_deny_patterns[].pattern` | Required RegexSpec. |
| `policy.hard_deny_patterns[].pattern.source` | Required regex source string. |
| `policy.hard_deny_patterns[].pattern.flags` | Optional regex flags. |
| `policy.sensitive_path_globs` | Optional replacement sensitive-path list, including reads/control files. |
| `policy.sensitive_path_globs[]` | Nonempty glob string. |
| `policy.redaction_patterns` | Optional replacement redaction pattern array; literal configured credentials remain independently redacted. |
| `policy.redaction_patterns[]` | Strict redaction entry. |
| `policy.redaction_patterns[].type` | Required nonempty redaction category. |
| `policy.redaction_patterns[].pattern` | Required RegexSpec. |
| `policy.redaction_patterns[].pattern.source` | Required regex source string. |
| `policy.redaction_patterns[].pattern.flags` | Optional regex flags. |
| `policy.redaction_patterns[].replacement` | Optional string, including empty; omitted becomes `[REDACTED:<type>]`. JavaScript capture substitutions apply. |
| `policy.redaction_sensitive_keys` | Optional structured-key RegexSpec replacement. |
| `policy.redaction_sensitive_keys.source` | Required regex source string. |
| `policy.redaction_sensitive_keys.flags` | Optional regex flags. |
| `policy.readonly_allow_extra` | Array; `[]`; appended membership candidates only, not authority to approve content reads/custom executables. |
| `policy.readonly_allow_extra[]` | Nonempty program name. |
| `policy.hard_deny_extra` | Array; `[]`; append deny regular expressions. |
| `policy.hard_deny_extra[]` | Nonempty regex source, validated with `iu` flags. |
| `policy.sensitive_paths_extra` | Array; `[]`; append sensitive-path globs. |
| `policy.sensitive_paths_extra[]` | Nonempty glob string. |

<!-- config-schema:end -->

## Conditional and runtime contracts

### Routes and tools

Only supported Messages/Responses/Chat generation endpoints have tool-use enforcement. Prefix-free inference must have an unambiguous upstream for the protocol. Unknown/opaque endpoints remain transport paths, not a safe way to execute tools. Use the canonical generation paths in [README](../README.md); don't rely on redirects or arbitrary aliases.

Trusted `project_dirs` and actual client path context—not the server's filesystem—bound path reasoning. Path checks are lexical, not symlink/junction resolution. Visible execution/write/URL/MCP clues and known content-read capabilities take precedence over generic-other mappings; unavailable execution context and truncated writes block. **Genuine other, explicit tool_map other and Task/Todo management exemptions still directly allow**, so hidden capabilities, mapping errors and invisible delegation remain risks. There is no config switch that turns this into a sandbox.

Hard denies precede sensitive checks, which precede content-read review, bounded metadata exemptions and other allow. Known content reads require approval even in project scope. Metadata membership alone cannot bypass unsafe argument/syntax/path restrictions; Git's exemption is restricted `git --no-pager rev-parse` with supported metadata flags, not general status/diff/log. [Tuning](tuning.md) explains exact capability boundaries and report invalidation.

### Endpoints, trusted review and classifier routing

System One appends `/v1/systemone` to a host root (or `/api`), `/systemone` to a `/v1` base, and otherwise preserves a complete endpoint, including Cloudflare run/model URLs or explicit OpenRouter `/api/alpha/decisions`. OpenAI Decisions uses its Decisions endpoint, not Chat Completions. Configure the accepted model/path based on authorized live evidence; defaults and mocks do not establish that evidence.

The reviewer takes an Anthropic-compatible **base**. Known public hosts are restricted: OpenRouter `https://openrouter.ai/api/v1`; Vercel `https://ai-gateway.vercel.sh` or `/v1`; native Anthropic `https://api.anthropic.com` or `/v1`; Cloudflare `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`. It appends the appropriate `/messages` path. Known hosts require HTTPS/default TLS port. Native/Cloudflare use native model IDs where required; don't copy a gateway-prefixed model blindly.

OpenRouter reviewer routing forces `provider.only: [anthropic]` with `allow_fallbacks: false`; Vercel forces `providerOptions.gateway.only: [anthropic]`. These are independent trust constraints, not ZDR claims. `pin` only contributes `provider` / `providerOptions`; it cannot replace model, prompt or output format. Vercel can combine its first-party route with eligible ZDR; shared OpenRouter first-party Anthropic is excluded by current Anthropic ZDR enforcement. Do **not** pretend both OpenRouter requirements are satisfiable by adding `zdr:true`; choose a provider/deployment with compatible independently audited terms. Cloudflare ZDR is Unified Billing only, not this schema's automatic privacy guarantee. See [primary-source qualifications](threat-model.md#privacy-and-zero-data-retention).

Classifier rerouting requires second_stage and matches an Anthropic-shaped system block beginning `You are a security monitor for autonomous AI coding agents`, with no tools. This does not support native Codex/WorkBuddy classifier formats; ordinary requests containing approval language do not become trusted. Preserve classifier fields and use only trusted target credentials. The optional Claude model ENV hint does not enable rerouting by itself.

### Decisions, failures and fixed safety bounds

Compare risk thresholds first, then intent mismatch, then allow boundaries; remaining valid probabilities are gray. Without second_stage gray blocks even with availability fail-open. Invalid/ambiguous reviewer output blocks; genuinely unavailable configured stages use `on_provider_failure`. Missing/non-finite/refused probabilities are not zero risk. Retried/failed stages with incomplete usage retain unknown cost, not free calls.

Fixed response bounds are not configurable schema keys: 1 MiB per tool/incomplete SSE frame, 8 MiB shared retained representations, 4 MiB reasoning subset; collection/idle/decision deadlines 60/30/60 seconds. Whole-turn identity checks, incomplete EOF, timeout/cancel and resource failure block unapproved execution. Anthropic/Responses ordered stateful suffixes may wait after a withheld execution; early/pure text is not globally buffered. Shadow does not wait/enforce.

Cache TTL 600 seconds and LRU 10000 are implementation bounds, not YAML knobs. Cache identity binds effective policy/provider configuration, normalized action and actual redacted decision context; a cache hit is not evidence of provider prompt caching. Audit logs and init stdout can still be sensitive; redact does not make arbitrary command content public. For manual UTC estimates with unknown totals retained as null, see [daily aggregation](tuning.md#reading-audit-records-and-utc-daily-estimates).
