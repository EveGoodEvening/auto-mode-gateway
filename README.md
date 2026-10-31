# auto-mode-proxy

[简体中文](README.zh-CN.md) · [Configuration](docs/config.md) · [Threat model](docs/threat-model.md) · [Compatibility](docs/compat.md)

A tool-use safety gateway between coding agents and an **untrusted model relay**. It holds back executable tool calls in Anthropic Messages, OpenAI Responses and Chat Completions responses until local rules or a separately trusted decision provider allow them.

> **Important**
>
> - **Not a sandbox.** Keep your agent's own approvals, sandbox and least privilege. See the [threat model](docs/threat-model.md).
> - **No public release yet.** No npm package or GHCR image has been published; install from source as shown below.
> - **Compatibility is not live-verified.** The `init --yes` defaults (first-party Anthropic/OpenAI endpoints, OpenRouter `typesafe/jev-1.14` for decisions) are setup guidance only. See [compatibility](docs/compat.md).
> - **Data leaves your machine.** Redacted actions and context go to third-party decision providers, and the relay still sees your original conversation. Paid provider calls require your authorization, and `check` makes potentially billed calls. See [privacy](docs/threat-model.md#privacy-and-zero-data-retention).
> - **Shadow mode does not protect.** Only `enforce` (the default) withholds tool calls.

## 1. Install from source

You need Node `^24.11.0 || >=26.0.0` (not Node 25), npm 12+, an agent, an authorized relay/model, and a separately trusted decision-provider account. From a trusted checkout, in a POSIX shell:

```sh
npm ci
npm run build
PACK_FILE=$(npm pack --json | node --input-type=module -e '
let text = "";
for await (const chunk of process.stdin) text += chunk;
const entry = Object.values(JSON.parse(text)).find(value => value.name === "auto-mode-proxy");
if (!entry || typeof entry.filename !== "string") process.exit(1);
process.stdout.write(entry.filename);
')
SOURCE_DIR=$PWD
CLIENT_DIR=$(mktemp -d)
cp "$SOURCE_DIR/$PACK_FILE" "$CLIENT_DIR/$PACK_FILE"
cd "$CLIENT_DIR"
npx --yes "./$PACK_FILE" --version
npm install --no-save "./$PACK_FILE"
```

npm 12 prints `pack --json` as a name-keyed object, so the script reads the filename from it. Keep the relative `./file.tgz` form for `npx`; an absolute path may not run correctly.

## 2. Initialize and serve

```sh
umask 077
./node_modules/.bin/auto-mode-proxy init --yes --config ./config.yaml
```

`init` writes a private config and **prints a secret client token**; keep that output out of shared logs. It refuses an existing file unless you pass `--force`, and rejects symlink destinations.

The config refers to three environment variables. **Set all three**, even if you only use one agent. The values below are fake placeholders; replace them privately with your real credentials (do not commit them or leave them in shell history):

```sh
export RELAY_A_KEY='example-only-anthropic-key'
export RELAY_B_KEY='example-only-openai-key'
export OPENROUTER_API_KEY='example-only-decision-key'
./node_modules/.bin/auto-mode-proxy serve --config ./config.yaml
```

Defaults: `127.0.0.1:8484`, vault authentication, enforce mode, block on provider failure. Change the address via `listen` in the config; there is no host/port flag. A missing variable or invalid config fails instead of falling back to another key.

## 3. Connect an agent

In a second terminal, use the **client token from `init`**, not a relay or provider key, and a model your relay supports.

### Claude Code CLI

```sh
export ANTHROPIC_BASE_URL='http://127.0.0.1:8484/cc'
export ANTHROPIC_AUTH_TOKEN='<issued client token>'
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
export CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5
claude --model '<relay-supported-model>'
```

`CLAUDE_CODE_AUTO_MODE_MODEL` is only a classifier-cost hint. Before relying on classifier isolation, configure a trusted `decision.second_stage` and enable `classifier_reroute`; minimal `init` does neither.

**Claude Code 2.1.311 needs rewrite delivery:** native delivery failed client replay checks. Add `claude_delivery_by_version: { '2.1.311': rewrite }` (or `claude_delivery: rewrite`) to the `/cc` route before serving. Rewrite was verified with local mocks only and is not an automatic fallback. Claude Desktop does not read `ANTHROPIC_BASE_URL`. See the [Claude guide](docs/agents/claude-code.md).

### Codex CLI / Desktop

Set `AMP_TOKEN='<issued client token>'` in the environment and merge this into `~/.codex/config.toml` (top-level keys before any table):

```toml
model = "<relay-supported-direct-tool-model>"
model_provider = "amp"

[model_providers.amp]
name = "auto-mode-proxy"
base_url = "http://127.0.0.1:8484/codex/v1"
env_key = "AMP_TOKEN"
wire_api = "responses"
supports_websockets = false
```

Codex 0.164.0 is Responses-only; do not set `wire_api = "chat"`. Choose a model with direct shell tools, keep local approvals and sandbox on, and avoid `--yolo`. See the [Codex guide](docs/agents/codex.md).

### WorkBuddy

Under **Settings → Models → Add model → Custom**, set the full Chat Completions URL to `http://127.0.0.1:8484/workbuddy/v1/chat/completions`, the API key to the client token (no `Bearer ` prefix), and a tool-calling model with tool calling enabled. The target mode is **AI 智能审批 = 自动审批**, which has not yet been observed in the client; do not pick Full Access as a workaround. See the [WorkBuddy guide](docs/agents/workbuddy.md).

## How it decides

Hard-deny rules, unavailable or malformed execution and truncated writes block first. Then come sensitive-path checks, content reads (which need approval even inside the project), bounded metadata exemptions and direct-allow for genuine `other` and Task/Todo, and finally the trusted provider chain. Gray results without a reviewer block, invalid reviewer verdicts block, and provider failure blocks by default. Text before or without tool calls is not held back; incomplete, oversized, timed-out or cancelled responses never release a withheld call. Details: [threat model](docs/threat-model.md#rule-precedence-and-fail-closed-behavior).

Illustrative estimate, not a quote: about $0.003 per 100 decisions and $0.0002 per gray second-stage review. See [audit cost aggregation](docs/tuning.md#reading-audit-records-and-utc-daily-estimates).

## Commands

`init`, `serve`, `check`, `token new`, `audit tail`, `eval`; run `auto-mode-proxy <command> --help`. `token new` prints a secret and does not edit the config. See also [tuning](docs/tuning.md) and [evaluation](eval/README.md).

## Limitations

- Protects only supported generation endpoints; relay text tampering is out of scope.
- `gate.on_provider_failure: allow` deliberately weakens the boundary.
- Unknown tools with hidden capabilities, wrong `tool_map` entries and hidden Task delegation are residual risks.
- [deploy/](deploy/) files need your own domain, DNS and TLS; public HTTPS is not verified.
- No manual approval UI, multi-tenant isolation, Cloudflare Workers runtime or hook integration.

MIT licensed.
