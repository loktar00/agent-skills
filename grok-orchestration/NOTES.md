# NOTES — grok-orchestration skill provenance

Verified against **grok 1.0.5 (5115b46bc9) [stable]**
- Binary: `C:\Users\lokta\.grok\bin\grok.exe`
- `grok --version` / `grok version --json` (`currentVersion`, `channel: stable`)
- Host: Windows / PowerShell
- Date: 2026-08-25
- Config/home inspected read-only: `C:\Users\lokta\.grok\` (config.toml, sessions, logs, README.md, docs/user-guide)

Legend: **CLI** = this session ran the command; **FS** = read files under `~/.grok`; **DOCS** = install README / `docs/user-guide` shipped with this grok (not web); **PRIOR** = not confirmed here.

---

## Verified by running commands (CLI)

- `grok --help` (full) and `grok -h`: flags, positional `[PROMPT]`, commands (`agent`, `sessions`, `models`, `inspect`, `export`, …).
- `grok agent --help`, `grok agent stdio|headless|serve --help`.
- `grok models` → default `grok-4.6`; also `grok-4.5`.
- `grok inspect --json` → cwd, `configSources.layers` = `~\.grok\config.toml`, session storage path encoding.
- `grok sessions list -n 5` → session id / timestamps / summary rows.
- `grok login --help` → `--device-auth` / `--device-code`.
- **TUI trap:** `grok --output-format json --always-approve "say ping and exit"` and the same with `--max-turns 1` both opened the alt-screen TUI and did **not** exit (8s timeout). Positional PROMPT is interactive.
- **Headless `-p`:** `grok -p "Reply with exactly: PONG. …" --output-format json --max-turns 1 --always-approve` → EXIT 0, JSON with `text: "PONG"`, `stopReason: "end_turn"`, `sessionId`, `usage`, `modelUsage`, `total_cost_usd`.
- `--prompt-file` with a temp file → EXIT 0, `text: "FILEOK"`. Missing file → EXIT 1 `Failed to read … os error 2`.
- `--prompt-json`:
  - `[]` → EXIT 1 `content blocks array is empty` (and this **is** a headless trigger — no TUI).
  - non-array object without wrapper → `JSON object must have a "content" field` / needs `"type":"acp"`.
  - unknown variant → `expected one of text, image, audio, resource_link, resource`.
  - `image` missing `data` / missing `mimeType`; `audio` missing `data` / `mimeType`; `resource` missing `resource`; `resource_link` missing `name`.
  - valid `{"type":"acp","content":[…]}` ran headless.
  - valid `resource` `{uri,text,mimeType}` and `resource_link` `{uri,name}` ran (model treated them as attachments).
- Stdin: piped `SECRET_STDIN_PAYLOAD_XYZ` into `-p "… Else reply STDIN_EMPTY"` → stdout `STDIN_EMPTY`. Headless does not ingest piped stdin as prompt text.
- `--always-approve` used on every live `-p`. Hidden `--yolo`: accepted with `--version`/`-h` (not in `--help` text). `--no-auto-update`: same (accepted, not in `--help`).
- `--permission-mode notamode` → EXIT 2, possible values `default, acceptEdits, auto, dontAsk, bypassPermissions, plan`.
- `--output-format ndjson` → EXIT 2, possible values `plain, json, streaming-json, streaming-messages-json`.
- `--max-turns 0` → EXIT 2, `0 is not in 1..=4294967295`. `--max-turns 1` hit on a tool-y prompt → EXIT 1 stderr `Error: max turns reached`, JSON `stopReason: "cancelled"`.
- `--session-id not-a-uuid` → EXIT 1 must be a valid UUID.
- `--resume 00000000-0000-0000-0000-000000000000` → EXIT 1 (local miss, remote 404).
- `--continue --cwd $TEMP` (no sessions) → EXIT 1 `No session found for current directory`.
- `--fork-session` without `-r`/`-c` → EXIT 1 `requires --resume or --continue`.
- `--cwd` missing dir → EXIT 1 os error 2.
- `--reasoning-effort ultra` on a live `-p` → EXIT 1 `unknown effort level 'ultra'; use one of: xhigh, high, medium, low`.
- `--sandbox workspace -p …` → EXIT 0 on Windows (no hard failure). `--sandbox notaprofile -p …` → also EXIT 0 (unknown profile did not fail here).
- `--debug-file <path>` → file created (~85KB DEBUG lines). `--debug` → `~\.grok\debug\<session-id>.txt` plus `headless-<pid>.txt`.
- `--tools notatool -p hi` → EXIT 0 (unknown tool id did **not** error).
- Flags that **do not exist** (EXIT 2 unexpected argument): `--oss`, `--image`, `--attach`, `--file`, `--add-dir`, `--max-time` (tip: `--max-turns`), `--profile`, `--web-search-model`.
- Exit codes actually produced: **0** (success), **1** (runtime), **2** (parse).

## Verified by filesystem / inspect (FS)

- `~/.grok/config.toml`: `[models] default = "grok-4.6"`, `default_reasoning_effort = "high"`, `[ui] permission_mode = "always-approve"`. No Codex profiles, no `-c` overlay keys.
- Session tree: `~\.grok\sessions\<url-encoded-cwd>\<uuid>\` with `summary.json`, `updates.jsonl`, `events.jsonl`, `chat_history.jsonl`, `signals.json`, `terminal\`. Encoded cwd matches `D%3A%5Cdev%5C…`.
- `summary.json`: `info.id`, `cwd`, `last_active_at`, `current_model_id`, `sandbox_profile`.
- `signals.json`: `contextTokensUsed`, `contextWindowTokens`, `turnCount`, `toolCallCount`, `toolsUsed` (historical sessions recorded `run_terminal_command`, not the docs' `run_terminal_cmd`).
- `events.jsonl`: `turn_started` (`yolo_mode: true` under `--always-approve`), `phase_changed`, `turn_ended`. No per-token usage event on the ping run.
- `active_sessions.json`: `{session_id, pid, cwd, opened_at}` — observed an entry whose pid looked leftover; treat as a hint, not sole liveness.
- `~\.grok\logs\unified.jsonl` exists and grows. `~\.grok\README.md` and `docs/user-guide/14-headless-mode.md` etc. present.
- `CHANGELOG.md` 1.0.5: `GROK_CONFIG` / `GROK_CONFIG_PATH`.

## From install docs shipped with this grok (DOCS) — not re-executed

Used only where they fill gaps the CLI help/live run did not contradict. Labelled as docs in SKILL.md when not CLI-proven:

- SIGINT/SIGTERM → exit 130/143; files not rolled back; session saved through last completed tool call.
- `--always-approve` ≡ `--yolo` ≡ `--permission-mode bypassPermissions`; deny/hooks still apply; `auto` blocks instead of prompting in headless.
- `--tools` / `--disallowed-tools` / `--max-turns` are headless-only (ignored with a warning in TUI). `--max-turns` ignored-in-TUI matches the TUI trap test.
- Permission rule prefixes and glob semantics; `--disallowed-tools Agent` / `Agent(explore)`.
- Sandbox profile table and Landlock/Seatbelt; Windows enforcement **not** demonstrated (CLI ran anyway).
- Custom-model TOML (`[model.*]`, Ollama `http://localhost:11434/v1`, `api_backend`, credential order).
- `GROK_CONFIG` overlay allowlist; `GROK_HOME`; `XAI_API_KEY`; `inference_idle_timeout_secs`.
- JSON usage field policy (uncached `input_tokens`, incomplete/cost omission). Streaming-json event types. `streaming-messages-json` shape.
- `-s` UUID-only (matches `--help` on this version; older README snippet that said `-s` upserts a named string is **stale** vs this CLI).
- `--worktree` does not create a worktree under `-p` (help text).
- ACP `grok agent stdio` lifecycle (not used as the one-shot path).

