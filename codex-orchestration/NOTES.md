# Verification notes

## Target and method

- Verified on 2026-08-25 against `codex-cli 0.147.0`, installed through npm. PowerShell script
  execution blocked `codex.ps1`, so command probes used the same installation's
  `C:\Program Files\nodejs\codex.cmd` launcher.
- Read `REFERENCE-omp-skill.md` for shape, then kept `SKILL.md` to Codex engine mechanics only.
- Read the real `C:\Users\lokta\.codex` tree and parsed `config.toml` read-only with values
  redacted except non-secret engine settings. No real Codex config, auth, rollout, or state file
  was edited or deleted.
- Ran `codex doctor --json` with the real `CODEX_HOME`. It loaded the real config successfully,
  reported version 0.147.0 and provider `openai`, and exited 1 because one or more diagnostic checks
  failed. The config size/mtime and active-rollout count were unchanged before versus after.

## Verified by local commands and files

- `codex --version`, `codex --help`, `codex exec --help`, `codex doctor --help`,
  `codex exec resume --help`, `codex resume --help`, and `codex fork --help` established every CLI
  flag documented in `SKILL.md`. Flags present in current official docs but absent from the
  installed `codex exec --help` were intentionally omitted.
- `codex exec --sandbox workspace-write --approve-for-me ...` exited 2 with the exact mutual-
  exclusion error documented in section 1. `--approve-for-me` alone parsed, started a thread, and
  reached the provider. `-s workspace-write -c 'approval_policy="never"'` also parsed. Trying the
  interactive `-a never` under `codex exec` exited 2 as an unexpected argument.
- `--dangerously-bypass-approvals-and-sandbox`, `-C`, `-m`, `-p`, `-c`, `--json`, `-o`,
  `--skip-git-repo-check`, `--oss`, and both `--local-provider` values were each passed to the
  installed binary. The probes progressed past argument parsing to the expected next boundary.
- A temporary base config plus `lane.config.toml` showed `-p lane` changing the run header's model
  from the base model to the profile model. `codex doctor -c ... --json` reported the overridden
  model, provider, approval policy, and sandbox. The temporary files were isolated from the real
  Codex home.
- Ollama was installed but its server could not start/respond; LM Studio was not responding.
  Ollama and LM Studio selections each exited 1 with backend-specific startup guidance. Therefore
  the local command in `SKILL.md` is syntax- and startup-path-verified, but a completed local-model
  inference was not available in this environment. It deliberately tells the caller to use the
  exact id from the running server rather than inventing a model id.
- `codex debug prompt-input` with a real PNG emitted `input_image` with a
  `data:image/png;base64,...` URL. Supplying two paths emitted two image items. Supplying `TASK.md`
  through `-i` produced “image content omitted because it could not be processed.” Putting a
  positional prompt after `-i` caused the variadic image option to consume it as another path;
  this is why the documented example puts the prompt first.
- `codex exec --help` states the two stdin forms. This task's own `codex exec` log also printed
  `Reading additional input from stdin...`, confirming that a supplied prompt plus piped stdin is
  treated as additional input.
- Neither `--timeout` nor `--max-time` exists in 0.147.0: direct probes exited 2 as unknown
  arguments, and `codex exec --help` exposes no wall-clock limiter.
- Real-home inspection found active rollouts under
  `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` and archived rollouts directly under
  `archived_sessions/`. The active session's `session_meta` contained the same UUID as its filename,
  `originator: codex_exec`, `source: exec`, and `cli_version: 0.147.0`.
- The current rollout grew from 309,791 to 785,561 bytes during observation while its Windows mtime
  remained unchanged. Its matching `thread-writer-locks/<uuid>.lock` was held exclusively. Locks
  for ended temporary processes were absent. This supports the liveness caveats in section 4.
- Real rollout `token_count` events contained both `total_token_usage` and `last_token_usage`, with
  input, cached-input, cache-write-input, output, reasoning-output, and total token fields.
- A JSON-mode provider failure emitted `thread.started`, `turn.started`, retry/error records, then
  `turn.failed`, and exited 1. `-o` did not create a final-message file on that failure.
- Parser conflicts exited 2. Missing/trust-invalid Git workspace, unavailable Ollama/LM Studio,
  missing resume UUID, and provider/transport failure exited 1.
- A deliberately interrupted temporary session had `task_started` with no `task_complete`.
  `codex exec ... resume <id>` reused the same thread id and grew the same rollout from 39,024 to
  46,536 bytes, proving that an incomplete saved turn is resumable. Resuming a normally failed
  temporary turn behaved the same way. Changing the model on resume emitted a mismatch warning.
- Help inspection confirmed that `codex fork` launches the interactive session flow and that
  `codex exec` exposes `resume` but no `fork` subcommand.

## Corroborated by official OpenAI documentation

- The official [developer command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
  corroborated config precedence, profile-file naming, local-provider choices, JSONL output, image
  paths, and final-message capture.
- The official [non-interactive mode guide](https://learn.chatgpt.com/docs/non-interactive-mode)
  supplied the successful `turn.completed.usage` JSON shape and documents `turn.failed`, stdin
  append behavior, persisted rollouts, and resume by id.
- The official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  corroborated `model`, `model_provider`, `oss_provider`, `approval_policy`, `approvals_reviewer`,
  and `sandbox_mode`, plus the sibling `NAME.config.toml` profile layout.
- The official [auto-review guide](https://learn.chatgpt.com/docs/sandboxing/auto-review)
  corroborated that auto-review changes who evaluates eligible boundary requests without removing
  the sandbox boundary.

## Prior knowledge or uncompleted probes

- A fully successful nested model turn could not be completed because the isolated OpenAI probe
  hit the sandbox's TLS `UnknownIssuer`/transport failure and no local server was available. Thus
  the table's successful process exit code `0` is the standard CLI success convention rather than
  an exit observed from a completed nested inference in this verification session. The successful
  `turn.completed.usage` event shape is from the official OpenAI guide, not a local completed turn.
- No exit number is claimed for external termination; it is intentionally labeled supervisor/OS-
  specific. No undocumented inference is made about rollback, partial edits, provider billing, or
  token accuracy after an unflushed hard kill.

