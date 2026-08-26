---
name: harness-orchestration
description: The meta-skill above the per-engine adapters — pick the right coding-agent harness for a goal, drive fleets of headless instances through existing adapters (omp, codex, grok), and when a harness has NO adapter yet, LEARN it empirically and have the harness write its own adapter skill. Use when the user names a harness you have no adapter for, says "learn <tool> and add it", asks which harness to use for a job, or wants a goal run across multiple harnesses.
---

# Harness orchestration (meta)

You sit one level above the engine adapters. Adapters (`omp-orchestration`,
`codex-orchestration`, `grok-orchestration`, …) each teach you ONE engine's mechanics. This skill
teaches you to **choose** between them, **combine** them, and — the important part — **grow** the
set: when a harness has no adapter, you learn it and it writes its own.

Naming convention: every adapter is `<engine>-orchestration` in `~/.claude/skills/`. Check what's
installed before assuming.

## 1. Dispatch: choosing a harness for a goal

1. Inventory: which harness CLIs are installed (`<cli> --version`), and which adapters exist.
2. Prefer a harness you have an adapter for. Between those, choose on: model support (does it
   reach the model the user wants — local endpoints included), efficiency (token/context economy
   observed in past runs), and unattended fitness (real headless mode, auto-approval, exit codes).
3. The lane pattern is harness-agnostic: one directory per lane, orchestrator per lane, bounded
   turns, independent verification, results reported up. Different lanes may run DIFFERENT
   harnesses in one job — the interface contract between you and a lane is the repo state, not
   the engine.
4. If the user names a harness with no adapter: run the learning protocol (§2). If the harness
   turns out unfit for unattended work, say so with the evidence and recommend an alternative.

## 2. The harness learning protocol

Goal: from "never used it" to "verified adapter skill" in one session. Everything empirical —
never document a flag you didn't confirm against the installed binary.

**Phase A — recon (free, no spend):**
1. `<cli> --version`; `<cli> --help` in full, plus every relevant subcommand's help.
2. Identify candidates for: headless/non-interactive mode · auto-approval / permission bypass ·
   working-directory control · time or turn caps · file/image attachment · provider or model
   config (file? flags? env?) · session/log storage location · resume/continue.
3. Check auth state (whoami/doctor/status subcommand, or a config/auth file).

**Phase B — live probes (minimal spend, expect surprises):**
4. Make a scratch lane dir. Probe the headless mode with a trivial prompt, `</dev/null`, output
   redirected, exit code captured (`; echo "EXIT $?" >> log`). THE FIRST LAUNCH USUALLY FAILS —
   that failure is data, not a setback. Worked examples from this repo's own history:
   - grok: a positional PROMPT silently opened the interactive TUI despite `--output-format`
     being set; headless required `-p`. Found only because the log filled with ANSI alt-screen
     codes. (Kill stray TUI processes after this class of failure.)
   - codex: `--sandbox` turned out mutually exclusive with `--approve-for-me` — instant exit 2.
5. Iterate until you have ONE proven launch incantation that: runs unattended, writes tool-using
   agentic output (not just a chat reply), exits, and reports a code.
6. Probe liveness signals: while a turn runs, find what grows on disk (session jsonl, rollout
   file, debug log). The harness's stdout heartbeat is usually NOT a health signal; file mtime is.
7. Note what's MISSING (no wall-clock cap? no usage records?) — absences are adapter content too:
   the orchestrator must compensate (external timeout, cost estimation).

**Phase C — self-documentation (the harness writes its own adapter):**
8. Scaffold a lane containing: a reference adapter (this repo's omp or grok SKILL.md) and a
   TASK.md from the template below.
9. Launch the harness ON that lane with your proven incantation. It documents itself: its model
   has current knowledge of its own CLI, and — instructed properly — verifies every claim by
   running its own help commands and inspecting its own config/session directories.
10. Seed your Phase-B discoveries into the task brief ("we already found X — verify and document
    it") so hard-won traps land in the adapter verbatim.

**Phase D — verification (never skip):**
11. Flag audit: extract every `--flag` the produced SKILL.md mentions; diff against the full help
    output. Anything claimed-but-absent gets removed or fixed.
12. Spot-run the adapter's own canonical launch command on a trivial prompt.
13. Require an evidence-labeled NOTES.md: each documented fact marked as verified-by-command,
    verified-by-filesystem, or prior-knowledge/unconfirmed. Honest "not confirmed" entries are a
    feature, not a defect.
14. Install to `~/.claude/skills/<engine>-orchestration/SKILL.md`; contribute the adapter +
    NOTES.md back to the repo if appropriate.

## 3. TASK.md template for Phase C

```markdown
# Task: write the <engine>-orchestration engine adapter skill

You are <ENGINE CLI>, documenting YOURSELF for an external orchestrating agent that drives
headless <engine> instances toward goals — like REFERENCE-*.md does for its engine. Read the
reference for shape and rigor.

Write `SKILL.md` here: YAML frontmatter (name: <engine>-orchestration; description with
when-to-use phrasing), then ENGINE MECHANICS ONLY (shared doctrine lives elsewhere):
1. Canonical unattended launch — flags, approval/sandbox tradeoffs, working dir, stdin, exit-code
   capture for a polling orchestrator, time/turn caps (or their absence).
2. Configuration — model/provider selection incl. local endpoints, with a working example.
3. Attachments — how reference files/images reach the agent.
4. Sessions & accounting — storage paths, liveness-from-filesystem, token usage extraction.
5. Failure modes & exit codes you can DETERMINE, plus resume/continue semantics.
Known findings to verify and include: <your Phase-B discoveries>.

RIGOR: verify every flag by running your own CLI's help in this session; inspect your real
config/session dirs READ-ONLY. State the exact version verified against. Write NOTES.md labeling
every fact: verified-by-command / verified-by-filesystem / prior-knowledge. Do not document flags
you could not confirm.
```

## 4. Doctrine pointer

Turn design, acceptance criteria, NOTES-as-memory, hand-patch policy, salvage table, multi-lane
git/spend discipline, cross-model bug classes: see the root `omp-orchestration` skill §2 and
§5–§8 — that doctrine is engine-agnostic and applies unchanged to every adapter this protocol
produces.
