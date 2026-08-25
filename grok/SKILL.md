---
name: grok-orchestration
description: Lets an agent drive headless Grok CLI (grok build) instances toward a user's goal — launch/monitor/salvage non-interactive `grok -p` runs, configure models and local OpenAI-compatible providers, attach reference files via `--prompt-json`, and read token usage from JSON output. Use when the user says things like "use grok to have <model> build <thing>", "run this headless with grok", or when a grok turn hangs, caps, or needs resume/fork.
---

# Driving grok with an agent

Verified against **grok 1.0.5 (5115b46bc9) [stable]** (`grok --version` / `grok version --json`). Sanity-check flags against `grok --help` before relying on them — grok evolves.

This skill is **engine mechanics only**. Shared orchestration doctrine (lane scaffolding, turn prompts, verification, hand-patch policy) lives elsewhere.

> Trap: a positional `PROMPT` starts the **interactive TUI**, even with `--output-format` set. Headless requires `-p` / `--single`, `--prompt-file`, or `--prompt-json`.

## 1. Canonical unattended launch

```bash
cd <LANE_DIR> && grok -p "$(cat prompts/turns/03.md)" \
  --output-format json \
  --always-approve \
  --permission-mode bypassPermissions \
  --max-turns 40 \
  --cwd <LANE_DIR> \
  > build/turn-logs/03.log 2>&1; echo "EXIT $?" >> build/turn-logs/03.log
```

PowerShell:

```powershell
Set-Location <LANE_DIR>
grok -p (Get-Content -Raw prompts\turns\03.md) --output-format json --always-approve --max-turns 40 --cwd <LANE_DIR> *>&1 | Tee-Object build\turn-logs\03.log
"EXIT $LASTEXITCODE" | Add-Content build\turn-logs\03.log
```

That is the one-shot agentic loop: **one user prompt**, full tool use, process **exits** when the turn ends. `-p` is labelled `--single` but it is not a no-tools completion — `--max-turns` caps **agentic model rounds** (tool loop), range `1..=4294967295`.

### Headless triggers vs TUI trap

| Invocation | Mode | Empirically |
|---|---|---|
| `grok -p "…"` | headless, exits | EXIT 0, JSON on stdout |
| `grok --prompt-file PATH` | headless, exits | same |
| `grok --prompt-json '[{…}]'` | headless, exits | same |
| `grok --output-format json "…"` (positional PROMPT, no `-p`) | **TUI** | alt-screen; does not exit |
| `grok --output-format json --max-turns 1 --always-approve "…"` | **TUI** | `--max-turns` ignored in TUI |

`--output-format` only formats a headless run. It does **not** select headless.

`grok agent stdio` is a long-lived ACP server (JSON-RPC on stdin/stdout) for IDEs/SDKs, not a polling one-shot. Use `-p` for bounded turns.

### Approval / permission

Unattended runs **must** skip interactive approval:

| Flag | Effect |
|---|---|
| `--always-approve` | Auto-approve tool executions. Hidden alias `--yolo` is accepted by the parser but **not** listed in `grok --help`. |
| `--permission-mode bypassPermissions` | Same always-approve mode. Parser values: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. |
| `--allow <RULE>` / `--deny <RULE>` | Repeatable permission rules (`Bash(…)`, `Edit(…)`, `Write(…)`, `Read(…)`, `Grep(…)`, `WebFetch(…)`, `MCPTool(…)`). Deny wins. Compat aliases: `--allowedTools`, `--disallowedTools`. |
| `--tools <IDS>` | Headless allowlist of built-in tools (comma-separated). |
| `--disallowed-tools <IDS>` | Headless denylist. Supports `Agent` / `Agent(explore)` to block subagents. |
| `--sandbox <PROFILE>` | Optional OS sandbox (`GROK_SANDBOX`). Help lists the flag; built-in names in the install docs: `off` (default), `workspace`, `devbox`, `read-only`, `strict`. Enforcement is Landlock (Linux) / Seatbelt (macOS). On this Windows host `--sandbox workspace` and even `--sandbox notaprofile` still ran EXIT 0 — **do not assume Windows enforces**. |

`--always-approve` still honors **deny rules, hooks, and admin locks**. `auto` in a non-interactive session blocks some calls and reports the block to the model rather than prompting — use always-approve for CI.

Tradeoff: always-approve is what makes a polling orchestrator possible; pair it with `--deny` / `--disallowed-tools` / `--sandbox` when the lane is untrusted. `dontAsk` / `default` will stall or deny writes.

