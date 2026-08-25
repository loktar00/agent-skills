---
name: codex-orchestration
description: Drive local Codex CLI instances non-interactively from an external orchestrator, including unattended launch permissions, working-directory and input handling, configuration and local-model selection, attachments, rollout liveness and token accounting, exit interpretation, and recovery through resume. Use when another agent or automation runner needs to launch, monitor, account for, or continue headless `codex exec` work.
---

# Codex orchestration engine adapter

> Compatibility: verified against `codex-cli 0.147.0` on 2026-08-25. Re-run
> `codex --version`, `codex --help`, `codex exec --help`, `codex exec resume --help`, and
> `codex doctor --json` before relying on this surface with another release.

## 1. Canonical unattended launch

Use a unique run directory and launch a background wrapper that always records Codex's exit code:

```bash
LANE_DIR=/absolute/path/to/lane
RUN_DIR="$LANE_DIR/build/codex-runs/turn-03"
MODEL=gpt-5.6-sol
PROMPT='Implement the requested turn, run its checks, and report what changed.'

mkdir -p "$RUN_DIR"
(
  if codex exec \
      --approve-for-me \
      -C "$LANE_DIR" \
      -m "$MODEL" \
      --json \
      -o "$RUN_DIR/final.txt" \
      "$PROMPT" \
      </dev/null
  then rc=0
  else rc=$?
  fi
  printf '%s\n' "$rc" >"$RUN_DIR/exit-code"
) >"$RUN_DIR/events.jsonl" 2>"$RUN_DIR/stderr.log" &
printf '%s\n' "$!" >"$RUN_DIR/pid"
```

- `codex exec` is the non-interactive agentic runner. `-C/--cd` sets its workspace root; do not
  rely on the orchestrator's own current directory.
- `--approve-for-me` selects the `workspace-write` sandbox and routes eligible boundary requests
  to the automatic reviewer. It keeps a sandbox boundary; an approved escalation may proceed,
  while a denied one is returned to the agent.
- **Do not add `-s/--sandbox` to that command.** In 0.147.0, every explicit sandbox selection is
  mutually exclusive with `--approve-for-me`; the parser exits 2 with
  `the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'`.
- To avoid both a human and a reviewer, replace `--approve-for-me` with
  `-s workspace-write -c 'approval_policy="never"'`. Boundary-crossing operations then fail and
  are returned to the agent. `codex exec` 0.147.0 does not accept the interactive CLI's `-a` flag.
- `--dangerously-bypass-approvals-and-sandbox` is the only confirmed completely unrestricted
  mode. Use it only when the entire process already runs inside an externally enforced sandbox.
- With a prompt argument, piped stdin is appended as a `<stdin>` block. With no prompt argument,
  or with prompt `-`, stdin supplies the prompt. Close stdin with `</dev/null` when it is not an
  intentional input so inherited pipes cannot add context or remain open.
- Poll for `exit-code`; also parse `events.jsonl` for `turn.completed` or `turn.failed`.
  `final.txt` is the final assistant message, not a status signal, and can be absent on failure.
- `codex exec` 0.147.0 exposes no wall-clock limit. The orchestrator must impose one externally,
  terminate the Codex child/process tree, and preserve the run directory and thread id for resume.

## 2. Configuration

The default user config is `$CODEX_HOME/config.toml`, with `CODEX_HOME` defaulting to `~/.codex`.
These are the essential model-provider keys:

```toml
model = "gpt-5.6-sol"
model_provider = "openai"
oss_provider = "ollama" # or "lmstudio"; used by --oss
```

`-m/--model` overrides the configured model for one invocation. `-c/--config key=value` overrides
any config key for one invocation, accepts dotted keys, and parses the value as TOML when possible:

```bash
codex exec -C "$LANE_DIR" \
  -c 'model="gpt-5.6-terra"' \
  -c 'model_reasoning_effort="high"' \
  --approve-for-me "$PROMPT" </dev/null
```

Profiles in this release are separate sibling files, not `[profiles.*]` tables. For profile
`builder`, create `$CODEX_HOME/builder.config.toml`, then select it with `-p builder`. The profile
layers over base `config.toml`; invocation-level `-c` and dedicated `-m` choices take precedence.

For a local server, use the exact model id reported by that server. This Ollama example is
unattended and remains workspace-sandboxed:

```bash
# Start Ollama first, and choose an exact NAME shown by: ollama list
MODEL_ID='<name-from-ollama-list>'
codex exec \
  --oss --local-provider ollama -m "$MODEL_ID" \
  -s workspace-write -c 'approval_policy="never"' \
  -C "$LANE_DIR" "$PROMPT" </dev/null
```