## Prior knowledge / not confirmed — omitted or tightly scoped

- Did **not** send SIGINT/SIGTERM to measure 130/143.
- Did **not** confirm `--yolo` actually auto-approves a tool (only that the parser accepts it). Canonical flag documented is `--always-approve`.
- Did **not** confirm `--tools`/`--disallowed-tools` string match (`run_terminal_cmd` in docs vs `run_terminal_command` in `signals.json`).
- Did **not** live-validate effort levels other than the `ultra` rejection list (`xhigh, high, medium, low`). `none`/`minimal`/`max`/`deep`/`auto` parsed far enough to hit empty `--prompt-json`, which is **before** effort validation.
- Did **not** run a local Ollama/LM Studio completion; local-provider TOML is from install docs + confirmed absence of `--oss`.
- Did **not** confirm `GROK_CONFIG` overlay at runtime.
- Did **not** confirm `--include-partial-messages` wire output.
- Codex `~/.codex/config.toml`, `-c` config overrides, and `--oss` **do not exist** on this CLI — not documented as grok features.

## Conflicts noted (CLI wins)

- Positional `PROMPT` + `--output-format` is TUI, not headless. Install quick-start that says “passing a prompt non-interactively triggers headless” is true only for `-p` / `--prompt-file` / `--prompt-json`.
- README scripting example `git diff | grok -p "…"` is wrong for this binary: stdin is not the prompt.
- README `-s my-session` upsert is wrong for 1.0.5; `--help` and live `--session-id not-a-uuid` require a new UUID.
- README built-in tool table still says `bash`; live `signals.json` uses `run_terminal_command`.
