# auto-mode-proxy

[English](README.md) · [完整配置](docs/config.md) · [威胁模型](docs/threat-model.md) · [兼容性](docs/compat.md)

部署在编程 agent 与**不可信模型中转站**之间的工具调用安全网关。它扣留 Anthropic Messages、OpenAI Responses、Chat Completions 响应中的可执行工具调用，直到本地规则或独立可信判定提供方允许后才放行。

> **重要提示**
>
> - **不是沙箱。** 保留 agent 自身的审批、sandbox 与最小权限。见[威胁模型](docs/threat-model.md)。
> - **尚未公开发布。** 没有已发布的 npm 包或 GHCR 镜像；请按下文从源码安装。
> - **兼容性未经实测。** `init --yes` 的默认值（Anthropic/OpenAI 第一方端点、OpenRouter `typesafe/jev-1.14` 判定）只是配置指引。见[兼容性](docs/compat.md)。
> - **数据会离开本机。** 脱敏后的动作与上下文会发送给第三方判定提供方，relay 仍能看到原始会话。付费调用需要你的授权，`check` 会发起可能计费的调用。见[隐私](docs/threat-model.md#privacy-and-zero-data-retention)。
> - **Shadow 模式不防护。** 只有 `enforce`（默认）会扣留工具调用。

## 1. 从源码安装

需要 Node `^24.11.0 || >=26.0.0`（不含 Node 25）、npm 12+、目标 agent、经授权的 relay/模型，以及独立可信判定提供方账户。在可信 checkout 中，使用 POSIX shell：

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

npm 12 的 `pack --json` 输出是以包名为键的对象，脚本从中读取文件名。`npx` 请保持相对路径 `./文件名.tgz`；绝对路径可能无法正确运行。

## 2. 初始化并启动

```sh
umask 077
./node_modules/.bin/auto-mode-proxy init --yes --config ./config.yaml
```

`init` 写入私有配置并**打印一个秘密客户端 token**；请勿将输出写入共享日志。已有文件默认拒绝覆盖（需显式 `--force`），符号链接目标始终拒绝。

配置引用三个环境变量。即使只用一个 agent，也**必须全部设置**。以下为假占位值，请私下替换为真实凭证（勿提交，勿留在 shell 历史中）：

```sh
export RELAY_A_KEY='example-only-anthropic-key'
export RELAY_B_KEY='example-only-openai-key'
export OPENROUTER_API_KEY='example-only-decision-key'
./node_modules/.bin/auto-mode-proxy serve --config ./config.yaml
```

默认：`127.0.0.1:8484`、vault 认证、enforce 模式、提供方失败时 block。监听地址通过配置中的 `listen` 修改，没有 host/port 参数。缺少变量或配置非法时直接失败，不会改用其他 key。

## 3. 连接 agent

在第二个终端中，使用 **`init` 签发的客户端 token**（不是 relay 或判定 key），以及 relay 实际支持的模型。

### Claude Code CLI

```sh
export ANTHROPIC_BASE_URL='http://127.0.0.1:8484/cc'
export ANTHROPIC_AUTH_TOKEN='<issued client token>'
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
export CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5
claude --model '<relay-supported-model>'
```

`CLAUDE_CODE_AUTO_MODE_MODEL` 只是 classifier 成本提示。依赖 classifier 隔离前，需配置可信 `decision.second_stage` 并启用 `classifier_reroute`；最小 `init` 两者都不做。

**Claude Code 2.1.311 需要 rewrite 投递：** native 投递未通过客户端回放检查。启动前在 `/cc` route 中加入 `claude_delivery_by_version: { '2.1.311': rewrite }`（或 `claude_delivery: rewrite`）。rewrite 仅经本地 mock 验证，且不是自动 fallback。Claude Desktop 不读取 `ANTHROPIC_BASE_URL`。见 [Claude 指南](docs/agents/claude-code.md)。

### Codex CLI / Desktop

在环境中设置 `AMP_TOKEN='<issued client token>'`，并将以下内容合并到 `~/.codex/config.toml`（顶层键须位于任何 table 之前）：

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

Codex 0.164.0 仅支持 Responses，不要设置 `wire_api = "chat"`。选择支持直接 shell 工具的模型，保持本地审批与 sandbox 开启，避免 `--yolo`。见 [Codex 指南](docs/agents/codex.md)。

### WorkBuddy

在 **设置 → 模型 → 添加模型 → 自定义** 中，将完整 Chat Completions URL 设为 `http://127.0.0.1:8484/workbuddy/v1/chat/completions`，API Key 填客户端 token（不加 `Bearer ` 前缀），选择支持工具调用的模型并开启工具调用。目标模式为 **AI 智能审批 = 自动审批**，尚未在客户端中观察到；不要用 Full Access（完全访问）绕过。见 [WorkBuddy 指南](docs/agents/workbuddy.md)。

## 判定方式

硬拒绝规则、不可用或畸形的执行、截断写入首先阻断。然后依次是敏感路径检查、内容读取（即使在项目内也需审批）、有界元数据豁免与 genuine `other`、Task/Todo 的直接允许，最后是可信判定链。没有二审时灰区阻断，二审结果非法也阻断，提供方故障默认阻断。工具调用之前或不含工具调用的文本不会被扣留；不完整、超限、超时或取消的响应绝不会放出被扣留的调用。详见[威胁模型](docs/threat-model.md#rule-precedence-and-fail-closed-behavior)。

仅供说明的估算，不是报价：每 100 次判定约 $0.003，每次灰区二审约 $0.0002。见[审计成本聚合](docs/tuning.md#reading-audit-records-and-utc-daily-estimates)。

## 命令

`init`、`serve`、`check`、`token new`、`audit tail`、`eval`；运行 `auto-mode-proxy <command> --help` 查看说明。`token new` 打印 secret，不会修改配置。另见[调参](docs/tuning.md)与[评测](eval/README.md)。

## 局限

- 仅保护受支持的生成端点；relay 篡改文本不在范围内。
- `gate.on_provider_failure: allow` 会有意削弱该边界。
- 具有隐藏能力的未知工具、错误的 `tool_map` 条目、隐藏的 Task 委派是残余风险。
- [deploy/](deploy/) 中的文件需要自有域名、DNS 与 TLS；公网 HTTPS 未经验证。
- 不提供人工审批 UI、多租户隔离、Cloudflare Workers 运行时或 hooks 集成。

MIT 许可。
