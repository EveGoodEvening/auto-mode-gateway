# Codex through auto-mode-proxy

## Scope and prerequisites

This guide targets Codex CLI **0.164.0** and the native desktop Codex surface. CLI and Desktop are separate acceptance targets: an installed/authenticated CLI does not establish Desktop authentication or replay compatibility. See [compatibility evidence](../compat.md) for exercised results and outstanding acceptance.

Use the `/codex` route with `protocol: openai-responses`, `gate.mode: enforce`, vault authentication and the default provider-failure action `block`. Configure the actual relay and trusted decision providers before starting `auto-mode-proxy serve --config <private-config-path>`. `auto-mode-proxy init` prints setup guidance, not successful upstream/client acceptance. Use the issued **client** token, never the relay or decision key. Passthrough is permitted only with a loopback listener. **Shadow is observation, not protection:** original bytes flow without waiting for hypothetical verdicts.

Codex uses the **Responses API only**. Do not configure `wire_api = "chat"`. The proxy does not implement Codex classifier rerouting in v1: even text resembling Claude's security-monitor fingerprint stays on the Responses relay. Protection applies to supported model-generation responses, not arbitrary opaque endpoints, account sign-in or every network request made by the app.

## CLI configuration

Merge this into `~/.codex/config.toml` (or the `config.toml` in an intentionally isolated `CODEX_HOME`). Preserve unrelated user settings, avoid duplicate keys, and choose a relay-supported model whose native catalog exposes **direct tools**, not Code Mode Only. Top-level keys **must precede the first table**:

```toml
model = "<relay-supported-model>"
model_provider = "amp"

[model_providers.amp]
name = "auto-mode-proxy"
base_url = "http://127.0.0.1:8484/codex/v1"
env_key = "AMP_TOKEN"
wire_api = "responses"
supports_websockets = false
```

Provide `AMP_TOKEN` securely in the environment of the process launching Codex; do not put its value in TOML, command arguments, a repository, screenshots or diagnostic output. The base URL includes `/codex/v1`, **not** `/responses`; the generation request is `POST /codex/v1/responses`. For a remote gateway use an owned HTTPS address, not cleartext over a public interface. `supports_websockets = false` deliberately keeps generation on the protected HTTP Responses transport.

