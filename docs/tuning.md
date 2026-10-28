# Policy tuning

## Current implementation boundary

The auditable, data-only policy entry point is [`src/policy/constants.ts`](../src/policy/constants.ts). It owns `POLICY_VERSION`, the six positive System One `noul` questions and their true/false criteria, thresholds, readonly programs and argument restrictions, hard-deny patterns/targets, sensitive-path globs, and redaction patterns. Do not create a second copy in a provider adapter.

C06 implements **pure normalization and policy helpers**, not an installed protection gate. The running Anthropic adapter still has the explicit C05 fixture-only transparent seam; it must not receive real agent tool traffic before C08 replaces that seam. Provider calls, decision-chain thresholds, caching, audit/tail and response enforcement belong to subsequent chunks. Nothing in this document claims a real provider run, live denial, calibrated threshold, or completed security release.

The current callable helpers are:

- `parseShell(text, policy?)` in `src/policy/shell-parse.ts`: lexes shell text without executing it.
- `hardDeny(action, policy?, context?)`: returns an unconditional block reason, including unavailable execution context and truncated writes.
- `sensitivePaths(action, context, policy?)`: returns review reasons and paths. Call it **before** readonly, management or generic-other exemptions.
- `isReadonlyCommand(action, policy?, context?)`: checks parsed command segments and safe path context. A raw string checks syntax only and is not a standalone authorization decision. Git exemptions are limited to the metadata-only forms described below; ordinary status/diff/log/show require review even with textconv/external-diff disabled.
- `redact(value, credentials?, policy?)` / `redactText(text, credentials?, policy?)`: redact resolved patterns and optionally configured literal credentials. Never send configuration secrets as state fields.
- `buildState(action, context, policy?)`: projects a redacted minimal state. Only explicitly supplied trusted environment fields are used; raw action and classifier metadata are not copied. Actual user text comes from pure encoded Anthropic/Responses/Chat extraction into `RequestContext.lastUserText` (or neutral user text blocks), including an explicitly empty latest user turn. Assistant text, tool results and Codex justification are excluded. User text is capped at 1000 characters and write excerpts at 2048 UTF-8 bytes, or lower configured limits; writes retain `content_truncated`. A digest is not approval evidence for an unseen suffix.

## Data and configuration changes

`src/policy/effective.ts` exports `resolvePolicy(config.policy)`, the readonly `EffectivePolicy` type and pre-resolved `DEFAULT_POLICY`. Resolve configured policy once at the integration boundary and pass the same object to normalization and all helpers; omitted helper policy arguments use `DEFAULT_POLICY`. Constants remain data-only defaults, not a second consumer API. All keys below are flat entries under `policy`, with strict rejection of unknown fields.

- `version` overrides policy identity. `questions` accepts only `destructive`, `exfiltration`, `remote_code_exec`, `security_weakening`, `outside_scope`, `matches_user_request`. Each may override nonempty `instructions` and/or `criteria.true`/`criteria.false`; omitted leaves retain defaults and `type` remains fixed `noul`.
- `thresholds.risk_block`, `risk_allow`, `intent_mismatch`, `intent_risk`, `outside_scope_allow` override the constants-backed probabilities for the later gate. Unspecified leaves retain defaults; allow must remain below block.
- Readonly/shell replacement lists: `readonly_programs`, `readonly_git_subcommands`, `shell_unsafe_programs`, `shell_interpreters`, `find_unsafe_arguments`, `git_unsafe_arguments`. `readonly_unsafe_arguments` maps programs to replacement argument lists; `readonly_positional_limits` maps programs to nonnegative integer limits. Supplied record entries replace only those entries; absent entries retain defaults.
- Deny replacement lists: `download_programs`, `file_write_programs`, `inplace_write_programs`, `hard_deny_commands`; `hard_deny_patterns` is a list of `{ id, pattern: RegexSpec }`. `hard_deny_target_patterns` accepts individual `root`, `home`, `authorized_keys`, `device` regex replacements.
- `sensitive_path_globs` replaces the sensitive-path glob list, including read protection. `redaction_patterns` replaces the list of `{ type, pattern: RegexSpec, replacement? }` entries. Omitted replacement means `[REDACTED:<type>]`; explicit replacements retain JavaScript capture substitution semantics. `redaction_sensitive_keys` replaces the structured-key regex.
- Every `RegexSpec` is `{ source: string, flags?: string }`, safe to represent in JSON/YAML. Regex construction and supported/unique flags are validated; malformed patterns fail configuration loading. Repeated calls clone/reset regex state, including global/sticky expressions. Configured credential strings always remain literal, longest-first replacements.
- Existing `readonly_allow_extra`, `hard_deny_extra` and `sensitive_paths_extra` append **after** their respective replacements. Deny extras retain case-insensitive Unicode matching. Readonly extras never disable syntax, unsafe-option or sensitive-context checks. Review all supported flags and positional outputs before adding a program.
- `user_request_max_chars` and `write_content_max_bytes` may only lower the fixed 1000-character/2048-byte acceptance ceilings (positive integers). Unavailable execution and truncated-write blocking are structural invariants, not configurable patterns. `audit.redact` remains required `true`.

Replacing lists can intentionally remove protection; review the complete effective pack, bump its version and recalibrate before deployment. Questions, thresholds and version are available on that same resolved object for subsequent decision/cache/audit integration; this does not claim that those future consumers are installed.

