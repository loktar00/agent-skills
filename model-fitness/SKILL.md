---
name: model-fitness
description: Track which models actually succeed at which kinds of task, and swap one out when the record says it is failing. Records every delegated lane's outcome to a local ledger, surfaces per-model-per-task-type success rates, and recommends a replacement when a model repeatedly fails a category. Use when picking a model for delegated work, when a lane fails and you are deciding whether to retry or switch, when someone asks which model to use for something, or after any batch of delegated runs completes.
---

# Model fitness

Model choice is a hypothesis. This skill makes it an evidence-backed one.

The failure this prevents: a model gets assigned a role once, quietly fails that kind of work
three times in a row, and keeps getting assigned it because nobody was counting. The opposite
failure matters too — swapping away from a good model after one bad run that was really a bad
prompt.

Related: `test-rigor` for the evidence standard, `perf-proof` for measuring performance claims,
`harness-orchestration` / `omp-orchestration` for actually launching lanes.

## The ledger

One JSONL file: `~/.model-fitness/ledger.jsonl`. One line per completed lane.

```bash
node ~/.claude/skills/model-fitness/scripts/fitness.mjs record \
  --model openai-codex/gpt-5.6-sol \
  --task-type refactor-wide \
  --label P2-eager-bundle \
  --outcome pass \
  --notes "converted 12 barrel imports, build verified"
```

`--outcome` is one of:

| Outcome | Meaning |
|---|---|
| `pass` | Did the work, verification passed |
| `partial` | Real progress, verification incomplete or one goal missed |
| `fail-quality` | Ran to completion but the work was wrong |
| `fail-scope` | Edited outside its ownership, or did a different task |
| `fail-honesty` | Claimed results it did not produce — estimated numbers as measured, said tests passed when they did not |
| `fail-infra` | Deadline, provider error, silent death. **Not the model's fault** |

`fail-infra` is excluded from fitness scoring. A flaky endpoint is not a bad model, and conflating
the two is how you end up abandoning a good model. However if a flaky endpoint is stopping a current scope of work often it's appropriate to switch to a different endpoint with a different known good model.

`fail-honesty` is weighted hardest. A model that fabricates a number is worse than one that fails
loudly, because its failures are invisible.

## Task types

Keep this vocabulary small and stable or the statistics never accumulate:

| Task type | What it means |
|---|---|
| `refactor-wide` | Mechanical change across many files |
| `refactor-deep` | Subtle change in a few files where semantics matter |
| `debug` | Find and fix a defect from a symptom |
| `implement-feature` | New behaviour from a spec |
| `analysis` | Read and report, no edits |
| `test-authoring` | Write tests against existing code |
| `config-infra` | Build config, CI, tooling |
| `ui-visual` | Layout, styling, design implementation |

## Reading the record

```bash
node ~/.claude/skills/model-fitness/scripts/fitness.mjs report
node ~/.claude/skills/model-fitness/scripts/fitness.mjs report --task-type refactor-deep
node ~/.claude/skills/model-fitness/scripts/fitness.mjs suggest --task-type refactor-deep
```

`suggest` returns the best-evidenced model for a task type, and says plainly when there is not
enough evidence to have an opinion.

## The swap rule

**Switch when a model has ≥3 scored attempts at a task type and a success rate below 50%, and
another model has a better record with at least 2 attempts.** Both halves matter — the second
stops you swapping into the unknown.

Below 3 attempts, do not swap on the record. One or two failures is a prompt problem more often
than a model problem. Before blaming the model, check:

- Was the prompt actually unambiguous about what "done" means?
- Did it have a verification contract it could run itself?
- Was the failure `fail-infra` wearing another label?

Any single `fail-honesty` is worth acting on immediately regardless of count — not necessarily by
swapping, but by tightening the prompt's reporting contract and re-running.

## Known shape of the roster

Working hypotheses to be overwritten by evidence, not defended:

| Task type | Start with | Because |
|---|---|---|
| `refactor-deep`, `debug` | `openai-codex/gpt-5.6-sol` | strongest at semantics-sensitive work |
| `refactor-wide` | `zai/glm-5.3` | 1M context holds the whole graph |
| `analysis` | `google-antigravity/gemini-3.1-pro` | 1M context, cheap on the plan |
| `config-infra`, `test-authoring` | `zai/glm-4.7-flash` | small specified edits, fast |
| `ui-visual` | `google-antigravity/claude-opus-4-6` | design judgement |

All on included coding plans. Do not reach for `orr/*` (OpenRouter, per-token) unless a plan is
exhausted.

## Closing the loop

After any batch of delegated lanes:

1. `record` one line per lane, honestly. A lane you had to fix by hand is `partial`, not `pass`.
2. `report` to see whether anything crossed the swap threshold.
3. If it did, re-point the role in whatever config drives selection for that project, and note
   in the ledger why you swapped.

The ledger is only worth what you put in it. Recording a `pass` for a lane you quietly repaired
makes every later suggestion wrong.
