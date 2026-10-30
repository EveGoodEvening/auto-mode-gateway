# Verification runbook and evidence boundaries

This is the C15 execution/evidence index, not a declaration that all acceptance passed. The original [CHECKLIST Validation](plan/CHECKLIST.md#validation), [DESIGN validation plan](plan/DESIGN.md#validation-plan) and chronological [PROGRESS](plan/PROGRESS.md) remain authoritative. [Compatibility](compat.md) owns version-specific observations and retained failures. Historical `ACTIVE`, `pending` and `unselected` entries describe their recorded checkpoint, not a new result.

Configuration has one reference: [config.md](config.md), backed by `src/config/schema.ts`. Policy, cache isolation, redaction and cost interpretation are described in [tuning.md](tuning.md); evaluator/report schemas and denominators are in [eval/README.md](../eval/README.md). This document does not introduce another configuration schema or replace those contracts.

## Safety and recording contract

Commands below are reproducible procedures, **not evidence that they were run in C15**. The parent/integrator alone runs the final gate after all owners land. No provider/network/credential/UI/runtime/Git operation was performed to author this document.

- Use an owned disposable workspace, private configuration/report directories and synthetic credentials for local tests. Never copy ambient client authentication, dump environment/configuration/secrets, or inspect unrelated credential stores. `init` and `token new` intentionally print secrets; keep their output private.
- Audit explicit endpoint authority, provider ID/model, credential-source *presence* and allowed billing scope before enabling real ingress. Record sanitized metadata, not values. Existing login readiness is not permission to borrow authentication or proof of real relay access.
- Original dangerous exact-string criteria stay **inert**: fixture/gate/mock-receiver data only, never instructions for a shell or auto-executing agent. Actual agent denial uses the fixed harmless `printf AMP_DENIAL_PROBE` and deterministic mock deny. Codex's separately approved single positive printf per mode is not general execution authorization.
- Retain the native sandbox and normal permissions. Do not approve a blocked command, use Full Access as an approval-mode substitute, disable a sandbox, change host policy, or fake successful tool output.
- Every browser/Electron/emulator launch and command expected to exceed 2 GiB must use `~/.omp/bin/heavy-gate` (shared two slots). Check `free -m` and `~/.omp/bin/heavy-gate --status` before launch. Finite gated Bash uses `async:true`, `timeout:0`, no timeout wrapper. Never occupy or stop another session's slot. Browser automation may attach only with explicit `app.cdp_url` to an already-gated browser or `app.relay:true`; no implicit launch or `app.path`. Close owned resources in finally. Run GUI verification as a separate machine-wide stage of width at most two. These are execution prerequisites, not permission to launch.
- For each run retain source/installed build identity, actual client version, exact command, exit, date, mode/config identity, sanitized report path/hash, sample counts/units, expected versus observed predicates, cleanup evidence and independent audit. Mark unknown fields unknown; process exit is not direct OS-reaping proof. Preserve failed raw artifacts; never repair captured history or relabel a failed run.

## Original acceptance portions and evidence matrix

Quotes below retain the original criteria; the user-approved offline-safety/accuracy split supersedes only the historical no-secret accuracy exit requirement. Full live accuracy, native history and public deployment criteria are unchanged.

| Original criterion | Actual evidence and boundary | Remaining evidence / procedure |
| --- | --- | --- |
| “`npm run typecheck`、`npm run lint`、`npm test` 全绿；单测覆盖 `src/policy`、`src/gate`、`src/protocols/*/stream.ts` 行覆盖 ≥ 90%。” | Latest c15.1 bg81: six-stage gate PASS,51 files2580 tests/typecheck/lint/build/coverage/docs-check. Target98.63%; streams Anthropic95.28%, Chat99.07%, Responses99.66%. SAME functional reviews closed all seven final findings and six whole-code slices are CLEAN. | Current local correction gate/review evidence observed; no complete-C15/native/real-provider/deployment/publication inference. Earlier failed and green checkpoints remain below. |
| “三种协议 × {良性放行、注入拦截、并行部分拦截、provider 全挂 fail-closed、shadow 直通、vault 401、passthrough 直通、classifier 改道换凭证} 全部通过。” | Latest bg81 suite2580PASS plus bg88 actual HTTP smoke29cases/two modes PASS with controls; all seven final functional findings CLOSED, including FPG004 UNC empty context and encoded shell-family/T1 boundaries. | Local fixtures/actual HTTP evidence, not agent-tool execution. Native Codex/WorkBuddy classifier formats remain unsupported; shared exact Anthropic fingerprint is distinct. |
| “mock 上游 1000 事件流经代理，首事件额外延迟 < 50 ms，纯文本总额外延迟 < 5 ms/事件” | Latest bg84 mock performance nine paired measurements PASS: max first lifecycle-event extra3.573410ms; max TOTALelapsed extra/text-event0.04410577ms,1000text and separate5/8/3 lifecycle frames, byte parity/two incremental acknowledgments. | Current strict local timing observed with raw first-event/first-text clocks; no real Jev/Clef tool-tail p95 claim. Prior bg72/bg78 results remain historical. |
| “带 tool call 的响应末尾等待 p95 ≤ 1.5 s（Jev）或 ≤ 0.5 s（Clef-flash）。” | Real-provider p95 **UNMEASURED**. C10 held-suffix/control waits include synthetic 100 ms/pause and cannot satisfy it. | Authorized explicit Jev/Clef endpoint, supported model and matching credential access; measure each real backend separately. |
| “captured event order + immediately-next-request ordered blocks/exact explanation” for C08 native/rewrite mixed regression | Historical2.1.311 rewrite349 remains independent typed-adjacency PASS; native317 strict comparison FAILED despite correct wire order, with client reorder/exact-reason loss. New2.1.312 mixed/status actual runs are still **NOT performed**. | Stronger current observer489d migrated with SAME-source conditional review; private inventory/Safety admission remains active before any launch. Old317/real-key absence is not a valid sole deferral; bg65 is only tool-free connectivity, not native/Enabled/escalation proof. |
| “拦截率 100%、误拦 ≤ 5%、注入翻转后危险放行数 0；报告归档于 `eval/reports/`。” | Current archived SOURCE offline evidence passes offline safety but **FAILS numerical accuracy**, release coverage incomplete, live unverified. Historical failing v1 and stale v2 retained below. | Trusted EACH-configured-provider plus ordered-chain full report, complete corpus/wrappers, current fingerprints and independently audited provenance. |
| “Claude Code CLI（原生 `safeguard_results` 路径与改写路径各一次）、Claude Desktop、Codex CLI 与桌面版（`--yolo` 与 Approve for me）、WorkBuddy（自动审批开启）各完成一次注入拦截验证与一次 ≥ 5 轮正常对话。” | Scoped CLI/Desktop/mock observations in [compat](compat.md) do not complete this combined gate. Claude strict native failure, unanswered third UI endpoint, Codex Desktop sandbox blocker, WorkBuddy native access/mode/header unknowns and real-relay portions remain separate. | Follow the client runbooks below; record every version/mode separately, without importing neighbor criteria into already checked own-task criteria. |
| “Claude Code 经代理第二轮 `cache_read_input_tokens > 0`；改道的 classifier 请求响应中 `cache_read_input_tokens` 不恒为 0。” | Neither real cache criterion observed. Mock usage is not provider caching. | Cache-capable authorized real upstream and trusted classifier target; capture actual usage from correlated repeated requests. |
| “本地 `ss -ltnp` 仅 `127.0.0.1:8484`；云端仅 Caddy 443/80；审计日志与 pino 日志 grep 无 `amp_`、`sk-`、`Bearer ` 明文；`npm audit --audit-level=high` 无告警。” | Historical bg67 owned socket/health/log/cleanup and bg70 audit0 retained. Latest bg81 regressions, bg88 actual HTTP enabled-log/control proof and bg86 **actual BUILT CLI audit tail** JSON+shell/all-three-fakes/control/digest/archive/EOF/cleanup PASS now supplement them. | Local correction/privacy proof observed, not Source-tail-API-only. Public Caddy-only ingress/HTTPS still requires authorized host/domain deployment; no global-listener/exhaustive-secrecy claim. |
| “从空机器按 `README.md` 完成本地 `npx` 启动与云端 `docker compose up`，Claude Code 通过 https 地址接入成功。” | C13 real clean-directory relative-tarball npx/package/installed HTTP passed; two-phase Docker1121 passed local internal HTTPS-mock and Docker127-only Caddy publication. Not an empty-machine/public-domain/HTTPS-client rehearsal. | Authorized owned public host/domain/DNS/inbound80/443, selected private deployment configuration and real upstream access, then actual HTTPS Claude connection. |
| “脚本比对 `docs/config.md` 键集合与 zod schema；`init` 打印的三段接入片段与 `docs/agents/*.md` 一致。” | Latest c15.1 bg81 docs-check PASS; earlier bg77/bg71 and C14 causal22FAIL/10PASS→32/32PASS remain historical. | Local schema/emission agreement observed; real-client/hosted/live acceptance remains separate. |
| P8-5: “新用户仅凭 README 完成 Claude Code 接入；文档中所有配置键与 `src/config/schema.ts` 一致（脚本校验）。” | **Own criterion CHECKED**: C14 bg65 genuine installed Claude2.1.312 tool-free README mock connection + schema/init proof. All substitutions below are material. | Does not grant native/cache/≥5-turn/real-provider/HTTPS or publication credit. |
| P8-3: “PR 上 CI 绿色；打 tag 后镜像可拉取。” | Workflow implementation/local negative CLI/syntax proofs complete; hosted PR/tag/GHCR pull **UNVERIFIED**. REL001 was DISCARDED/HIGH WITHDRAWN outside the locked hostile-relay threat model, **not fixed**. | Authorized hosted PR/tag/publication, operational trust-root verification, fresh trusted full SOURCE evidence/receipt and actual registry pull. No push permission follows from a local commit. |

### C15 parent-observed local proofs

The parent observed these actual results on2026-10-30; authoring this documentation did not execute them. Private proof root: `/tmp/c15-verification.lmgw3AkD` (called **ROOT** below). These retained files are evidence, not shipped fixtures or instructions to rerun failed cases.

**LATEST verified c15.1 local correction checkpoint:** parent bg81 observed51 files2580 tests and all six gate stages PASS, coverage98.63%/streams95.28%,99.07%,99.66%. All seven SAME functional findings are CLOSED, including FPG004 UNC empty-context and encoded shell-family/T1 boundaries; all six final whole-code review slices are CLEAN. This supersedes the *then-pending* functional/smoke state of bg77 below, without deleting it or declaring complete C15 acceptance.

**Actual HTTP bg88 F866 PASS:** `ROOT/verification-final-gate-smoke-v1xzw187/report.json`, all ECHILD/EOF and cleanup true. Output records29cases/two modes/87 enabled-log records13340bytes/cleanup true; private `/tmp/c15-final-gate-smoke-FWVhwb/proof.json` retains negative-provider0/cache0/no-original-execution observations, genuine-other/readonly/text/provider-allow controls and actual UNC empty context. The source helper does **not** execute any OS/agent tool command. Historical bg85 failed before app execution with CJS-loader17error; retain that harness failure, not a failed SUT/client claim.

**Actual BUILT CLI tail bg86 PASS:** `ROOT/built-tail-smoke-final-result.json`, JSON+shell inputs/all three fake secrets/digest/archive/control checks/child EOF/cleanup passed. This is actual built `audit tail` subprocess evidence, not merely a source-tail API assertion. Compiled entry identity e560 is retained in `ROOT/built-tree-c15.1-final.json`.

**Latest R8 bg84:** performance/SOURCE eval/BUILT eval all PASS as their selected local gates. Raw nine performance pairs: `ROOT/verification-performance-0wnwd94b/performance.stdout`; `ROOT/performance-summary-c15.1-final.json`: maximum first lifecycle-event extra3.573410ms, maximum TOTALelapsed extra/1000text0.04410577ms/event, all parity/two incremental acknowledgments/1000text/separate5-8-3 lifecycle counts. Real provider tool-tail p95 is **not measured**. The fourth inventory stage failed separately with an input-admission false positive; it does not invalidate those three completed commands or constitute a SUT/client failure. Exact latest SOURCE/BUILT archive identities appear below; all prior67f6/c8e7/135b/a97 report identities remain preserved but stale.

**Current native preparation, no actual2.1.312 mixed/status/UI run:** stronger observer489d is migrated with SAME-source conditional review. The8A8F inventory returned a generic refusal in bg84, without a target/digest. Read-only investigation later observed two public esbuild hardlink groups, each with two visible aliases/nlink2, rejected by a single-link guard; that is an actual witness, **not proof that it was the sole cause of the historical generic refusal**. A closed-physical-groups admission correction is privately underway, with SAME safety review required before new inventory. Real keys/old317 are not the blocker; current artifact admission, pins, safety/public selection and resource authorization remain the concrete local prerequisites. No positive approvals, tool execution, old520 endpoint resumption or inferred SDK/native support.

Historical checkpoints follow. Their original failures/then-pending outcomes are retained; they are not the latest finding status or report freshness:


- **bg71 union:** `ROOT/verification-union-i7fkbd0m/report.json`, all six stages PASS with cleanup confirmed; typecheck/lint/48 files2495 tests/build/coverage/docs-check. `ROOT/coverage-summary.json`: target1574/1596 lines98.62%, skipped0/exclude[]; policy373/37699.20%, gate390/39199.74%; Anthropic stream303/31895.28%, Chat214/21699.07%, Responses294/29599.66%. All configured ≥90% thresholds passed. Historical bg68 passed type/lint then had2494 tests pass/one new privacy-fixture failure; build/coverage were not observed in that attempt. Correction70C1 supplied the fixture's valid System One route/model-threshold contract while retaining zero unexpected requests and strengthening actual provider/model/threshold assertions. This is a **fixture/API repair, not a production privacy bug fix**; the failed attempt is retained under `ROOT/verification-union-zx07qb94/`.
- **bg72 performance:** `ROOT/verification-performance-dcm2ccu2/performance.stdout` retains nine direct/proxy pair rows; `ROOT/performance-summary.json` records observed parity/checkpoints/counts and strict per-protocol maxima below. Every row passed; no p95 slack, sample deletion or real-provider p95 claim.
- **bg73 SOURCE / bg74 BUILT:** validation and offline evaluation each2/2PASS/no providers. Exact archives/hashes/identities below; both safety PASSED, accuracy FAILED, release incomplete/live unverified/no receipt.
- **bg70 audit:** `ROOT/verification-audit-vuhopxhy/report.json`, actual authorized isolated `npm audit --audit-level=high` EXIT0; stdout exactly `found 0 vulnerabilities`, empty stderr, no timeout/overflow/forced event, cleanup confirmed. The separate audit-admission metadata passed first. No install/fix/publish/dependency/lock change or provider call was performed by this audit.
- **bg67 loopback/privacy:** `ROOT/loopback-smoke.json`: source-app owned127.0.0.1:8484, exactly one owned-PID `ss` row, health200, enabled log153bytes, all eight configured fake literals and raw `amp_`/`sk-`/`Bearer ` prefixes absent, owned listener closed/temp removed. This is factory-app/socket/log evidence, not installed CLI/native/provider/HTTPS. Persisted audit privacy is established separately by the permanent regression passing in bg71, not by an empty audit file.
- **Scoped prerequisite metadata:** `ROOT/prerequisites.json`: selected root-user-source-default ancestor admitted, config entry absent, all14 source-defined public/deployment ENV names nonempty=false. No config contents or alternate stores read; provider authentication/hosted authority not verified. These are actual scoped observations, not exhaustive absence or proof that remote secrets, domain ownership or DNS do not exist.

Historical bg71–74 results above remain genuine observations, but their pre-c15.1 source/performance/report identities are **HISTORICAL/STALE**, not a current acceptance refresh. The following checkpoint supersedes only current source/report freshness; it does not erase old failures or close final findings.

**Historical intermediate c15.1 SOURCE patch AFTER PASS, final acceptance then PENDING:** bg76 actually exposed47 failing/2508 passing tests (2555 total) across seven suites for seven final issues. After source corrections, bg77 passed typecheck/lint/51 files2573 tests/build/coverage/docs-check. Proof `ROOT/verification-union-411piykk/report.json`; `ROOT/coverage-summary-c15.1.json` gives1586/1608 lines98.63%, policy379/38299.21%, gate396/397≈99.75%, stream Anthropic303/31895.28%, Chat214/21699.07%, Responses294/29599.66%, skipped0. All configured90% thresholds passed. SAME final reviews/HTTP/built-tail smokes were still pending at this checkpoint; latest bg81/bg86/bg88 and SAME closure above now supply those separate proofs, without erasing bg76 or retroactively calling bg77 reviewed.

**Historical intermediate c15.1 mock performance bg78:** `ROOT/verification-performance-afeznzfg/performance.stdout`, nine measured pairs PASS,1000text/separate5-8-3 lifecycle/parity/two acknowledgments, first lifecycle extra max4.487448ms/TOTALextra per1000text max0.043663475ms/event, separate first-text/signed negative Responses sample3 preserved. This was genuine observed timing, but its source identity is superseded by the latest R8 refresh, not reused as current or real-provider p95.

**Policy/report freshness:** source policy epoch is now **c15.1**, not a fictional report `policy_version` field. Corpus/labels/templates/thresholds/gray accounting remain unchanged. Fresh c15.1 SOURCE/BUILT archives below pass offline safety while accuracy still fails, release coverage remains incomplete/live unverified/no receipt; earlier reports remain preserved/stale.

**Historical native HOLD state:** at bg77, permanent-observer functional review/pins/source-safety/public selection/resources were prerequisites and no2.1.312 mixed/status run had occurred. Latest observer/admission progress is described above; actual native/UI observations are still absent. Independent349 typed-adjacency PASS,317 FAIL and520 two-return/unanswered endpoint facts remain unchanged; old failures or absent real keys do not alone defer reachable fake-only work.

## Offline source, build, package and protocol verification

From a provisioned checkout with the lockfile dependencies already installed, the parent runs the C15 gate (these are separate stages; retain each exit rather than allowing a preceding failure to obscure what ran):

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm test -- --coverage
npm run docs:check
npm run eval -- --validate
npm run eval -- --rules-only
npm run test:performance
npm audit --audit-level=high
```

`npm run test:performance` is registered as `tsx test/performance/streaming.ts` and was actually exercised in historical bg72 and fresh c15.1 bg78. Its1000 text events are counted separately from protocol lifecycle events. Dependency audit contacts the configured registry: admit that network operation separately, using isolated owned npm configuration/cache without borrowed registry credentials. It is not part of a no-network claim. Ordinary tests exercise in-process/loopback mocks, not real providers or installed GUI clients. Coverage uses the installed V8 provider with exactly `src/policy/**/*.ts`, `src/gate/**/*.ts` and `src/protocols/*/stream.ts`, `exclude: []`, global line90%, policy/gate group line90%, and each protocol stream file line90%; automatic threshold updating is disabled. Retain `coverage/coverage-final.json` and `coverage/coverage-summary.json` plus text/HTML reports, including uncovered lines. A passing aggregate alone cannot substitute for the group/per-stream thresholds.

Compare the built CLI independently after build:

```sh
node dist/cli/index.js --version
node dist/cli/index.js eval --validate
node dist/cli/index.js eval --rules-only --reports-dir "$PRIVATE_BUILT_REPORTS"
```

Choose a fresh owned private report directory. Source evaluator uses repository assets; the bundle uses module-relative `dist/eval/assets`. Built and SOURCE fingerprints are intentionally different: a passing built report is not a SOURCE release report. Do not invent a `--dry-run` or `--offline` option for `check`: **`check --config` makes potentially billed canary calls to every decision provider**. `eval --validate` is the actual no-config/no-provider corpus/schema validation command; it is not general server-config validation.

For a clean consumer installation, follow [README obtain-the-CLI](../README.md#1-obtain-the-cli-without-assuming-a-public-release): build and `npm pack` in the checkout, copy the actual resulting tarball into an owned clean directory, then use the **relative** package spec `npx ./auto-mode-proxy-<actual-version>.tgz --version`. Do not substitute an absolute tarball path: historical npm12 direct-file dispatch exited126. Install the admitted tarball locally and use `./node_modules/.bin/auto-mode-proxy` for init/serve. Package names/version placeholders are not claims that a registry release exists.

A local HTTP smoke needs owned loopback mock generation and decision endpoints, explicit fake keys, private audit path and issued client token, following the existing config reference. Check `GET /healthz`, unauthenticated vault401, authenticated canonical generation, deny/allow/partial/shadow/provider-outage cases and audit association. Test oversized/timeout/malformed streams only as inert HTTP clients with no executor. Retain response/error/cancellation/cleanup observations. The C13 installed helper sources were deliberately removed after preserving proof; they are not a shipped executable test. Do not present deleted private helpers as reproducible public commands.

The permanent fake-credential socket-error/log/audit regression is directly runnable as `npm test -- test/security/regression.test.ts`; latest bg81 suite passed. The latest actual HTTP correction smoke bg88 and **built CLI** tail smoke bg86 now provide separate runtime evidence in addition to the source regression; see exact scope/proofs above. Historical bg67 socket/log and metadata-only prerequisites remain preserved, not generalized to remote provider credentials or public deployment. Private proof preparations are not shipped commands or permission to relaunch; no OS/agent tool payload is executed by these correction smokes.


### Performance interpretation

The implemented `test/performance/streaming.ts` uses the actual application HTTP surface with owned fake-only loopback upstreams, not an agent/provider. Parent bg72 actually completed nine measured pairs/18 measured responses: three pairs per protocol, each1000 text deltas plus Anthropic5/Responses8/Chat3 lifecycle frames (1005/1008/1003 total respectively), byte parity true and two incremental acknowledgments in every response. The workload performs two warmup requests per protocol before alternating pair order;24 total HTTP generations is the prescribed completed-workload accounting, while the retained nine measured rows directly attest18 measured responses. Warmups are not additional measured rows.

Every measured row reports `direct`/`proxy` `first_event_ms`, `first_text_ms`, `total_ms`, emitted/received text and total event counts, lifecycle count, bytes, byte-order parity and incremental checkpoints. `first_event_ms` is the first complete lifecycle event, not the first text delta; both clocks remain visible. The strict per-row comparisons are `first_event_additional_ms < 50` and `total_additional_ms_per_text_event < 5`, with denominator equal to the observed 1000 received text deltas. Total additional means **total elapsed proxy minus direct**, not total minus first-event time. The consumer acknowledges its actual first and 500th parsed text events before the producer can continue, demonstrating delivery before EOF rather than eventual whole-body output; this handshake is included symmetrically in total timings. Retain the actual rows and final `mock_streaming_passed`/`real_provider_tool_tail_measured` output with process exit/cleanup evidence. No source-defined counter, final boolean alone, p95 slack or discarded outlier can replace actual successful complete measurements.

Historical pre-c15.1 bg72 per-protocol maxima (milliseconds; three measured pairs each, every row passed at that checkpoint; **not current-code evidence**):

| Protocol | Maximum first lifecycle-event extra (ms) | Maximum TOTAL elapsed extra /1000 text events (ms/event) |
| --- | ---: | ---: |
| Anthropic Messages | 5.585779 | 0.032142108 |
| OpenAI Responses | 3.325690 | 0.033963973 |
| OpenAI Chat Completions | 3.027856 | 0.041807809 |

The raw direct/proxy times and first-text clocks remain in `ROOT/verification-performance-dcm2ccu2/performance.stdout`; the negative Responses sample3 first-event difference is preserved, not clamped/dropped. Summary `ROOT/performance-summary.json` is derived from those rows. This is measured pure-text mock overhead, not Jev/Clef tool-tail p95 or an allocation/peak-memory certification.

Historical successful mock timing remains separately recorded: C08 artifact319 had five measured pairs, max first-SSE additional2.43214ms and max amortized/event0.039161619ms; C10 artifact892 had20 first-event samples max36.222715ms and max1000-event extra0.035717561ms/event, with independent arithmetic/count audit CLEAN. They are not substituted for the fresh C15 observations.


Report held suffix, collection/verdict/release/backpressure separately from this pure-text benchmark and do not call controlled delays Jev/Clef p95. Memory between samples or allocation-order traces are not peak-live-heap certification.

Historical performance failures remain: C10 artifact870 configuration failure before samples; artifact873 valid measured first-event failure **61.374226 ms**; later same-contract892 success after the source repair does not erase them. No exclusive-CPU/GC claim follows from those runs.

## Evaluator: offline safety ≠ accuracy ≠ release authorization

Use the actual [evaluator contract](../eval/README.md#running-and-interpreting-reports), not a scalar green. Rules-only selects offline-safety and can exit0 while numerical accuracy fails. Safe raw uncertainty is still effective block and counts in the **57** safe-label denominator. Baseline dangerous denominator is **93**, raw-gray denominator **150**; wrappers are **279 = 93 × 3**, nonclean flips **186 = 93 × 2**. Every selection contains 429 decisions. Zero flips alone is insufficient when clean dangerous cases already allow.

Retained actual archive evidence (SOURCE unless stated otherwise):

- [Initial v1](../eval/reports/2026-10-29T00-53-26-500Z-rules-only-559cad84-d6fc-4e88-a521-cde196f3e27d.json), SHA256 `0245ebeb5f2fa18e9db95f7791e26532082e72b42d1fac51fb689449af2ae699`: EXIT1, dangerous92/93, safe false blocks50/57, raw gray129/150, dangerous wrapped allows3/279 (`read-customer-export` in all three variants), flips0/186. **FAILED, historical/stale**; labels/thresholds were not changed to pass it.
- [Earlier v2](../eval/reports/2026-10-29T02-19-37-925Z-rules-only-06e42b28-3671-46a7-9240-2bc780cd8649.json), SHA256 `b64655517a1b686db64e469214df7d13d4f304c12fbae831ae7b160d34f11407`: unchanged historical/stale engine evidence, not the later corrected archive.
- [C12 corrected archive](../eval/reports/2026-10-29T03-36-37-262Z-rules-only-1b080891-c8df-40fe-877b-bc790fce6e9b.json), SHA256 `cf3dd0e4feb77a0dfa70b52b489eea5abfcf96dc5f62feaac6dfd4a750926cdd`: EXIT0, offline-safety PASSED, accuracy FAILED, release incomplete/live unverified. Dangerous93/93; safe false blocks54/57 (94.7368%); raw gray134/150 (safe54/danger80); wrapped allows0/279, errors0, flips0/186, deterministic baseline coverage16/150.
- [C13 SOURCE refresh](../eval/reports/2026-10-29T04-40-27-199Z-rules-only-549f2fee-2383-4811-b696-428a5a1b6ead.json), SHA256 `5b4fa78db69e2fbf8aa1a997b493c5582eb6d0a1deef6e306062140b8f533cae`: same measured split/counters, all seven fingerprints equal to cf3dd, including source engine `bfd38b62e1907fbf8c3489926e0bb2fde4006c9b85f86d93a9c2fdea205c04f9`. These were matching offline fingerprints at the recorded checkpoint, not a promise of freshness after C15 edits.
- C14 real SOURCE CI producer EXIT0: private `/tmp/c14-ci-evidence.bEFa4R9o/reports/report.json`, SHA256 `165908f478319a338d4bbfc156091058fc916f3b1d3428d1a35955579929cc48`; separate `offline-safety.json` and `numerical-accuracy-raw-gray.json` retained in PROGRESS. Offline passed/accuracy failed/coverage incomplete, **no trusted receipt**. Local producer execution is not hosted CI.
- C13 packed installed BUILT evaluation/validation was exercised as part of package proofs; no SOURCE identity or trusted-provider credit is transferred from it. Historical synthetic full/subset/reviewer-failure fixtures and audit988 test plumbing/accounting, not live model quality.
- **C15 bg73 SOURCE:** `ROOT/source-reports/2026-10-30T02-48-50-780Z-rules-only-3ec9ab25-2c91-4b50-9d36-62587deee461.json`, SHA256 `67f6513b5474d06c5a32c5b20c37ed13125f15dd99ac94cbcac9efe704d31d5b`, engine `bfd38b62e1907fbf8c3489926e0bb2fde4006c9b85f86d93a9c2fdea205c04f9`; actual validation/offline2/2PASS. Runner proof `ROOT/verification-source-eval-ow27pdpw/report.json`.
- **C15 bg74 BUILT:** `ROOT/built-reports/2026-10-30T02-53-25-201Z-rules-only-a4eec4f2-3c95-4596-89f4-d327cef22c8c.json`, SHA256 `c8e7f22e92688e6f7a2e6104ddd20ba86eece6473ebdd956782d58574a630241`, engine `625b66ce180719d21454f5fc8b5ed4bd752687620b0f35f1f3ffdb9845285c40`; actual validation/offline2/2PASS. Runner proof `ROOT/verification-built-eval-9joo0qv3/report.json`.
- Both **historical pre-c15.1 bg73/bg74** archives are root-owned mode0600, schema2, offline-safety PASSED / numerical accuracy FAILED: dangerous93/93, safe false blocks54/57 (94.7368%), raw gray134/150, errors0, dangerous wrapped allows0/279, flips0/186; release incomplete/live unverified/**NO receipt**. Other six fingerprints matched between those historical reports; engines differed. Their old policy/engine identities are now STALE, not current source/built/live acceptance.
- **Historical intermediate c15.1 SOURCE:** `ROOT/source-reports/2026-10-30T09-24-01-377Z-rules-only-0769e172-0908-4312-bf27-981072cd14da.json`, SHA256 `135b21fb684137466dca0593624d0ed7a859ae9c9fcb68292bdb0f9a82a80845`, source engine `ad4d3220d6c407f1aa4a067ad780833998fa396a508464f0c35bb63863af63af`; preserved/STALE.
- **Historical intermediate c15.1 BUILT:** `ROOT/built-reports/2026-10-30T09-24-02-654Z-rules-only-eaeaaa75-09b6-4f21-a976-fa16032815b8.json`, SHA256 `a97a405edfbc14b5351de3702d72b46561be40b53b157e882eb245c45822a8b6`, built engine `8c8608cc0e67e529cf46ae4ae9ddb835fdcb4e2b73c5e974064b63ad7c9e4a68`; preserved/STALE. These then-fresh schema2/mode0600 archives passed safety/failed accuracy with the same denominators; no receipt/release/live acceptance was supplied.
- **LATEST c15.1 SOURCE:** `ROOT/source-reports/2026-10-30T10-18-09-501Z-rules-only-ace65a53-fb43-4a69-b613-f6088089daca.json`, SHA256 `0395a57d1783215284fed851878b16ba066b779fad7ffdd59d1bcd01f37bc8d0`, source engine `8c59031a5a21afb4dc496ef693802f4c86da4a052ee89f31731c11cc8f4b999f`.
- **LATEST c15.1 BUILT:** `ROOT/built-reports/2026-10-30T10-18-10-742Z-rules-only-93d281fd-db34-47ac-8495-9ba4c8c50cbe.json`, SHA256 `a7aaeaf384ab891c6f2c65ab08db81810cb46aabd63a4e61ce496fb3fd0cbd89`, built engine `17c68c8bad29dd0345918cbe71509e905ed715ea284570e39823b32718caca6d`.
- Both latest actual archives select offline-safety and PASS it while **accuracy FAILS**: safe false blocks54/57, dangerous93/93, raw gray134/150, wrapped dangerous allows0/279, errors0, flips0/186; release incomplete/live unverified/**NO receipt**. Policy fingerprint remains `094cddd5853c7dee468652923d4afa513fd96dc7cc1f90bdcacfa5b26bffdd43`; SOURCE/BUILT engine identities differ and are not interchangeable. Source epochc15.1 is a code fact, not a root JSON `policy_version` field. Frozen corpus/labels/templates/thresholds do not refresh stale engine/report evidence or supply real-provider provenance.

With separately authorized real configuration, these commands can bill providers but never execute corpus actions:

```sh
node --import tsx src/cli/index.ts check --config "$APPROVED_CONFIG"
npm run eval -- --config "$APPROVED_CONFIG"
# Optional diagnostic only, not complete release coverage:
npm run eval -- --config "$APPROVED_CONFIG" --provider "$APPROVED_PROVIDER_ID"
```

Record actual endpoint/model identifiers and response envelopes only when observed. Init's Jev/model defaults are unverified guidance, not actual provider versions. System One/OpenRouter route/model spelling and Cloudflare envelope remain real canary requirements; OpenAI/Vercel Decisions and real OpenRouter Haiku JSON likewise need actual authorized endpoint responses. Do not derive compatibility from fixture names. `--provider` success cannot replace each configured provider plus the full ordered chain. Changes to policy/thresholds/overrides/configuration/credentials/corpus/templates/engine require the full appropriate refresh; preserve old archives as stale.

The last scoped metadata audit01FC found exact `/root/.config/auto-mode-proxy/config.yaml` absent and nonempty-presence false for `OPENROUTER_API_KEY`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_GATEWAY_ID`, `AI_GATEWAY_API_KEY`, `RELAY_A_KEY`, `RELAY_B_KEY`. It established no usable explicit real-provider/chain/reviewer configuration in **that scope**. It did not search alternate stores or prove credentials never exist. Resume with operator-provided explicit authorized configuration/credential sources, not secret hunting or borrowed login.

Fresh C15 prerequisite metadata narrows the current observation to the admitted selected root-user-source-default config entry (absent) and these14 nonempty-presence checks (all false): `AI_GATEWAY_API_KEY`, `AMP_ADMIN_TOKEN`, `AMP_AUDIT_PATH`, `AMP_TOKEN_CC`, `AMP_TOKEN_CODEX`, `AMP_TOKEN_WORKBUDDY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_GATEWAY_ID`, `DOMAIN`, `OPENROUTER_API_KEY`, `PROJECT_DIR`, `RELAY_A_KEY`, `RELAY_B_KEY`. No config contents/alternate credential stores/provider authentication/hosted authority were examined or verified. It blocks no-key-required local mock/native investigation and does not establish missing remote CI secrets or DNS.

## Installed-client, GUI, replay and prompt-cache procedures

### Claude CLI and README connection

Follow [README init → serve → Claude](../README.md#2-initialize-and-start-the-private-local-gateway) and [Claude guide](agents/claude-code.md). The literal fake example keys cannot work against real endpoints: use authorized real services or substitute **all** endpoints with owned mocks before client ingress. Set the issued client token, `/cc` base and an actually advertised model; tool-free `claude --print --tools '' --model '<relay-supported-model>' 'Reply with AMP_ONBOARDING_OK only.'` tests connection only.

C14 bg65 actual Claude2.1.312 installed-client README connection is verified **only with these disclosures**: loopback fake backends, init-issued token, mock-supported model, route-wide rewrite, private audit path, fresh HOME preseeded `hasCompletedOnboarding`, and a namespace-local launcher running admitted installed `dist/cli/index.js` with pinned Node. It is not the vendor first-run wizard or a new bin-link/shebang execution test. One authenticated POST with parsed `/v1/messages`, single `beta=true`, exact marker/HTTP200 and vendor/namespace exit0 was observed; owned root removal/cleanup was confirmed under the zero-exit trusted-supervisor contract. No native approvals/cache/five-turn/real-provider/public-HTTPS evidence was exercised.

bg64 remains failed `model_not_found`/HTTP404. Its exact URL/stdout were not retained; bg65's query observation does not retroactively prove bg64's URL. Original cleanup-false fields remain, with reviewer-qualified case-specific supervisor inference only. bg62 remains permanently unclassified **including cleanup**. Do not retry those failures merely to confirm them or claim the mock error proves unavailable real models.

**New-version native/mixed work is locally actionable, not yet executed.** Actual317 is specifically a2.1.311 failure, not proof that2.1.312 cannot work. bg65 establishes2.1.312 startup/authenticated mock text connectivity under the working mandatory namespace, but tools were disabled and route rewrite selected; genuine safeguards/Auto eligibility/Bash declaration/native result/replay are unknown. The parent has private proposal7B89 under current safety review for genuine2.1.312 with current source and the unchanged strict observer, fake-only isolated endpoints and fixed harmless mock-deny probes. Real provider keys are not required for that local investigation. Before execution, explicit parent authorization must cover its actual scope/normal Auto eligibility/OS execution boundary/lifecycle and capture; no hidden feature flags, credential borrowing, sandbox bypass or forged safeguards. Missing native opt-in/eligibility must become an exact observed limitation, never an invented capability. Record new-version results independently without changing317,349,520 or bg62/bg64. Print success would not satisfy interactive `/status`/escalation; leave the old unanswered human endpoint unanswered and never provoke/fake classifier fallback.

Current2.1.312 mixed/status actual launches remain unperformed. Strong observer489d has SAME-source conditional review; private public-artifact inventory/closed-physical-hardlink-group admission correction and SAME safety review precede new inventory/pin admission, full current-source execution-safety/public selection and fresh resources. Neither successful local correction smokes nor a reviewed observer is actual client native/UI evidence. Separate status-only versus baseline/consecutive-negative TTY scopes still need explicit authorization; no old520 endpoint resumption or positive approval/bypass/execution is authorized.

The shipped opt-in installed-client harnesses are not ordinary suite launches. Only after fresh parent authorization and safety review:

```sh
~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/claude-smoke.ts
~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/claude-smoke.ts --mixed-content
~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/claude-smoke.ts --version-override-rewrite
```

Print `--mixed-content` runs **both native and rewrite**; `--delivery=...` selects only interactive mode and must not be advertised as filtering a print run. The native comparison is **not** a prediction that it passes. Record immediate next-request ordered block tuples, exact tool/denial/reason/result linkage and zero unintended execution, not text offsets or later repaired history. Interactive `/status`/escalation procedures and bounded `--consecutive-probes` mode are in [compat](compat.md#parent-only-safe-real-cli-mock-procedure). The actual final520 showed Enabled, five associated normal observations and genuine three-blocked UI, but only two denial returns and an unanswered third human endpoint; `properConsecutiveCaseExercised` stays false. Do not answer that endpoint to manufacture acceptance. Scoped fallback needs a real correlated classifier request; zero requests is an untriggered conditional branch, not a successful fallback or key blocker.

### Claude Desktop

Use the exact [tested Linux managed recipe](agents/claude-code.md#desktop-setup-tested-linux-managed-gateway-path), root-owned secure managed-file path, static client token, model discovery and explicit **Code** surface. Desktop does not read the CLI base-URL variable. Preserve vendor sandbox/regular user and use an owned folder. Actual Linux4.29.0/Code2.1.309 local proof includes five normal GUI rounds, one harmless rewrite denial/no execution and post-block continuity. Developer Mode/helper-script/other platforms/native Auto were not exercised. A new GUI run needs authorized operator-capable display/session and safety-reviewed resource-controlled launch; it is not an excuse to alter host `/etc` or borrow app authentication.

### Codex CLI and Desktop

Use [Codex guide](agents/codex.md): Responses `/codex/v1`, top-level model/provider before the TOML table, `env_key`, `wire_api="responses"`, `supports_websockets=false`. Current0.164.0 direct native tools differ from unsupported Code Mode JavaScript `exec`; don't rewrite payloads into a familiar API or infer model capability from a flag.

The opt-in command recorded in [compat](compat.md#parent-only-installed-cli-replay-harness) is **not currently a launch authorization**:

```sh
CODEX_EXECUTABLE=/root/.local/bin/codex AMP_CODEX_SMOKE_KEEP=1 ~/.omp/bin/heavy-gate -m 6G -- node --import tsx test/manual/codex-smoke.ts
```

That command's old release was revoked after741; parent must explicitly reauthorize any new launch against the current reviewed source. Preserve original capture800 FAIL and later independent six-case TGvD4b scoped interpretation proof without reclassifying the original failed observer. Compare complete immediate `input` to captured done-item completion order; do not sort by output_index, filter unrelated trailing items, repair history or treat output echoes as execution. The bounded sole positive printf per mode requires its own native completed exit0/exact stdout/result association; negative/unexpected successful executions must remain zero. Run `--yolo` and Approve for me separately only in approved disposable mock isolation, never onboarding against an untrusted live relay.

Desktop is **host-sandbox blocked**, not proven auth-failed: actual NoUsableSandbox and correlated AppArmor/userns cap21 denial prevented a window/Codex surface or model traffic. The Node PATH issue was separately fixed. Required next input is an independently authorized vendor-sandbox-capable operator host/session, with normal config/token propagation; no `--no-sandbox`, host-policy rewrite or uninstalled profile assertion can substitute. Both native Desktop modes/from-zero connection remain unobserved. Real ≥5-turn relay replay is separately pending explicit authorized relay/model/credentials even where local CLI mocks passed.

### WorkBuddy

Follow [WorkBuddy guide](agents/workbuddy.md): full `/workbuddy/v1/chat/completions`, issued client token, actual model and Tool Calling. Retain original P6-3 “AI 智能审批 = 自动审批” and non-“完全访问” criterion, actual harmless injected denial/no execution and captured auxiliary-header presence **or absence**. Default Permissions, model Auto Mode, CodeBuddy CLI, Enterprise or online product are not substitutes. Global ≥5 normal turns remains a separate criterion.

Manifest5.5.2.37849279 and exact official x64 DEB/RPM metadata GET404 are historical observations, not an installed-client version or blanket Linux unsupported result. Resume only with an accessible approved genuine artifact or authorized installed operator GUI host; observe actual version and required mode before ingress. Safe preparation/control AFTER970 is not app/runtime/auth/header success. Preserve all prior native preparation roots and proof; don't relaunch or extract on the basis of this runbook.

### Real replay, beta, thinking and cache

For an authorized actual relay, run at least five correlated rewrite turns including a harmless mock-denied tool, retaining real upstream status/request linkage and client replay. Start by preserving thinking/reasoning. Only an observed signature/prefix400 (Claude) or real encrypted-reasoning consistency error (Codex) triggers the already specified bounded affected-turn/replay compatibility branch and reruns; no speculative global stripping or historical replay mutation. Record beta default-strip and independently successful preserved-beta outcomes before using `strip_beta:false`; local schema combinations do not establish real endpoint acceptance.

For prompt cache, keep the actual cache-eligible prefix/model/session stable, capture real upstream second-turn `usage.cache_read_input_tokens > 0`, and separately correlate repeated trusted classifier responses whose cache-read usage is not always zero. Record model/endpoint/version, changed prefixes and usage availability. A mock counter, absent usage, generated request field or an ordinary reply cannot prove a cache hit. Prerequisites are explicit cache-capable real relay and trusted classifier configuration/credentials; no such observation was established by the scoped audit.

For real Jev/Clef tail timing, record backend/model/endpoint and actual sample count, tail-start/end definition, collection completion, verdict completion/release and backpressure. Keep each backend's p95 against its own original bound (Jev1.5s, Clef-flash0.5s); never pool providers or use synthetic sleeps. No real measurements are claimed here.

## HTTPS, deployment and publication

### Local container proof versus public HTTPS

Use the actual deployment files and [configuration reference](config.md), not a host-Node substitute. Provision selected `deploy/config.yaml` and private `deploy/.env` first: no literal secrets in the uid1000-readable config; private environment file; writable owned audit volume. The proxy stays nonroot/read-only with **no host ports**; Caddy alone publishes80/443. Do not print `docker compose config` output containing interpolated keys.

After explicit domain/host/DNS/inbound/TLS/provider authorization, the selected invocation is:

```sh
docker compose --project-directory deploy --env-file deploy/.env -f deploy/docker-compose.yml up --build -d
curl --fail "https://$DOMAIN/healthz"
ss -ltnp
```

Apply heavy-gate/resource policy to build/launch; use a dedicated authorized deployment host/project, not another user's stack. Require health200 with valid public TLS (no `curl -k`), owned-host socket attribution showing only Caddy80/443 externally, nonroot/RO/private-config/audit persistence and cleanup evidence. Then point a genuine Claude client at `https://<owned-domain>/cc` with issued token and record actual authenticated connection. TLS health alone is not agent acceptance. Keep server internals/keys out of shared artifacts.

Last scoped1046 audit: selected `deploy/.env` and `deploy/config.yaml` absent; projected DOMAIN nonempty false. Domain ownership, authorized public host, DNS and inbound80/443 were **unknown**, not exhaustively absent. Those exact inputs/authorities are the remaining prerequisites. Docker1121's two phases already prove local internal Caddy→proxy→HTTPS-mock decision/audit and real Docker127-only Caddy→proxy health; phase2 Caddy's ordinary frontend had explicit egress authority, not kernel-no-egress or public TLS. Preserve earlier Docker registry/topology/helper failures and corrected proof in PROGRESS; no rerun to confirm them is needed.

### Publication remains independently authorized and fail-closed

Follow the existing [release evidence and independent authorization procedure](compat.md#release-evidence-and-independent-authorization-implemented-operational-acceptance-unverified). It is the publication runbook of record; do not duplicate its authorization schema here.

1. An authorized administrator verifies actual repository/protected `vX.Y.Z` tag policy, remote variable/secret access and independent auditor trust root. Trusted source/process/release authority is a threat assumption; hostile relay protection does not defend a malicious maintainer. REL001's withdrawal was not a security fix.
2. Produce current complete **SOURCE** all-provider+ordered-chain corpus/wrapper full-accuracy evidence with approved fully expanded configuration. An independent external auditor validates the real provider run and exact archived bytes; the private Ed25519 signing key never enters evaluator, Actions or repository.
3. Stage same-tag readable published-release assets `release-report.json`, `release-authorization.json`, `release-authorization.sig` under that authorized procedure. First tag run intentionally fails if assets are absent; after staging, rerun the original SHA/ref, not a force-rewritten tag/dispatch bypass. Draft read access is not assumed.
4. Existing source verifier interfaces are `node --import tsx scripts/release-evidence.ts --preflight "$EVIDENCE_DIRECTORY"` and `node --import tsx scripts/release-evidence.ts "$EVIDENCE_DIRECTORY"` **inside the actual authorized protected-tag context**, with provisioned public key/full configuration. Preflight signature/context acceptance is not full report acceptance. `assertFreshReport` remains the shared full validator, binding exact bytes and all seven current fingerprints/complete coverage/metrics/provenance.
5. Observe the hosted PR CI, actual authorized tag publication and registry pull of its exact image/digest. Optional npm publication additionally needs authorized `NPM_TOKEN`; lack of that token does not turn an unperformed image pull into success. Public npm/image names remain conditional until observed.

C14 actionlint1.7.12 syntax PASS (shellcheck/pyflakes disabled) and four actual negative release CLI cases (missing root/archive, empty archive, fork context) establish only those local paths. Neither a local green, optional provider-job skip, SOURCE offline producer, mock full report nor named environment unlocks publication. Required remaining evidence is actual hosted authorization/protection, current trusted full SOURCE report/independent receipt and observed tag artifacts/pull—not another no-secret green.
