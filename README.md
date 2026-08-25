# omp-orchestration

![Seven models, one brief — driven entirely by an agent through omp](assets/banner.png)

A **Claude Code skill** that lets your agent drive local **omp (oh-my-pi)** instances toward a goal (tested against omp 17.3.5):

> *"Hey — use omp to spin up instances of DeepSeek, Kimi, and GLM, and have each one build me a game menu / a dashboard / a parser. Verify their work between turns and tell me who did it best."*

With this skill installed, your agent knows how to:

- **configure providers** in `~/.omp/agent/models.yml` (any OpenAI-compatible endpoint — OpenRouter, official vendor APIs, or your own local vLLM/llama.cpp server), with the schema traps pre-solved
- **decompose a goal into bounded turns** with mechanical acceptance criteria and a NOTES.md memory trail (each omp launch is a fresh context — the repo *is* the memory)
- **launch non-interactive turns** with the battle-tested incantation (`-p --approval-mode yolo --max-time … </dev/null` + an `EXIT $?` sentinel), and poll them properly
- **diagnose every failure mode we ever hit**: deadline-exceeded salvage, provider mid-generation death, *silent process kills* (detectable only via session-jsonl staleness), empty completions
- **verify independently** — never trusting the builder's self-report — and hand-patch only small mechanical slips, logged, with everything else going back to the builder as a focused relaunch
- **run many model lanes in parallel** without them trampling each other (git pathspec discipline, per-lane verification harnesses, spend gates that pause cleanly when credits run low)
- **account tokens and spend** per lane from omp's session logs and the providers' own billing endpoints

## Install

Copy the skill into your Claude Code skills directory:

```bash
git clone https://github.com/loktar00/omp-agent-skill
mkdir -p ~/.claude/skills/omp-orchestration
cp omp-agent-skill/SKILL.md ~/.claude/skills/omp-orchestration/
```

Then just ask your agent to use omp — the skill loads on demand.

## What's in here

- **`SKILL.md`** — the skill itself: the full operating guide, written *to the agent*
- **`templates/effort_proxy.py`** — a ~90-line streaming proxy that injects request parameters omp can't send itself (e.g. vLLM's `chat_template_kwargs.reasoning_effort`); point a provider's `baseUrl` at it
- **`assets/banner.png`** — the image above: seven models' builds of the same brief, all driven agent-orchestrated through omp

## Provenance

Everything in the skill was learned the hard way: ~90 real omp turns across **10 models and 5
providers** rebuilding the Warcraft III: Reign of Chaos menu as a real-time browser scene — the
banner shows seven of those builds next to the 2002 original, including two models that built it
**completely blind** (text-only, never saw a single image). No behavior in the guide is
paraphrased from docs; it was all observed, current as of the omp build of 2026-08-25.

## License

MIT
