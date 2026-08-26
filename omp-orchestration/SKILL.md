---
name: omp-orchestration
description: Lets an agent drive local omp (oh-my-pi) instances toward a user's goal — spin up one or many model "lanes", configure providers, decompose the goal into bounded turns, launch/monitor/salvage non-interactive omp runs, verify independently, and account tokens/spend. Use when the user says things like "use omp to have <model> build <thing>" or "run this goal across several models", when adding a provider to models.yml, or when an omp turn misbehaves.
---

# Driving omp with an agent

You (the agent) are the ORCHESTRATOR. The model running inside omp is the BUILDER. You never write
the deliverable yourself — you set up the work, launch bounded builder turns, verify what comes
back, fix small mechanical slips, and keep an audit trail. This division is what makes results
credible: the builder's work stays the builder's work.

> Provenance: distilled from ~90 real omp turns across 10 models and 5 providers (OpenRouter,
> DashScope, DeepSeek official, a stealth-model gateway, local vLLM), on the omp build current as
> of 2026-08-25. omp evolves — sanity-check flags against `omp --help` before relying on them.

## 1. What omp is

`omp` is a CLI coding-agent harness: point it at any OpenAI-compatible model, give it a prompt, and
it runs an agentic loop (read/write/bash/grep/LSP tools) inside the current working directory.

Key property: **cwd is the contract.** At launch omp loads `<cwd>/.omp/AGENTS.md` (the builder's
role + project brief), `<cwd>/.omp/RULES.md` (non-negotiables), and `<cwd>/.omp/config.yml`.
Always launch from the lane's directory.

## 2. From a user goal to a run plan

When the user says "use omp to drive <model(s)> toward <goal>":

1. **Scaffold each lane yourself** — one directory per model. Seed the skeleton (entry files,
   vendored deps, lint/check tooling, reference material). Never make the builder scaffold; wasted
   turns and divergent layouts.
2. **Write `.omp/AGENTS.md`** — the builder's role, the goal, repo layout, how its work will be
   verified, hard constraints (e.g. "no CDNs", "≤250 lines/file", "do not start servers").
3. **Decompose the goal into numbered turn prompts** (`prompts/turns/01-*.md` …). Each turn:
   - one focused, ≤80-minute task;
   - an explicit ACCEPTANCE section you can check mechanically (exact API names, file outputs,
     numeric specs) — this is your verification script;
   - "where this prompt gives explicit numbers, the prompt wins" (builders drift from their own
     design docs);
   - ends with "append a checkpoint to NOTES.md". Each `-p` launch is a FRESH context: repo state
     + NOTES.md is the builder's only memory.
4. **Define an interface contract** if lanes must be comparable or testable (exact global APIs,
   event names, file layout). Identical contracts are what make cross-model comparison honest.
5. **Forewarn known traps** in the prompt (see §8) — one warning line prevents entire bug classes.

## 3. Provider configuration (`~/.omp/agent/models.yml`)

```yaml
providers:
  myprov:                                 # used as --model myprov/<model-id>
    baseUrl: https://openrouter.ai/api/v1 # any OpenAI-compatible endpoint, incl. http://127.0.0.1:8080/v1
    api: openai-completions
    apiKey: sk-...
    compat:
      supportsReasoningEffort: true
      maxTokensField: max_tokens
      streamIdleTimeoutMs: 900000
      supportsStore: false
      supportsDeveloperRole: false
    models:
      - id: some-vendor/some-model        # slashes in ids are fine; --model splits on FIRST slash
        name: Some Model
        reasoning: true
        input: [text, image]              # [text] for blind models; gates @image attachments
        contextWindow: 262144
        maxTokens: 32768
        cost: {input: 3, output: 15, cacheRead: 0, cacheWrite: 0}   # ALL FOUR cost keys REQUIRED
```

