# Compatibility and live acceptance

## Observed host readiness (2026-10-28)

The safe prerequisite probes recorded in `docs/plan/PROGRESS.md` observed Claude Code **2.1.311** and Codex **0.164.0**. Sanitized authentication-status probes returned authenticated with exit code 0 for both installed CLIs. This establishes local CLI/auth readiness only: it does not establish provider access, a successful model request, tool-use enforcement, or prompt-cache behavior.

Boolean-only probes found these explicitly checked environment variables absent: `OPENROUTER_API_KEY`, `CF_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CF_ACCOUNT_ID`, `AI_GATEWAY_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `RELAY_A_KEY`, and `RELAY_B_KEY`. The default `~/.config/auto-mode-proxy/config.yaml` and project/deploy environment configuration were also absent. No credential values were printed. These are observations about the inspected host/configuration, not a claim that credentials cannot exist elsewhere.

No real billed provider calls were made for C07. No measured live latency, accepted model ID, accepted endpoint, Cloudflare response envelope, real agent conversation, or cache hit is claimed. GUI availability and owned public HTTPS/publishing prerequisites remain separately unavailable on the observed host.

## System One checks (C07)

`auto-mode-proxy check --config <path>` loads and validates the actual configuration and sends the fixed inert canary to **every configured supported decision provider**, including providers not selected by the ordered failover chain. It prints sanitized provider ordinals, latency and validated probability results; any unavailable, invalid or unsupported provider produces a nonzero exit status. It does not silently succeed because another provider worked. `openai-decisions` is unsupported until the real C09 adapter lands; a configured instance fails the check rather than receiving a fake canary success. Second-stage Anthropic review is also C09 work and is not claimed tested by this command.

The command makes real network requests to the explicitly selected configuration; it is not a dry run. Use disposable loopback mock providers for local testing. Do not put real credentials into diagnostics, fixtures or reports.

The adapter owner's public-documentation investigation used the [System One API reference](https://docs.typesafe.ai/api/system-one): wire responses contain `answers.<id> = {type: "noul", noul: <probability>}`, converted internally to numeric probabilities. The [TypeSafe model reference](https://docs.typesafe.ai/models) documents Jev aliases and input pricing; this is documentation evidence, not a live endpoint/model compatibility result. Local mock checks use that canonical answer shape.

### Pending external P2-5 / P2-6 acceptance

The missing configured provider credentials block only the external canary portion, not local C07 implementation. P2-5 live acceptance and P2-6 remain unchecked:

- OpenRouter: test `https://openrouter.ai/api/v1/systemone` with `typesafe/jev-1.14` and `jev-latest`; if both reject that endpoint, investigate `https://openrouter.ai/api/alpha/decisions` with the same System One schema and configured `body_extra.provider` routing. No model/endpoint pair is yet measured as working.
- Cloudflare: test the actual configured REST endpoint and record whether it returns `{result, success, errors}` or a direct top-level `answers` response. Local envelope-handling fixtures do not establish the live response shape.
- Record actual accepted model IDs/endpoints, sanitized answers, latency and date after authorized live checks. Do not infer provider compatibility from mock successes or change defaults on that basis.

## Protection boundary

C06 CLOSED `45f2791`. C07 local gates passed1331tests; actual built check and gate/cache/audit-tail exercised with disposable loopback provider and private tempfiles. One canary plus one uncached decision produced2provider requests; cache avoided a second decision call, hard deny avoided provider access,3JSONL records contained no configured credential sentinels. These are local integration results, not live model evidence. Independent C07 review is underway. HTTP tool-use gate installation is C08; until then transparent transport is disposable-mock-only.
