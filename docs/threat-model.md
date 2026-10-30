# Threat model and privacy

## Protected boundary

`auto-mode-proxy` sits between an agent and an **untrusted generation relay**. That relay may inject executable tool calls, forge approval explanations or upstream `safeguard_results`, or return malformed/oversized streams. An agent's own classifier routed through the same relay is not an independent safety authority. The gateway holds complete tool execution representations until protocol completion, whole-turn identity uniqueness and the required rule/provider decision permit delivery. Blocks use native Claude results where the client genuinely supports them, or replace the tool with explanatory text at its original position.

The enforcement boundary is **supported generation responses** for Anthropic Messages, OpenAI Responses and OpenAI Chat Completions. It is not every URL, metadata request, opaque endpoint, error response or network operation an agent can perform. Canonical generation requests reject untrusted redirects in enforce mode. Unknown paths are transport, not a protected alternative generation API. Clients must use the documented canonical routes and protected HTTP transport.

In enforce, untrusted upstream approvals are discarded. Pure/early text flows without waiting globally; Anthropic/Responses stateful content after the first withheld execution waits as an ordered suffix. Native wire correctness does not imply correct client replay. Claude Code **2.1.311** strict native mixed replay/exact-reason acceptance failed despite correct proxy wire order; independent local rewrite evidence does not erase that failure. See the [versioned matrix](compat.md) before choosing delivery overrides. Scoped auto fallback needs an actual correlated classifier request; version, `/status` or ordinary successful chat is not proof.

## Trusted components and assumptions

Trust the gateway host/process, source/built artifact, private configuration, effective policy, token provisioning, agent/tool implementations, executable search path, workspace context and the selected independent decision providers. Vault mode keeps relay credentials on the server and agents hold only gateway client tokens. This reduces credential distribution; it does not make the relay honest or the client environment safe. Non-loopback listeners require client tokens and forbid passthrough. Keep local listeners on literal loopback; remote use requires an owned HTTPS gateway and authorized reverse-proxy/host configuration. Forwarded IP is only log metadata, never management authority.

Decision-provider routing and credentials must be independent of the attacked relay. A differently named endpoint operated by the same adversary is not independence. Models can be fooled or unavailable. Their answers are risk estimates, not verified proofs, executable identity checks, file reads or user authorization. Retain the agent's normal sandbox, approvals and least privilege; the gateway neither executes nor safely rehearses commands to discover effects.

## Rule precedence and fail-closed behavior

1. Hard-deny/structural safety checks first: recognized destructive/download-execute/persistence patterns, unavailable execution context, malformed execution and unseen truncated-write suffixes block. Models and availability fail-open cannot override these barriers.
2. Sensitive-path checks next, including reads of credentials/control files and review of outside-project writes. Paths are lexical and interpreted in trusted **client** context; a nonmatch is not proof of file safety, and symlinks/junctions are not resolved on the remote client.
3. Known **content-reading** shell/native tools require trusted approval even for ordinary project files or seemingly approving user wording. Read/Grep capability markers are not exemptions. `cat`, `head`, `rg` and similar programs do not become safe because only a filename/count/stdin form is requested.
4. Only bounded audited metadata forms and management exemptions can directly allow. For example, Git's deterministic subset is restricted `git --no-pager rev-parse` metadata flags, not general diff/status/log. Membership settings cannot authorize arbitrary executables or helper-capable forms.
5. Other review actions use the configured ordered provider failover chain. Valid gray results use an optional trusted Anthropic second stage; **no reviewer means gray blocks** even if availability fail-open is selected. Invalid/ambiguous reviewer output blocks. Truly unavailable configured providers/reviewer follow `gate.on_provider_failure`, default **block**. Choosing `allow` weakens this boundary deliberately.

**Residual direct-allow risk:** genuine generic `Action.kind=other`, explicit `tool_map: other`, and Task/Todo management exemptions retain direct-allow semantics. Recognizable execution/write/URL/MCP and content-read clues cannot be erased by those mappings, but an unknown tool with hidden capability, a wrong mapping or **invisible Task delegation** can escape model review. Subsequent visible tool calls remain subject to the gate. Maintain actual tool declarations/mappings; do not advertise blanket unknown-tool review or sandbox protection.

Buffers are bounded: 1 MiB per tool/incomplete SSE frame, 8 MiB shared retained representations including ordered suffixes/output temporaries, with a 4 MiB reasoning subset; collection/idle/whole-decision deadlines are 60/30/60 seconds. Timeouts, duplicate IDs, malformed input, incomplete EOF, overflow and cancellation do not release pending execution. There is no early flush to escape a limit. Inbound 64 MB is a separate limit, not the response safety budget.

**Shadow is not protection.** It forwards original bytes without waiting for hypothetical verdicts, including upstream results. Use it only in a separately safe environment; a shadow audit block is not evidence that the client was denied.

## Explicit non-goals

- **Not a sandbox**, OS isolation mechanism, executable integrity check or client-filesystem authorization system. Approved commands can still have effects dependent on repository hooks, environment, executable replacement, symlinks or external state.
- **Does not prevent text tampering** by the relay. Changed assistant prose, deceptive advice, hidden instructions, data corruption and actions a human takes after reading text are outside this tool-call boundary. The original conversation can still be disclosed to the relay.
- Does not prevent every prompt injection, data disclosure, hidden delegated action, model mistake, account compromise, unsafe client plugin/hook or network request outside the configured routes.
- No guarantee of correct native replay, automatic fallback, real-provider prompt caching, latency, billing or full client compatibility without the corresponding observed evidence. Local mocks do not establish these.
- No manual approval UI, multi-tenant security isolation, Cloudflare Workers runtime, hook-based local integration or end-to-end cryptographic verification of relay content.

