# AGENTS.md

## Lessons

- Codex docs moved (as of 2026-10): every `https://developers.openai.com/codex/<path>` URL 308-redirects to `https://learn.chatgpt.com/docs/<path>`; append `.md` for clean text (e.g. `learn.chatgpt.com/docs/config-file/config-reference.md`). The `docs/*.md` files in `github.com/openai/codex` are one-line stubs now. Index: `https://learn.chatgpt.com/llms.txt`.
- For Codex internals, shallow-clone `openai/codex` into the scratchpad and grep; file paths guessed from older docs/blogs (`openai_tools.rs`, `model_provider_info.rs`, `chat_completions.rs`) no longer exist. Current locations: tool specs `codex-rs/core/src/tools/handlers/shell_spec.rs` + `apply_patch_spec.rs`; provider config `codex-rs/model-provider-info/src/lib.rs`; Responses SSE parser `codex-rs/codex-api/src/sse/responses.rs`; approval enums `codex-rs/protocol/src/protocol.rs` + `config_types.rs`; Auto-review `codex-rs/core/src/guardian/` + `codex-rs/prompts/templates/guardian/policy.md`.
- Codex (CLI 0.164.0, 2026-10-23) speaks only the Responses API: `wire_api = "chat"` was removed in rust-v0.95.0 (2026-02-04, PR #10498). The shell tool is `exec_command` (+ `write_stdin`), not `shell`/`shell_command`; `--ask-for-approval` accepts only `on-request` | `never`; `--full-auto` is deprecated/removed, `--approve-for-me` and `--yolo` exist.