- Local models (vLLM/llama.cpp/llama-swap) work identically via their local baseUrl.
- Never print or commit apiKey values. Edit models.yml with anchored, unique replacements.
- Parameters omp can't send (e.g. vLLM `chat_template_kwargs.reasoning_effort`): run the tiny
  body-rewriting proxy in `templates/effort_proxy.py` and point baseUrl at it.
- **Probe the raw endpoint before wiring it in** (curl/python, not omp): tiny completion (key +
  model id live?), `image_url` data-URI (vision? → sets `input:`), pricing/modalities (OpenRouter:
  `GET /api/v1/models` lists `architecture.input_modalities` + pricing per model). omp never sends
  video — if a model accepts `video_url`, do video analysis as a one-shot direct API call and save
  the result where turns can read it.

## 4. The canonical turn launch

```bash
cd <LANE_DIR> && omp -p \
  --model <provider>/<model-id> \
  --approval-mode yolo \
  --max-time 4800 \
  @prompts/turns/03-weather.md @ref/target.jpg \
  "Implement the attached turn exactly; images are reference material; where the prompt gives \
   explicit numbers the prompt wins; finish with checks + a NOTES.md checkpoint" \
  </dev/null > build/turn-logs/03.log 2>&1; echo "EXIT $?" >> build/turn-logs/03.log
```

- `-p` non-interactive; `--approval-mode yolo` auto-approves tools (required unattended).
- `--max-time <s>`: hard cap; at expiry omp prints `Deadline exceeded`, exits 1. 3600 for fast
  models, 4800 for reasoning-heavy ones.
- `@file`: text inlined; images sent as vision iff the model's `input:` lists image. 1–2 images/turn.
- `</dev/null` is **mandatory** in scripts (omp can block on stdin without it).
- The `echo "EXIT $?"` sentinel is your completion signal: run the whole line as a background task
  and poll `grep -q "EXIT" <log>` every ~60s. Never a bare long sleep.