**Native model metadata matters in Codex 0.164.0.** The observed default selection `gpt-6.1-sol` has [`tool_mode: "code_mode_only"`, MultiAgent V2 and Responses-lite metadata](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/models-manager/models.json#L177-L240). That [model tool mode takes precedence over fallback feature flags](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/mod.rs#L65-L87): `features.code_mode = false` alone does **not** expose `exec_command`. Its custom `exec` accepts JavaScript, not shell-command JSON; this is **UNSUPPORTED/BLOCKED**, never an alias for `exec_command`. The first installed-client fixture correctly failed closed before any scene/decision because the actual declaration was absent.

Choose an actually provider-supported **direct-tool catalog model** for the configuration above; do not inject a replacement catalog or fake declarations. For intentional isolation, disable both `features.code_mode` and `features.code_mode_only`; `[agents] enabled = false` disables model-selected collaboration under the [native precedence rules](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/config/mod.rs#L1658-L1685). Make only explicit operator-approved configuration changes, not silent global profile changes.

The fresh **private LOCAL-MOCK** fixture selects bundled [`gpt-5.5`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/models-manager/models.json#L1340-L1398) with those code-mode flags false and agents disabled. Actual capture800 verified flat native `exec_command` and one authorized harmless positive per mode; its original strict overall result stays **FAIL**, while a separate reviewed native-input-ID interpretation report now verifies the six scoped CLI-loopback replays without changing original data or making extra tool calls. Subsequent local actual-HTTP timing AFTER892 meets the unchanged mock thresholds; the new performance code/report still await postfix independent reviews. This is not default `gpt-6.1-sol` CodeModeOnly support, a real-model/provider/cache guarantee or Desktop acceptance: native GUI remains blocked by corroborated host vendor-sandbox prerequisites, not an auth guess. All original evidence is preserved; no extra client/tool/GUI run is authorized by this guide.

Start `codex` normally. CLI 0.164 supports `--yolo` (bypasses local approvals and sandboxing) and `--approve-for-me` (automatic approval review); these are different client modes, not proxy bypasses. Keep the client's normal sandbox/approval settings for ordinary use. Neither `--full-auto` nor the removed Chat Completions transport is the current recipe. In a disposable parent-controlled denial QA workspace, test each supported mode separately, using **only** fixed harmless `printf AMP_DENIAL_PROBE` and a deterministic mock denial. Never send destructive acceptance strings to a real auto-executing agent.

## Response and history contract

The proxy withholds function calls (`exec_command`, `write_stdin`, legacy shell and MCP forms), custom `apply_patch` calls and local-shell execution representations until their complete action is approved and whole-turn identity uniqueness is established. A block becomes an explanatory assistant message at the same output index, with a complete message event lifecycle; terminal `output[]` must agree with delivered items. Preserve source event partial order, not a sort by output index: replacement item/part starts occupy the original added slot, while its text/done events occupy the original completion slot. For source starts `0→1→2` and completions `1→0→2`, keep those two orders independently; terminal `output[]` remains indexed `0,1,2`. Complete replacement chains may therefore interleave. Usage is preserved and outgoing SSE sequence numbers remain monotonic. Malformed/incomplete execution, identity disagreement/collision, cancellation, timeout or overflow must not release withheld execution.

Pure/early text is not globally buffered. After the first withheld execution, retain later stateful events in their original source slots until release is safe; do not reorder interleaved completions by item index. The shared limits cover retained representations and reservations, not only upstream raw bytes: 1 MiB per call/incomplete SSE frame, 8 MiB aggregate, and a 4 MiB retained-reasoning subset. Independent completion/idle/decision deadlines are 60/30/60 seconds. Shadow keeps original response bytes and does not wait for decisions.

Codex HTTP requests use `store:false` and replay prior `input`. Correct proxy wire order alone is **not** proof of correct client replay. Acceptance captures the actual immediately following client request: no blocked executable item/tool result may reappear, unrelated history must remain intact, and assistant items must follow the source completion order rather than sorted output indices. In the interleaved example above, expected assistant replay is approved item1, denial0, then marker2, even though terminal `output[]` is denial0, approved1, marker2. Do not repair request history or weaken order assertions to disguise a client reversal.

Preserve reasoning initially. Only a reproduced real-provider encrypted-reasoning/replay consistency error can justify bounded, affected-turn-only reasoning/replay stripping under the R5 contract. Mock success is not that evidence; do not blanket-strip reasoning or enable speculative compatibility defaults. At least five actual upstream conversation turns, including a block and subsequent replay, remain distinct from local mocks and need real provider access.

## Native Desktop prerequisites and configuration

### Primary-source availability, not a CLI inference

Official documentation now distributes the native desktop application as **ChatGPT**, with an explicitly selectable **Codex** surface. This is the vendor's native Codex desktop entry point, not the ChatGPT web app, a borrowed browser session, Claude Desktop or an inference that CLI support implies GUI support. The [desktop guide](https://learn.chatgpt.com/docs/app.md) explicitly says to choose Codex; the [Linux guide](https://learn.chatgpt.com/docs/linux/linux-app.md) lists Ubuntu 26.04 and x64 as supported preview targets and links the official `.deb`.

On the investigated Linux host, `/etc/os-release` identifies Ubuntu 26.04.1 LTS. No `codex`/`chatgpt` Debian package or matching launcher was established by the inspected package/launcher metadata. That does **not** mean Linux is unsupported. The [official amd64 repository metadata](https://persistent.oaistatic.com/codex-app-prod/linux/deb/dists/stable/main/binary-amd64/Packages) observed during this investigation lists `chatgpt` **26.1023.51421**, architecture `amd64`, download size 517,772,878 bytes and installed size 1,725,092 KiB. Desktop version and bundled engine must be recorded again after installation; they are not CLI 0.164 by assumption.

### Available installation/setup recipe; not an exercised GUI result

1. An authorized operator can obtain the official [Ubuntu/Debian x64 package](https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb) and follow the vendor's `apt install` instructions. Installation, dependencies, a graphical session and a regular app user are prerequisites; this documentation task did not install or launch the application. Keep the vendor sandbox intact.
2. Use an owned, writable, isolated GUI home/config for QA. Do not copy browser cookies, another user's app authentication, `~/.codex/auth.json` or OS keyring material. Configure the same provider ID/base URL/Responses-only settings above in the intended desktop user's Codex configuration. Confirm the app actually reads that configuration rather than assuming a shell's `CODEX_HOME` affects every GUI version.
3. Supply `AMP_TOKEN` to the **GUI process environment** before startup. An export in an unrelated terminal does not reach a desktop-menu launch. On Linux, launch from an authorized session that already holds the variable; on macOS, `launchctl setenv AMP_TOKEN <client-token>` affects subsequently launched GUI processes; on Windows, `setx AMP_TOKEN "<client-token>"` affects future processes, not the current app. Those platform commands contain credentials: use private operator provisioning, never checked-in scripts or captured command output. Fully quit/reopen the app after environment/config changes. Remove temporary persistent environment settings after QA.
4. Follow the native app's actual onboarding, explicitly select **Codex** and local work, choose the owned workspace, and inspect the configured model/provider. Do not infer this from a generic home chat. Capture actual generation requests through `/codex/v1/responses`, then prove the harmless denial and immediately following client replay separately in each requested permission mode.

The [official gateway guide](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway.md) documents custom providers, Linux `~/.codex/config.toml`, Responses transport and `env_key` API-key authentication independently of ChatGPT sign-in (`requires_openai_auth = false` for that gateway recipe). Do not set `requires_openai_auth = true` or send a user's OpenAI credential to this vault gateway. The [authentication reference](https://learn.chatgpt.com/docs/auth.md) separately documents desktop ChatGPT sign-in and API-key sign-in. These are supported alternatives, **not evidence** that this host's unlaunched Desktop has completed onboarding or accepts a disposable gateway credential on its initial sign-in screen. If onboarding requires an account, an authorized owner must complete its own supported authentication flow; record the exact observed screen/error instead of borrowing authentication or declaring a platform blocker from one failed guess.

For private QA, every browser/Electron/emulator or other launch expected to exceed 2 GiB must go through `~/.omp/bin/heavy-gate`; preserve other owners' slots and stop only owned processes. No GUI/CLI/model runtime was launched during prerequisite research. Real Desktop denial/replay and real-provider five-turn reasoning acceptance must remain pending until actually exercised and recorded in compatibility evidence.