## Privacy and zero data retention

### What leaves the machine

The **main relay receives the agent's normal conversation** under its own policy; the gateway does not universally redact the conversation before forwarding. For tool review, the trusted decision provider receives a minimized redacted state containing the normalized action (command/path/URL or bounded write excerpt), workdir, explicitly trusted platform/project/trusted-directory/branch context where available and the actual latest user request (up to 1000 characters, or a lower configured limit). Assistant prose, tool results and Codex justification are excluded from decision state. Writes beyond the 2048-byte maximum are marked truncated and block; a digest cannot approve unseen text.

Configured credential literals and known secret patterns are redacted **before** provider-state/reason/audit truncation. Redaction is always enabled for audits, including configured header secrets. This is not a guarantee that all private source, personal data, proprietary paths or novel secrets can be recognized. Decide whether your workload may be sent to third parties at all. Gray review sends state/probabilities to another trusted service; classifier rerouting sends the matching classifier request to its configured trusted target. Those services have their own policies.

Private local JSONL audit retains redacted actions, verdicts/reasons, provider/probability/latency/usage/cost and context metadata; process logs can contain operational metadata. Treat both as sensitive and control retention/access/backups yourself. `init` and `token new` intentionally print client secrets to stdout; never capture them into public logs. Known redaction is defense in depth, not permission to publish complete logs or configuration.

### Gateway/provider distinctions (primary sources checked 2026-10-29)

“No training,” provider **ZDR**, gateway logging, cache retention, BYOK contract and your local audit retention are different controls. A routing flag is not proof that a provider contract applies to every endpoint, model, fallback, plugin or tool.

| Gateway | Actual documented scope and operational consequence |
| --- | --- |
| **Vercel AI Gateway** | [ZDR reference](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr) distinguishes the gateway's own content non-retention from downstream routing: downstream ZDR is not selected by default. Pro/Enterprise can enable team-wide or per-request `providerOptions.gateway.zeroDataRetention: true`; either enables filtering. BYOK keys are skipped by default unless marked compliant. Eligible first-party Anthropic routing can be combined with Vercel ZDR; the proxy forces `only: [anthropic]` for its reviewer, but **does not enable ZDR by default**. Verify the actual endpoint/model and account agreement. Pricing and availability are the vendor's current terms, not this project's billing guarantee. |
| **OpenRouter** | [ZDR reference](https://openrouter.ai/docs/guides/features/zdr) supports account/guardrail/model-group filtering and per-request `provider.zdr: true`. Current Anthropic-group ZDR removes **shared first-party Anthropic** endpoints (Bedrock/Vertex remain). The proxy's OpenRouter reviewer pins first-party Anthropic without fallbacks, so enabling that ZDR requirement conflicts with this shared route; it is not a simultaneous first-party+ZDR recipe. BYOK/private-endpoint declarations depend on your own agreements and are not independent verification. In-memory prompt caches are not treated as retention by OpenRouter, and provider-routing ZDR does not cover all plugins/server tools. The page also announces in-flight CSAM screening, including ZDR traffic, with possible legally required review/reporting/preservation; avoid an unconditional “nothing can ever be retained” claim. |
| **Cloudflare AI Gateway** | [Unified Billing ZDR](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#zero-data-retention-zdr) applies **only to eligible Unified Billing requests using Cloudflare-managed credentials**, not BYOK or other AI Gateway requests. Provider-key/stored-key precedence can make a request BYOK rather than Unified Billing. ZDR does not disable [gateway request/response logging](https://developers.cloudflare.com/ai-gateway/observability/logging/); configure logging separately. Do not infer ZDR merely from a `cf-aig-authorization` header, Cloudflare URL, Clef envelope or Workers AI gateway ID. |

Use actual provider terms and independently audited routing receipts for your deployment. The example `pin`/`body_extra` JSON extension fields are not a verified privacy contract, and no default guarantees ZDR. Never send real credentials to test an example or invent billing/retention evidence from a mock.

## Evidence and remaining risk

Local tests and safe installed-client mock proofs establish only their exercised boundaries. The current rules-only whole-corpus report can pass **offline-safety** while **numerical accuracy fails**; safe review/gray remains an effective false block in the denominator. Full release accuracy requires every configured trusted provider and the ordered chain over the complete frozen corpus/wrappers, current identities, exact archived bytes and an independently audited/authorized trusted-run receipt. A self-asserted flag, named environment, skipped provider job, stale report or mock cannot supply that trust boundary.

Actual new-user README connection, public HTTPS deployment, real-provider accuracy/latency/cache and each native client/mode are separate acceptance items. Claude native failure remains explicit; WorkBuddy's scoped Linux download 404 does not mean unsupported Linux, and its native approval mode/headers remain unknown. Follow the [compatibility ledger](compat.md), [full configuration reference](config.md) and [tuning/daily unknown-cost accounting](tuning.md) instead of treating this document as proof of those results.