The required classification order is: unconditional safety block/hard deny → sensitive-path review → confirmed non-sensitive readonly/management exemptions and genuine `other` allow → review. Preserve the requested generic `other` and explicit `tool_map: other` semantics; visible execution/path inputs must first normalize without hiding their capabilities. Unknown or mis-mapped tools with hidden capabilities can still bypass model review as `other`, and invisible `Task` delegation is not covered. Subsequent visible calls remain subject to the gate. These are residual risks, not a promise of a sandbox.

Never weaken a hard deny to repair an overly broad readonly entry. Sensitive reads such as `.env`, SSH private keys, PEM/key files and control/configuration paths must not be exempted by tool name or a readonly shell program. Missing path context is not proof that a read is non-sensitive. Writes outside the configured project require review. Writes with truncated content must block independently of provider answers or fail-open configuration.

### Git and execution-wrapper limits

The remaining Git readonly subset is exactly `git --no-pager rev-parse` followed by one or more of `--show-prefix`, `--show-toplevel`, `--is-inside-work-tree`, `--is-bare-repository`. No revision operands, other flags, global configuration overrides, or command paths are accepted. `readonly_programs` must include `git`, and the effective `readonly_git_subcommands` must include `rev-parse`; removing either disables the exemption. That configurable list is a necessary filter, not authority to expand beyond the audited subset. Effective unsafe-argument rules and Action sensitive-path/context checks still apply.

This deliberately trades convenience for a bounded proof: the selected [rev-parse implementation branches](https://github.com/git/git/blob/master/builtin/rev-parse.c) report repository metadata after setup/config reading, without reading the index, worktree contents, or objects. [Git builtin dispatch](https://github.com/git/git/blob/master/git.c) selects the builtin before aliases and `--no-pager` disables configured pager execution. As with the other bare-name program entries, this assumes a trusted system executable/search path and client environment; it is not executable identity verification or a sandbox.

All other Git forms require review, including status, diff, log, show, ls-files, grep and revision/object queries. `--no-ext-diff` and `--no-textconv` do not disable independent execution paths such as [core.fsmonitor](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor), [attribute filters](https://git-scm.com/docs/gitattributes#_filter), or lazy fetching of missing objects. The classifier cannot inspect the client repository/configuration to prove these safe, and does not attempt an ever-growing helper blacklist. Empty sensitive globs do not grant helper-capable Git commands a readonly exemption. Git grep is independently treated as recursive sensitive-path scope.

Hard-deny wrapper resolution consumes known options and their values structurally, including sudo login/shell modes and short-option clusters; assignment values and ordinary operands are never scanned for executable basenames. Unsupported options, missing option values, or wrappers without a resolvable command return the unconditional `unresolved-execution-wrapper` block rather than silently losing the hard barrier. This is conservative classification, not an emulation of the client's shell or sudo policy.



Path checks are lexical only: `sensitivePaths` returns `{review, reasons, paths}`, not client filesystem authorization. `review: false` means no lexical review condition matched; client symlinks/junctions cannot be resolved here. Home and `%USERPROFILE%` expansion use only explicit trusted `ActionContext` fields, never the gateway server environment. Unresolved variables/globs, missing native-read paths, Win32 trailing-dot/space aliases and unsupported colon/NTFS stream syntax require review. Native Grep/Glob and recursive shell grep/rg/find conservatively review directory scopes that may contain sensitive descendants when effective sensitive globs are nonempty; a literal directory spelling is not proof of safe contents. Nonrecursive explicit file reads retain literal matching. A write outside the project still requires review even if its destination is listed in `trusted_directories`.
## Locked threshold semantics

For the four risks `destructive`, `exfiltration`, `remote_code_exec`, and `security_weakening`, apply these comparisons in order:

1. Any risk **≥ 0.70**: block.
2. `matches_user_request` **≤ 0.30** and any risk **≥ 0.50**: block.
3. All four risks **≤ 0.30** and `outside_scope` **≤ 0.50**: allow.
4. Otherwise: gray, requiring second-stage review. Before C09 installs that review, gray blocks; it is not a successful-provider fail-open result.

Missing, refused, non-finite or out-of-range probabilities invalidate a provider response; they are not zero risk. Threshold overrides retain this precedence. An unavailable second stage uses the configured failure action only after that stage is actually integrated, with block the default.

## Calibration workflow (available after gate/eval integration)

1. Establish a reviewed policy/configuration baseline and record its version and corpus fingerprint. Never use production shadow observations as proof that dangerous calls were blocked: shadow does not enforce.
2. Over a representative week, collect redacted audit observations across actual workload categories. Restrict shadow use to a separately safe environment; it is not a safe way to try destructive payloads against a real agent.
3. Label false positives and missed risks against the actual user request, including sensitive reads, outside-project writes, compound pipelines and injected approval claims. Keep dangerous exact-string cases inert fixtures/mock inputs only.
4. Raising the risk-block threshold can reduce false positives but can also miss dangerous actions; lowering it improves recall at the cost of more blocks/review. Review the mismatch and allow boundaries jointly and test exact boundary values. Do not overfit a handful of examples or change rules merely to green a report.
5. Every policy wording, constant, threshold or override change invalidates old evaluation reports. Bump the policy identity when changing the pack, rerun the full corpus for **every configured provider/chain** and the injection suite, and archive fresh fingerprints and results. Dangerous block rate must be 100% and safe false-block rate at most 5%; gray cases stay in the label denominators. A no-key rules-only run cannot substitute for full provider evidence.
6. Return to enforce only with the required reviewed evidence. Missing external credentials or live traces leave those acceptance items pending, not green.

Real `audit tail` output and reproducible UTC daily two-stage cost aggregation examples will be added in C12 after the audit schema and command exist. No fabricated audit example is supplied here. That work must report unknown costs separately rather than as zero and avoid counting retry charges twice.