- `--thinking off|minimal|low|medium|high|xhigh|max|auto` (default auto ≈ the API's own default).
  Leave at default for "stock settings" comparability; set deliberately otherwise.

## 5. Failure modes (all observed repeatedly — memorize this table)

| Signal | Meaning | Your move |
|---|---|---|
| `EXIT 0` | turn finished | verify (§6) |
| `EXIT 1` + `Deadline exceeded` | capped; work usually MOSTLY landed | salvage: check files, run checks, write the missing NOTES checkpoint yourself (labelled orchestrator-written); relaunch only if essentials missing |
| `EXIT 1` + provider error | upstream died mid-generation | inspect what landed; fragmentary → relaunch with a **CONTINUE preamble** ("repo state is: <files + their APIs>; do not rewrite; remaining scope: <list>") |
| log stuck `Working...`, no EXIT, session jsonl stale >20 min | **silent process death** (external kill; the stream-idle timer can't fire on a dead process) | treat as dead; salvage or CONTINUE — landed code was substantially complete every time we saw this |
| `EXIT 0`, zero work | provider returned an empty completion | relaunch as-is |

**Liveness check** for a running turn: newest file mtime in
`~/.omp/agent/sessions/--<cwd-with-dashes>--/` (e.g. `D:\dev\myproj\lane-a` →
`--D--dev-myproj-lane-a--`). The log's `Working...` heartbeat is NOT a health signal; the session
jsonl's growth is.

## 6. Verification discipline

- **Verify independently, mechanically, every turn.** Run the acceptance checks yourself (static
  checks, contract probes, screenshots if visual). "It exited 0" and the builder's self-report are
  not verification — though well-behaved models' self-reports usually match.
- Per-lane verification harnesses, never shared ones: give each lane its own headless browser /
  test runner. A shared instance serializes all lanes and wedges under contention.
- **Hand-patch policy**: you may fix small MECHANICAL slips yourself (a dropped wiring line, a
  units/scale constant, a wrong normal, a CSS specificity clash). Log every patch in the lane's
  NOTES.md with symptom + root cause. Anything needing real design goes back to the builder as a
  relaunched focused turn. Keep the tally — it's your per-model quality metric.
- Instrument, don't eyeball: sample pixel RGBs instead of judging a dark thumbnail; time-series a
  property (`getComputedStyle`, `light.intensity`) instead of trusting one screenshot of a
  transient. Under CPU load, headless timing drifts — trigger effects in ISOLATION before calling
  a timing bug.
- Statics that lie: `node --check` and eslint do NOT catch duplicate ESM import bindings (fatal at
  link time). After any entrypoint edit run
  `node --input-type=module -e "await import('./src/main.js')"` — a SyntaxError before
  browser-global ReferenceErrors means a broken page.

## 7. Multi-lane orchestration

- Lanes parallelize perfectly (separate cwds/providers). Six concurrent turns ran with zero
  interference for us.
- **Git in a shared repo**: `git add -A <LANE_DIR>` then `git commit -m "..." -- <LANE_DIR>`. The
  pathspec on the COMMIT is what saves you — a bare `git commit` commits the whole shared index,
  including another lane's staged-but-uncommitted files (this happened to us).
- **Spend gates**: before every launch, query the billing endpoint (OpenRouter `GET /api/v1/key` +
  `/api/v1/credits`; DeepSeek `GET /user/balance` — the API key reads its own spend). Below a
  floor (~2 turns' cost): don't launch, write a "PAUSED (credits)" note, stop at a clean turn
  boundary. Resume = just launch the paused turn.
- **Token accounting**: sum `completion_tokens` from the usage records in the lane's session
  jsonls. Shapes vary by provider; treat sums as ±10% and present with `~`.
- Delegating lane supervision to sub-agents works, but they stall at long waits — give them
  bounded in-call poll loops, and keep a cheap change-driven monitor + the authority to
  batch-verify stalled lanes yourself.

## 8. Cross-model bug classes worth forewarning (each hit 2–7 independent models)

1. **Built-but-never-connected**: a module/file written but never imported/registered/called — at
   every granularity (a whole subsystem coordinator, one `modules.x = create()` line, a physics
   write-back). After integration-heavy turns, diff the full wiring against expectations.
2. **Dual-path event handling**: hooking a wrapped API function OR real DOM events, not both — the
   single most-reproduced bug in our runs (7 lanes). Require both paths in the prompt and test both.
3. **Magnitude miscalibration** (visual domains): dark PBR albedos, light units crushed by tone
   mapping, forces integrated weaker than gravity, geometry 2–3× its own spec. Structure is
   usually right; magnitudes need measured verification (project to screen space, sample pixels).
4. **Rewiring regressions**: turns that edit a shared entrypoint silently drop unrelated existing
   lines (three lanes broke prior work while adding a new subsystem). Diff the entrypoint after
   every turn that touches it.
5. **Multiplicative color darkening**: texture × vertexColor × instanceColor stacking the same
   dark value into near-black.
6. Text-only ("blind") models are viable builders: structure and logic land; what they can't do is
   judge magnitudes. Feed them a precise WRITTEN defect list (positions, sizes, colors) for polish
   turns — blind FIXING from a good diagnosis works almost perfectly.

## 9. Quickstart recipe

User: "use omp to have <model> build <thing>" →
1. Probe the endpoint; add provider+model to models.yml (§3).
2. Scaffold the lane: skeleton + `.omp/AGENTS.md` + `.omp/RULES.md` + turn prompts with acceptance
   criteria (§2). Serve/preview infra is YOURS to run, not the builder's.
3. Launch turn 1 (§4) as a background task; poll for EXIT; on failure use the table (§5).
4. Verify (§6); hand-patch mechanical slips (logged) or relaunch focused turns; commit per
   verified turn (pathspec!).
5. Repeat through the final turn; for a polish turn, attach the target reference + a fresh capture
   of the current state (or a written defect list for blind models).
6. Report per-turn results, the patch tally, and token/spend totals.

For "run this goal across SEVERAL models": one lane per model, identical prompts and interface
contract, same verification recipe — the deltas between lanes become your comparison.