For LM Studio, start its local server, use its loaded model id, and replace `ollama` with
`lmstudio`. `--local-provider` accepts only `ollama` or `lmstudio` and overrides `oss_provider`;
`--oss` without the explicit selector uses `oss_provider`. Startup exits 1 before a turn when the
selected local server is not responding.

## 3. Attachments and reference files

`-i/--image` accepts one or more local image paths for the initial message. A verified PNG became
an `input_image` data URL; a Markdown file passed through `-i` was omitted as unprocessable, so
this is not a generic file-attachment flag.

Because `-i` consumes one or more following path arguments, put the prompt before the image option:

```bash
codex exec --approve-for-me -C "$LANE_DIR" \
  'Implement this UI using both screenshots as visual references.' \
  -i "$LANE_DIR/ref/target.png" "$LANE_DIR/ref/current.png" \
  </dev/null
```

For text, code, PDFs, or other reference files, place them inside the workspace and name their
paths in the prompt so the agent can read them with its tools. To inline a text reference, pipe it:

```bash
codex exec --approve-for-me -C "$LANE_DIR" \
  'Treat stdin as the specification and implement it.' <"$LANE_DIR/ref/spec.md"
```

## 4. Sessions, liveness, and accounting

Persistent exec sessions are JSONL rollout files:

```text
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<THREAD_ID>.jsonl
$CODEX_HOME/archived_sessions/rollout-<timestamp>-<THREAD_ID>.jsonl
```

The first `--json` event is `{"type":"thread.started","thread_id":"..."}`. Save that id; the
active rollout filename ends with it. Do not add `--ephemeral` when filesystem monitoring, token
accounting, or resume is required, because that mode does not persist rollout files.

For filesystem liveness, poll the matching rollout's byte length. Growth proves that events are
still being recorded. On the verified Windows build, the length grew while `LastWriteTime` stayed
at its open-time value, so mtime alone is unsafe. A live writer also held
`$CODEX_HOME/thread-writer-locks/<THREAD_ID>.lock` exclusively; treat that internal lock as a
secondary, version-specific signal. A quiet model call may produce no rollout growth, so stale
size is not proof of death; retain and check the wrapper PID as the authoritative process signal.

For each invocation, extract the terminal JSON event from the captured stdout stream:

```bash
jq -c 'select(.type == "turn.completed") | .usage' "$RUN_DIR/events.jsonl"
```

`usage` contains `input_tokens`, `cached_input_tokens`, `output_tokens`, and
`reasoning_output_tokens`. The rollout fallback is the latest `event_msg` whose payload type is
`token_count`; its `payload.info.total_token_usage` is cumulative for the whole thread and its
`last_token_usage` is the latest model call:

```bash
jq -s '[.[]
  | select(.type == "event_msg" and .payload.type == "token_count")
  | .payload.info.total_token_usage] | last' "$ROLLOUT"
```

Do not sum `total_token_usage` snapshots. For a resumed thread, prefer each invocation's
`turn.completed.usage`; otherwise subtract the cumulative total recorded before the resume from
the total after it.

## 5. Failure modes, exits, resume, and fork

| Observed end | Exit/status | Meaning |
|---|---:|---|
| `turn.completed`, final message written | 0 | The exec invocation completed successfully. |
| `turn.failed` in JSONL | 1 | A running turn failed; observed for provider/transport failures. The rollout remains saved. |
| No JSON turn; trust check or local-provider startup error | 1 | Startup failed before model work. Outside a trusted Git directory, either use a repository or deliberately add `--skip-git-repo-check`. |
| Missing resume id | 1 | No rollout matched the requested thread. |
| Conflicting or unknown CLI arguments | 2 | Usage/parser error; no turn starts. |
| External timeout or process kill | supervisor/OS-specific | Codex emits no guaranteed terminal event or portable exit code. An incomplete rollout can still be resumable. |

Resume by explicit thread id; it is deterministic and works for both a failed turn and a rollout
whose prior process ended before `task_complete`:

```bash
codex exec --approve-for-me -C "$LANE_DIR" resume "$THREAD_ID" \
  -m "$MODEL" \
  --json -o "$RUN_DIR/resume-final.txt" \
  'Continue from the existing state; finish the remaining work and checks.' \
  </dev/null
```

Options belonging to the parent `exec`, including `--approve-for-me` and `-C`, must appear before
`resume`. The resumed invocation emits the same thread id and appends to the same rollout. Keep the
original model with `-m` unless a switch is deliberate; 0.147.0 allows a switch but emits a model
mismatch warning. `codex exec resume --last` chooses the newest recorded session filtered by the
current directory; explicit ids are safer for concurrent orchestration.

`codex fork` is an interactive TUI command in 0.147.0, and `codex exec` has no `fork` subcommand.
There is therefore no confirmed headless fork path in this release; use `codex exec resume` for an
unattended continuation.

