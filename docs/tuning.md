# Policy tuning

## Current implementation boundary

The auditable, data-only policy entry point is [`src/policy/constants.ts`](../src/policy/constants.ts). It owns `POLICY_VERSION`, the six positive System One `noul` questions and their true/false criteria, thresholds, readonly programs and argument restrictions, hard-deny patterns/targets, sensitive-path globs, and redaction patterns. Do not create a second copy in a provider adapter.

C06 implements **pure normalization and policy helpers**, not an installed protection gate. The running Anthropic adapter still has the explicit C05 fixture-only transparent seam; it must not receive real agent tool traffic before C08 replaces that seam. Provider calls, decision-chain thresholds, caching, audit/tail and response enforcement belong to subsequent chunks. Nothing in this document claims a real provider run, live denial, calibrated threshold, or completed security release.

The current callable helpers are:

- `parseShell(text)` in `src/policy/shell-parse.ts`: lexes shell text without executing it.
- `hardDeny(action, policy?, context?)`: returns an unconditional block reason, including unavailable execution context and truncated writes.
- `sensitivePaths(action, context, extra?)`: returns review reasons and paths. Call it **before** readonly, management or generic-other exemptions.
- `isReadonlyCommand(action, policy?, context?)`: checks parsed command segments and safe path context. A raw string checks syntax only and is not a standalone authorization decision.
- `redact(value, credentials?)` / `redactText(text, credentials?)`: redact known patterns and optionally configured literal credentials. Never send configuration secrets as state fields.
- `buildState(action, context)`: projects a redacted minimal state. Only explicitly supplied trusted environment fields are used; the raw action and classifier metadata are not copied. Actual user text comes from the protocol adapter's `RequestContext.lastUserText` (or neutral user text blocks), limited to 1000 characters. Assistant text, tool results and Codex justification are excluded. Write excerpts are bounded to 2048 UTF-8 bytes and retain `content_truncated`; a digest is not approval evidence for an unseen suffix.

## Data and configuration changes

Current `config.policy` supports these names:

- `thresholds.risk_block`, `risk_allow`, `intent_mismatch`, `intent_risk`, `outside_scope_allow` override the default thresholds for the later gate.
- `readonly_allow_extra` appends program names to the readonly classifier. This does not disable syntax, unsafe-option or sensitive-path checks. Review all supported flags and positional output arguments before adding a program; an apparently read-only program can invoke subprocesses or write files.
- `hard_deny_extra` appends regular-expression strings to hard-deny classification.
- `sensitive_paths_extra` appends path globs for review, including reads.

Question wording and redaction patterns currently change in the constants module; the schema does not offer arbitrary runtime question/redaction overrides. Do not invent unsupported YAML keys. Keep shared policy defaults and the configuration schema synchronized when intentionally changing a default.

The required classification order is: unconditional safety block/hard deny → sensitive-path review → confirmed non-sensitive readonly/management exemptions and genuine `other` allow → review. Preserve the requested generic `other` and explicit `tool_map: other` semantics; visible execution/path inputs must first normalize without hiding their capabilities. Unknown or mis-mapped tools with hidden capabilities can still bypass model review as `other`, and invisible `Task` delegation is not covered. Subsequent visible calls remain subject to the gate. These are residual risks, not a promise of a sandbox.

Never weaken a hard deny to repair an overly broad readonly entry. Sensitive reads such as `.env`, SSH private keys, PEM/key files and control/configuration paths must not be exempted by tool name or a readonly shell program. Missing path context is not proof that a read is non-sensitive. Writes outside the configured project require review. Writes with truncated content must block independently of provider answers or fail-open configuration.


Path checks are lexical only: `sensitivePaths` returns `{review, reasons, paths}`, not client filesystem authorization. `review: false` means no lexical review condition matched; client symlinks/junctions cannot be resolved here. Home and `%USERPROFILE%` expansion use only explicit trusted `ActionContext` fields, never the gateway server environment. Unresolved variables/globs or missing native-read paths require review. A write outside the project still requires review even if its destination is listed in `trusted_directories`.
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