### Working directory

- `--cwd <PATH>` sets the workspace. Missing path → EXIT 1 (`Failed to set working directory … os error 2`).
- Session files are grouped by **URL-encoded cwd** under `~/.grok/sessions/`. Example: `D:\dev\omp-agent-skill\work\grok-lane` → `~\.grok\sessions\D%3A%5Cdev%5Comp-agent-skill%5Cwork%5Cgrok-lane\<session-id>\`.
- Project-root discovery walks up from cwd to `.git`. Nested `--cwd` inside a huge repo loads that repo's AGENTS.md/skills.
- `--worktree` exists for the TUI; help text: **headless (`-p`) does not create a worktree from this flag**.

Always pass `--cwd <LANE_DIR>` and launch from that directory so session grouping and tool paths match.

### Stdin

Headless **does not** splice piped stdin into the prompt. Empirically: piping `SECRET_STDIN_PAYLOAD_XYZ` into `grok -p "… Else reply STDIN_EMPTY"` printed `STDIN_EMPTY`.

Pass prompt text via `-p`, `--prompt-file`, `--prompt-json`, or shell substitution (`-p "$(cat file)"`). Unlike omp, `</dev/null` is not required to prevent a stdin block on `-p`. (A positional PROMPT still opens the TUI and will block.)

### Output, completion, polling

`--output-format` (default `plain`): `plain` | `json` | `streaming-json` | `streaming-messages-json`.

`json` (best for accounting) — one object after the turn, stdout silent until then:

```json
{
  "text": "PONG",
  "stopReason": "end_turn",
  "sessionId": "01a039de-10ac-7b12-a151-8df7538091ca",
  "requestId": "…",
  "usage": {
    "input_tokens": 17703,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "output_tokens": 32,
    "reasoning_tokens": 26,
    "total_tokens": 17735
  },
  "num_turns": 1,
  "total_cost_usd": 0.00605166,
  "modelUsage": { "grok-4.6-build": { "inputTokens": 17703, "outputTokens": 32, "modelCalls": 1, "costUSD": 0.00605166 } }
}
```

On failure grok still often emits JSON (or `{"type":"error","message":"…"}`) **and** a stderr `Error: …` line.

`streaming-json` — NDJSON while the turn runs (`text`, `thought`, `tool_call`, `tool_call_update`, `usage`, `end`, `error`). Last line is `end` or `error`. Prefer this when the orchestrator must see liveness in the **log file**; `json` does not grow until exit.

`streaming-messages-json` — Anthropic Messages `stream-json` shape. `--include-partial-messages` only affects this format.

**Completion signal:** run the whole line as a background task and poll for `EXIT` in the log (the `echo "EXIT $?"` sentinel). Also parse `stopReason` / `"type":"end"` if using JSON formats. Never a bare long sleep.

**No wall-clock cap.** `--max-time` is not a flag (parser: unexpected argument; tip: `--max-turns`). `--max-turns` is a turn cap, not a timer. Config `inference_idle_timeout_secs` / session `inferenceIdleTimeoutConfiguredSecs` (3600 on this install) is **per-inference idle**, not a run deadline. The orchestrator **must impose an external timeout** (kill the process, then salvage).

### Useful extras (all in `grok --help`)

| Flag | Role |
|---|---|
| `-m, --model <ID>` | Model for this run (`grok models` on this install: `grok-4.6` default, `grok-4.5`) |
| `--reasoning-effort` / `--effort` | Runtime error for `ultra` listed: `xhigh, high, medium, low` |
| `--rules <TEXT>` | Extra rules appended to the system prompt |
| `--system-prompt-override` | Replace the agent system prompt (compat `--system-prompt`) |
| `--verbatim` | Send the prompt exactly as given |
| `--no-subagents` / `--no-plan` | Disable those features |
| `--disable-web-search` | Drop web search and web fetch |
| `--agent <NAME>` | Agent name or definition file |
| `--debug` / `--debug-file <FILE>` | Debug logging (see §4) |

Auth for CI: `XAI_API_KEY`, or `grok login --device-auth` (alias `--device-code`). Cached `~/.grok/auth.json` is used if already logged in.

## 2. Configuration

**Home is `~/.grok`**, not `~/.codex`. Override with `GROK_HOME`. There is **no** Codex-style `-c key=value` override (`-c` is `--continue`). There is **no** `--oss` flag.

User config: `~/.grok/config.toml`. Project overlay (MCP / plugins / permission only): `<repo>/.grok/config.toml`. Inspect what a directory will load: `grok inspect --json`.

Precedence (from install docs): CLI flags > env vars > requirements/MDM > `GROK_CONFIG` / `GROK_CONFIG_PATH` overlay > `~/.grok/config.toml` > managed config > defaults.

### Model selection

```toml
# ~/.grok/config.toml
[models]
default = "grok-4.6"
default_reasoning_effort = "high"
```

```bash
grok models                 # catalog + default
grok -p "…" -m grok-4.5     # per-run
```

Agent "profiles" are **agent definitions**, not Codex config profiles:

- `--agent <NAME_OR_PATH>` / `--agent-profile <PATH>` (agent subcommand)
- `[agent] name = "…"` in config, or `GROK_AGENT`

Launcher overlay without editing config.toml (1.0.5): `GROK_CONFIG='{"models":{"default_reasoning_effort":"high"}}'` or `GROK_CONFIG_PATH` (JSON/TOML). Allowlisted soft settings only.

### Local / BYOK providers

No `--oss`. Point a `[model.<name>]` at any OpenAI-compatible `/v1` (Ollama, LM Studio, vLLM, llama.cpp, llama-swap, …):

```toml
# Ollama — example from the install README
[model.ollama-codellama]
model = "codellama"
base_url = "http://localhost:11434/v1"
name = "CodeLlama (Ollama)"

