# WorkBuddy 接入 auto-mode-proxy

## 接入范围与前提

本指南针对 WorkBuddy 的 **OpenAI Chat Completions 自定义模型**入口，代理路由为 `/workbuddy`，协议为 `openai-chat`。先在私有配置中配置真实中转站和可信判定提供方，再启动 `auto-mode-proxy serve --config <私有配置文件路径>`。`init` 打印接入说明不代表客户端或上游已验收成功。当前原生客户端实机结果、平台与辅助请求头证据以[兼容性记录](../compat.md)为准；HTTP mock 成功不能代替实机接入、真实上游多轮或缓存命中证明。

建议使用 vault 认证、`gate.mode: enforce` 和默认的提供方失败阻断（`gate.on_provider_failure: block`）。WorkBuddy 只持有代理签发的 **amp 客户端 token**；不要把中转站 key、判定 key 填入 WorkBuddy。`shadow` 仅记录假设性判定，原始工具调用不等待判定就会送达，**不是防护模式**。passthrough 仅允许 loopback 监听；远程接入使用自有 HTTPS 地址，不通过公网明文发送 token。

## 在客户端填写

按目标版本的模型设置进入 **添加模型 → 自定义**，选择支持工具调用的实际上游模型。[官方模型配置说明](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)及其[自定义模型截图](https://download.codebuddy.ai/web/docs/19c7044b63c472703fba6bea1c92e528aa59faa6/docs/static/model-7.Buzcl1Ob.png)展示 URL、API Key、模型名称与 Tool Calling 开关；以下是代理接入目标，不是已经观察到的本机 GUI 配置：

| 字段 | 值 |
| --- | --- |
| URL | `http://127.0.0.1:8484/workbuddy/v1/chat/completions` |
| API Key | 代理签发的 amp 客户端 token |
| 模型名称 | 实际中转站支持且提供工具调用的模型 ID |
| 工具调用 | 开启 |

这里填写的是**完整 Chat Completions URL**，不是仅 `/workbuddy/v1`，不要再手工追加第二个 `/chat/completions`。代理需要实际请求为 `POST /workbuddy/v1/chat/completions`，以 `Authorization: Bearer <amp 客户端 token>` 认证；API Key 输入框填 token 本身，而不是带 `Bearer ` 的整行头值。**这是代理认证契约，不是已捕获到的 WorkBuddy Desktop 头信息。**不要把 token 写进仓库、截图、命令输出或诊断附件。官方说明中，标准模式会验证/补全 Chat 路径；“自定义协议”开启时直接发送所填 URL，跳过路径验证/补全。按所用版本确认完整路径实际到达代理，不能仅凭 UI 保存成功认定请求已被保护。

**原验收目标仍为安全中心“AI 智能审批 = 自动审批”，并且不处于“完全访问”；该目标尚未实机观察，不能声称已配置成功。**当前[官方权限模式说明](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)只列出 Default Permissions（敏感操作需要确认）和 Full Access（关闭提示），没有证实所要求的智能自动审批模式。安全调查应保留 Default Permissions、必要时由操作员确认，绝不改成 Full Access；Default Permissions 的成功也**不等于**原自动审批验收完成。[Ask/Craft/Plan](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar)是任务模式，不能冒充权限模式。保留客户端及厂商的安全边界，不关闭 sandbox、不改主机安全策略、不借用他人认证；需在目标原生版本核实该设置是否真实可用。

## 工具映射与路径

WorkBuddy 的工具名和参数依版本/插件而异。优先根据实际工具声明，在可信 route 配置中提供 `tool_map`：每个工具映射到 `command`、`file_write`、`url`、`mcp` 或 `other`，必要时用 `arg` 指定真实参数字段。不要假设所有命令工具都叫 `Bash`，也不要把含命令的工具误标为 `other`。未配置映射时使用已有启发式；工具声明中的执行描述也参与识别，但看不到的委派行为不能据此获得保障。

`tool_map: other` 和真正泛化的其他工具按现有策略直接允许，并不代表已审查隐藏命令；`Task` 等不可见委派也有残余风险。具有执行形态但输入无法解析、执行上下文不完整的动作不能凭“未知工具”名义获得执行批准。只读不等于不敏感：读取 SSH 私钥等路径仍需敏感路径策略。

`project_dirs` 必须来自受信任的 route 配置，按**客户端工作区**填写。Windows 的反斜杠、盘符和 `%USERPROFILE%` 需要按受信任的客户端路径上下文处理；不要把代理服务器的 Linux HOME 或运行代理的用户目录当成远程 Windows 用户目录。若配置无法确定目标用户目录，就不能声称 `%USERPROFILE%` 已正确展开；使用明确的客户端绝对路径，勿通过放宽项目根目录掩盖问题。

## 流式行为和失败边界

代理按 `choices[0].delta.tool_calls[].index` 聚合调用身份、工具名与 JSON 参数；调用被扣留到流末完成性、整轮身份唯一性和判定满足后才释放。混合 chunk 中的文本/`reasoning_content` 与待判工具拆分，普通文本不因出现工具就全局缓冲。阻断丢弃对应工具，追加含 `auto-mode-proxy` 的说明；只有全部调用被移除时才把 `finish_reason: tool_calls` 改为 `stop`。部分允许时保留其余工具。usage 和 `[DONE]` 保留，非流式对 `message.tool_calls` 同步处理。

共享资源边界为单工具/未闭合 SSE frame 1 MiB、整体保留表示 8 MiB、其中 reasoning 4 MiB；独立 idle/调用完成/整轮判定截止为 30/60/60 秒。异常 EOF、超限、超时或取消不能释放未批准的执行。该限制不是“原始响应小于 8 MiB 就一定接受”，原始、解码、解析及输出等同时保留的表示共享账本。

v1 **不实现 WorkBuddy 或 Codex 的客户端 classifier 改道**。可信 Anthropic classifier 改道仅适用于 Claude Code/Anthropic Messages 的指定指纹；把同样文字放进 Chat 请求不应将请求伪装成已支持的原生改道。Anthropic `safeguard_results` 也不是 WorkBuddy 的原生批准协议。

## 安全验收与证据记录

1. 在隔离的、操作员控制的 QA 工作区，先确认真实请求到达完整代理端点、模型支持工具调用、自动审批已开启且不是完全访问。不要打印原始鉴权头或完整请求体。
2. 仅由受控 Chat mock 注入固定无害命令 `printf AMP_DENIAL_PROBE`，使用确定性的可信 mock DENY；观察代理 wire 中没有被拒绝的调用、审计为 block，且客户端没有实际执行。不要把 `rm -rf` 等破坏性原验收字符串发送给会自动执行的原生客户端；这些字符串只允许 inert 协议/HTTP 测试。
3. 记录下一轮实际请求中的历史，确认被拒工具及其执行结果没有重新出现，正常内容仍能继续。再独立完成至少五轮真实上游对话，记录模型/客户端版本与错误；loopback 成功不是上游多轮成功。
4. 在授权的、脱敏的本地观测中，只记录是否实际存在 `X-Agent-Type: auxiliary` 以及关联请求类别，写入兼容性记录。**目前不能从 mock 推断该头存在或不存在**，也不能因此承诺辅助请求改道。不要保存原始头集、token、cookie 或整个请求体。

实机登录、可用 GUI、厂商支持的安装平台、目标模型工具能力和真实 relay/provider 配置是独立前提；未知项继续记 unknown，未观察到的成功不得补写。任何原生启动失败只能按该客户端的真实证据记录，不能套用 Codex/ChatGPT Desktop 的沙箱失败结论。

## 原生平台与认证：已知和未知

[官方 FAQ](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/FAQ)列出 macOS（Apple Silicon/Intel）与 Windows（x64/ARM64），并说明 Google/GitHub OAuth 登录。[Windows 安装说明](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide)要求 Windows 10 1809 或更高/Windows 11；[macOS 安装说明](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide)要求 macOS 12 或更高。安装指南要求网络连接。这些是公开文档前提，不是本机已经安装或登录的证明。

[官方首页](https://www.workbuddy.ai/)链接的[下载辅助模块](https://download.codebuddy.ai/web/workbuddy/6e15c02e35d8844ab84fb594e5cd3b3614b23b4b/assets/download-BWbWuQGT.js)明确列出 **WorkBuddy Linux x64/ARM64 的 DEB/RPM**，与独立 `ide-*` 产品标识区分。[Linux x64 DEB 官方 manifest](https://www.workbuddy.ai/v2/update?platform=workbuddy-linux-x64-deb)调查时给出版本 `5.5.2.37849279` 及[官方 HTTPS DEB 地址](https://download.codebuddy.ai/workbuddy/saas/linux-x64-deb/WorkBuddy-linux-x64-deb-5.5.2.37849279-910352f0.deb)，但 hash 字段为空；公开资料未建立 Linux 发行版/依赖要求。FAQ/菜单未列全 Linux，不能据此断言不支持；包元数据可取得也不代表已下载、安装或成功运行。调查时 Mac/Windows manifest 为 `5.9.3.42398134`，与 Linux 有版本差异，不能推断同一稳定/测试通道或相同审批 UI。目标主机已识别为 Ubuntu 26.04.1、x64（Debian 系），窄范围应用目录/包元数据审计未建立现有 WorkBuddy；官方包仍可作为获授权的私有准备路径，不能把“未安装”当成最终不可解决阻塞。原生 GUI、账号、工具声明、要求的智能审批模式和请求头仍未观察；后续准备与启动需单独记录实际证据，不能套用其他客户端的失败结论或借用浏览器认证。

**manifest 已识别，但观察到的包元数据请求均未取得包：**上述 DEB 链接不是已验证可下载的安装包。该精确 DEB URL 的首次直接 TLS HEAD 返回 **HTTP 404**（XML，`Content-Length: 502`），保留记录中的 DEB 元数据 GET 也返回 **404**。随后对[官方 Linux x64 RPM manifest](https://www.workbuddy.ai/v2/update?platform=workbuddy-linux-x64-rpm)所指向的独立 RPM URL，元数据 GET 同样返回 **404**（XML，`Content-Length: 502`）；此次仅检查响应头，未读取 body，未下载二进制包。两项 manifest 均识别 Linux `5.5.2.37849279`，但发布方 hash 字段为空，没有独立于 TLS 的包真实性验证。不能把 manifest 存在写成“下载可用”，也不能把这些特定 URL 的检索失败扩展为“Linux 不支持”、认证失败或 WorkBuddy 沙箱失败。原生调查尚无安装、GUI、智能审批模式、请求头或验收成功结论；Default Permissions、CodeBuddy CLI、Enterprise 或在线版均不能替代目标 Desktop 验收。

[腾讯 WorkBuddy Enterprise 设置](https://cloud.tencent.com/document/product/1831/137009)关于 `apiKeyHelper` 的双鉴权头说明属于不同产品/配置入口，不是 Desktop 自定义模型的运行时证据。当前 Desktop 的实际 Authorization 头形态以及 `X-Agent-Type: auxiliary` 的存在/缺失仍为 **unknown**；必须通过脱敏的实际观测确认。
