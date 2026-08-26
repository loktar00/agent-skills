---
name: test-rigor
description: The evidence standard for any QA work — visual, functional, regression, performance, accessibility, or mobile. Establishes what counts as proof, how to capture a baseline BEFORE changing anything, how to pair before/after when state drifts, and how to write a verdict that does not overclaim. Use whenever verifying a change works, before claiming something is done or fixed, when writing a verification plan, or when a test passes but you have not seen the thing actually work.
---

# Test rigor

One rule underneath everything: **a claim without evidence is not a result.**

"It should work now", "the tests pass so it's fine", "this will improve load time" — none of these
are findings. A finding is something you observed, with an artifact someone else could go look at.

This skill is the general standard. For before/after performance numbers specifically, use the
**`perf-proof`** skill, which implements this standard for that case.

## The four failure modes this exists to prevent

1. **Assumed, not observed.** Reasoning about what the code will do instead of running it.
2. **No baseline.** Changing the thing first, then having nothing to compare against. This is the
   most common and least recoverable — once you have edited, the "before" is gone.
3. **Wrong altitude.** A green unit test proving a function returns the right value while the
   feature is broken end to end, because the bug lives in auth bootstrap or cross-entity fetching.
4. **Single sample.** One run, one screenshot, one state — presented as though it characterises
   behaviour.

## Baseline first, always

Before you touch a single file:

- Capture the current behaviour of the thing you are about to change.
- Store it as an artifact, not a memory: a screenshot, a JSON record, a saved log, a number.
- Note the git SHA you captured it at.

If you have already started editing and never captured a baseline, say so plainly and either
`git stash` to recapture it or state in your report that no baseline exists. Do not reconstruct
one from reasoning.

**When state drifts, pair the measurements.** Some things cannot be compared against a stored
historical baseline because the underlying data moves — an account gains channels, a feed gains
posts, a sprint gains tickets. For those, baseline and candidate must be captured in one sitting,
minutes apart, against the same data. Record a fingerprint of that data (counts, ids, a timestamp)
on **both** sides, and treat the comparison as void if the fingerprints differ. Prefer a harness
that captures both sides in a single invocation, so drift cannot creep in between them.

## What counts as evidence

| QA type | Not evidence | Evidence |
|---|---|---|
| Visual | "looks right" | Screenshot of each relevant state, at each relevant viewport, both themes |
| Functional | "the handler is wired up" | You performed the action in the running app and observed the result |
| Regression | "I didn't touch that" | The adjacent flows exercised and shown still working |
| Performance | "this should be faster" | Paired measurement, N samples, median + spread, raw records kept |
| Accessibility | "I added aria-label" | Keyboard-only traversal, focus visible at each stop, contrast checked |
| Mobile / Capacitor | "it's responsive" | Exercised at the real breakpoint, and in the Android/iOS build if the change touches native |
| API behaviour | "the types say so" | The actual request and response observed, status and body recorded |

Screenshots go in a known directory and are referenced by path. Numbers come with the raw samples
they were derived from. Logs are saved, not paraphrased.

## The state matrix

Almost every real bug lives in a state nobody screenshotted. For anything user-facing, enumerate
the axes that actually apply and cover the combinations that matter:

- **Data**: empty, one item, many items, overflowing/truncating, error, loading
- **Theme**: light, dark
- **Viewport**: desktop, and mobile at the project's real breakpoint
- **Role/permission**: whatever roles change the UI
- **Connectivity**: online, and offline if the feature claims to handle it

Cover the matrix that is relevant, not one default screenshot. Say which combinations you covered
and which you deliberately skipped.

## Project-specific traps

Every codebase has a handful of traps that silently produce a false pass — a test runner that
needs a particular cwd, a port that is derived rather than fixed, a directory the search tool
skips. These are worth writing down per project, because they cost an afternoon each time they
are rediscovered.

Check `references/` in this skill for a file matching the project you are in. If there is no file
for the project you are working in, and you hit a trap of this kind, add one.

## Writing the verdict

State the result as data, then the conclusion — never the reverse.

- Report what you actually ran, including the failures. If tests failed, paste the output.
- If you skipped a step, name it and say why.
- **"Not measured" is an acceptable answer. A fabricated number is not.** Never present an estimate,
  a projection, or a plausible figure as an observation. If you are reporting a projection, label it.
- A truthful partial is worth more than a false success. `partial` with what you learned beats
  `done` with a guess.
- If the thing does not work, say that first and plainly, before any explanation.

## Before you say "done"

- [ ] A baseline exists, captured before the change, at a known SHA
- [ ] The change was exercised in the running app, not only in tests
- [ ] The relevant state matrix is covered, and gaps are named
- [ ] Adjacent flows checked for regression
- [ ] The project's test and lint commands green, run from wherever the project requires
- [ ] Artifacts saved and referenced by path
- [ ] Every number in the report traces to a raw sample, and projections are labelled as such