# Any other local OpenAI-compatible server (LM Studio, vLLM, llama.cpp, …)
[model.local-llama]
model = "llama-3.1-70b"
base_url = "http://localhost:8080/v1"
name = "Local Llama"
api_backend = "chat_completions"   # default; also "responses" | "messages"
# env_key = "LOCAL_API_KEY"        # optional; string or array
# context_window = 128000
```

Then `grok -p "…" -m ollama-codellama`. `api_key` > `env_key` > session token > `XAI_API_KEY`. Never print or commit keys.

Fleet-wide custom catalog: `GROK_MODELS_BASE_URL` / `[endpoints] models_base_url`.

## 3. Attachments

**No** `--image`, `--attach`, `--file`, or `--add-dir` flags (all rejected as unexpected arguments). TUI `@path` fuzzy-attach is interactive-only.

Headless ways to hand the builder files:

1. **Put files in `--cwd` and name the paths in the prompt** — the agent `read_file`s them. This is the reliable pattern for text/code/reference dumps.
2. **`--prompt-file PATH`** — the **prompt text** is the file contents (not a binary attachment). Missing file → EXIT 1.
3. **`--prompt-json`** — ACP content blocks. Parser-accepted variants (errors quoted from this binary):

| `type` | Required fields | Notes |
|---|---|---|
| `text` | `text` | |
| `image` | `data` (base64), `mimeType` | Missing `data` / `mimeType` rejected. Bad bytes: model reports unsupported format. |
| `audio` | `data`, `mimeType` | |
| `resource_link` | `uri`, `name` | File reference; model may then `read_file`. |
| `resource` | `resource` object | Accepted shape: `{"uri","text","mimeType"}` (embedded text). Empty `{}` rejected. |

Array form: `[{"type":"text","text":"…"},{"type":"image","data":"<b64>","mimeType":"image/png"}]`.

Object form: `{"type":"acp","content":[…]}` (bare object needs `type` + `content`; empty array → `content blocks array is empty`).

PowerShell mangles JSON quotes to native executables; pass `--prompt-json` via Python/`cmd` or write JSON to a file and construct the argv without the shell eating `"`.

`--prompt-file` / `--prompt-json` **are** headless triggers (no `-p` needed). Combine with `--always-approve --max-turns --output-format`.

## 4. Sessions & accounting

### On-disk layout

`~/.grok/sessions/<url-encoded-cwd>/<session-id>/` (observed on this install):

| File | What it is |
|---|---|
| `summary.json` | id, cwd, timestamps, `last_active_at`, model, title |
| `updates.jsonl` | ACP session stream (authoritative transcript) |
| `events.jsonl` | Turn/MCP/phase events (`turn_started`, `turn_ended`, …) |
| `chat_history.jsonl` | Raw messages sent to the model |
| `signals.json` | Session counters (`contextTokensUsed`, `toolCallCount`, `turnCount`, `toolsUsed`) |
| `terminal/*.log` | Captured shell-tool output |
| `--debug-file FILE` | TRACE/DEBUG log at that path (empirically ~85KB for a 1-turn ping) |

`--debug` (no path) wrote `~/.grok/debug/<session-id>.txt` on this install. Also `~/.grok/logs/unified.jsonl` and `~/.grok/logs/mcp/`. `GROK_LOG_FILE` / `RUST_LOG` from install docs.

`grok sessions list -n 20` lists cwd sessions (id, created, updated, summary). `grok export <SESSION_ID>` dumps Markdown.

Each `grok -p` creates a **new** session by default. Capture `sessionId` from JSON.

### Liveness (polling orchestrator)

`json` stdout is silent until exit — **do not** treat a quiet log as death.

1. Process still running (the pid you spawned).
2. `~/.grok/active_sessions.json` entries look like `{session_id, pid, cwd, opened_at}` — **can retain a dead pid**; confirm the pid is alive.
3. Session files growing: `events.jsonl` / `updates.jsonl` mtime, `summary.json` `last_active_at`. `events.jsonl` `phase_changed` (`waiting_for_model`, `streaming_reasoning`, `streaming_text`) is a live heartbeat. `turn_ended` means that turn finished inside the process.
4. Prefer `--output-format streaming-json` so the log itself grows (`tool_call` / `text` / `end`).

Stale session files + dead pid + no `EXIT` in the orchestrator log = silent death. Salvage the tree; resume if needed.

### Token usage per run

Best source: the headless **`json` object** (or `streaming-json` `end` / per-response `usage` lines). Fields observed: `input_tokens` (uncached), `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens`, `num_turns`, `modelUsage`, `total_cost_usd` (omitted when the server does not stamp cost).

`signals.json` is **session-level context-window usage** (`contextTokensUsed` / `contextWindowTokens`), not a clean per-run bill.

`events.jsonl` did not carry a token-usage event on the ping run (`turn_ended` only).

Sum `usage` from each `-p` JSON result. Treat as approximate if `usage_is_incomplete` is true (documented for subagent drain).

## 5. Failure modes & exit codes

Determined on this binary (plus SIGINT/SIGTERM codes from the install headless doc, not re-signaled here):

| Code | When (observed or documented) |
|---|---|
| `0` | Turn completed (`stopReason: "end_turn"`) |
| `1` | Runtime/app error: max turns, missing session, bad `--prompt-json`, missing `--cwd`/`--prompt-file`, unknown `--reasoning-effort`, `--fork-session` without resume, `--session-id` not a UUID |
| `2` | Clap parse error (invalid `--output-format`, `--permission-mode`, `--max-turns 0`, unknown flags like `--oss`) |
| `130` / `143` | SIGINT / SIGTERM (install docs; session saved through last completed tool; files **not** rolled back) |

`--max-turns` hit: stderr `Error: max turns reached`, JSON still written, `stopReason: "cancelled"`, `num_turns` equals the cap, EXIT 1. Work already done on disk stays.

### Resume / fork / continue

| Flag | Semantics (this version) |
|---|---|
| `-c, --continue` | Most recent session for **this cwd**. None → EXIT 1 `No session found for current directory`. |
| `-r, --resume [<ID_OR_TITLE>]` | Resume by UUID (always ID-shaped) or cwd title. Missing UUID tried remote then `404` → EXIT 1. |
| `-s, --session-id <UUID>` | **New** session UUID only. Not a UUID → EXIT 1. Does **not** resume (old upsert is gone). With `-r`/`-c` only valid **together with** `--fork-session`. |
| `--fork-session` | With `-r`/`-c`, new session id (optionally named by `-s`). Without `-r`/`-c` → EXIT 1 `--fork-session requires --resume or --continue`. |
| `--restore-code` | Resume restores the original repo snapshot; remote resumes need `--worktree`. Without it, resume is conversation-only. |

Salvage a dead/capped run:

```bash
# Inspect what landed, then continue the same conversation
grok -p "Repo state is <files+APIs>. Do not rewrite. Remaining scope: <list>" \
  --resume <sessionId> --output-format json --always-approve --max-turns 40

# Or fork so the original transcript stays intact
grok -p "…" --resume <sessionId> --fork-session --output-format json --always-approve --max-turns 40
```

A fresh `-p` without `-r`/`-c` is a **new** context. Repo + NOTES.md (or equivalent) is the only memory unless you resume.

> Verified gotcha (grok 1.0.5): files created by built-in skills like `/imagine` are saved under the
> SESSION directory — `~/.grok/sessions/<url-encoded-cwd>/<session-id>/images/…` — not the working
> directory, even with `--cwd` set. An orchestrator must fish outputs from the newest session dir.
