---
name: perf-proof
description: Prove a frontend performance change with paired, measured before/after numbers instead of projections. Builds both git refs, serves each production build locally, drives a real signed-in browser N times per condition, and computes a verdict that fails on regression. Use when a change claims a performance benefit, when establishing a baseline before optimisation work, when a work package's verification contract names a metric, or whenever someone says something "should be faster".
---

# Proving a performance change

Implements the `test-rigor` standard for performance. Read that skill first if you have not.

The rule here: **no number reaches a report unless this harness produced it.** Projections are
allowed in a plan. They are never allowed in a result, and they are never allowed to be quietly
upgraded into one.

## Why this harness exists in this shape

Four constraints, decided deliberately:

1. **Local production builds, not the dev server and not staging.** A dev build has no
   minification or chunking, so its numbers mean nothing. Staging mixes CDN and deploy variance
   into every code measurement and cannot compare an unmerged branch. Both refs are built on the
   same machine, minutes apart, and served identically.

2. **Pairing is atomic.** The signed-in numbers depend on account data that drifts — channels get
   added, feeds grow. A baseline captured last week is not comparable to a candidate captured
   today. So `run.mjs` builds and measures **both sides in one invocation**. There is no command to
   measure one side alone and compare it to a stored record later, because that is the mistake this
   design exists to prevent.

3. **Five samples per condition, cold and warm.** One run is noise. The verdict uses medians and
   reports the spread, and refuses to call a difference real when the distributions overlap.

4. **Fail on regression, report on miss.** Making a tracked metric measurably worse fails. Missing
   an improvement target is reported honestly and does not fail — those targets are projections,
   and punishing an honest partial win teaches the wrong thing.

## Targets: what makes this reusable

The harness is generic. Everything project-specific lives in `targets/<name>.json`, and every
command takes `--target <name>`:

```json
{
  "appPath": "apps/called-chat",        // where the build runs, relative to the checkout
  "buildCommand": "npm run build",
  "distPath": "dist",
  "defaultRoute": "/chat",
  "apiHost": "api.called.app",          // which requests count as API calls
  "loginPattern": "Sign in to Called",  // how to detect an expired session
  "loginUrl": "https://web.called.app/",
  "fingerprint": {
    "authSource": "firebase-indexeddb", // or omit for no drift guard
    "apiBase": "https://api.called.app",
    "endpoints": [{ "key": "channels", "path": "/v1/channel?limit=1000" }]
  }
}
```

To measure a different project, copy `targets/called-deeweb.json` and edit it. Any field can also
be overridden inline (`--api-host`, `--app-path`, `--default-route`, ...) for a one-off.

`authSource` currently supports `firebase-indexeddb` only. A target without it still measures
everything else, but the comparison is reported `UNVERIFIED` rather than `PASS`, because nothing
proved the two sides saw the same data.

## One-time setup

The signed-in numbers need a real session. The harness uses its own persistent Chrome profile so it
never fights the Playwright MCP browser for a profile lock.

```bash
node ~/.claude/skills/perf-proof/scripts/run.mjs login --target called-deeweb
```

Opens a headed browser. Log in as normal, then close it. The session persists at
`~/.perf-proof/profile` and is reused by every later run. Redo this when the session expires — the
harness tells you when it lands on the login screen instead of the app.

## Running a comparison

```bash
node ~/.claude/skills/perf-proof/scripts/run.mjs compare \
  --target   called-deeweb \
  --base-dir /path/to/a/checkout/of/develop \
  --head-dir /path/to/your/worktree \
  --label    P2-eager-bundle
```

`--route` defaults to the target's `defaultRoute`. Both checkouts need their own `node_modules`;
pass `--skip-build` to reuse an existing `dist/` instead of rebuilding.

What it does, in order:

1. Fingerprints the environment (machine, CPU count, node version, git SHAs of both refs).
2. Builds `base` into a temp dir, records every chunk's size from `dist/`.
3. Builds `head` the same way.
4. Serves the base build, measures 5 cold + 5 warm samples.
5. Serves the head build, measures 5 cold + 5 warm samples.
6. Captures a **data fingerprint** on each side (whatever counts the target's `fingerprint.endpoints` name) and
   **voids the comparison if they differ** — that is the drift guard.
7. Writes `runs/<label>-<timestamp>.json` with every raw sample.
8. Prints the verdict.

Build steps dominate wall-clock. Budget roughly 10–15 minutes per side.

To measure production instead of a build, for an anchor rather than a comparison:

```bash
node ~/.claude/skills/perf-proof/scripts/run.mjs probe --target called-deeweb --url https://web.called.app/chat --label prod-anchor
```

`probe` writes a run record but never emits a verdict, because a single side proves nothing.

## What gets measured

Per sample, from the browser's own instrumentation — never estimated:

| Metric | Source |
|---|---|
| FCP, LCP | `PerformanceObserver` paint + `largest-contentful-paint` |
| CLS | `layout-shift` entries, excluding `hadRecentInput` |
| Main-thread blocked | sum of `longtask` durations |
| TTFB, DOM interactive, load | Navigation Timing |
| JS transferred / decoded | Resource Timing, `/assets/*.js` |
| Request count, by host | Resource Timing |
| API calls, and duplicates | Resource Timing filtered to the API host |
| DOM nodes, deepest list size | evaluated after settle |
| JS heap | `performance.memory` where available |

Plus, per build and not per sample: every chunk in `dist/` with its byte size, so a bundle claim is
checked against the artifact rather than a page load.

## Reading the verdict

```
P2-eager-bundle   base 3ec205baa -> head 9f1c2d4e

  metric                    base (median)   head (median)      delta   verdict
  entryChunkBytes               3,667,683       1,204,880     -67.2%   IMPROVED
  appJsDecodedKB                    6,429           3,180     -50.5%   IMPROVED
  largestContentfulPaintMs          2,112           1,455     -31.1%   IMPROVED
  apiCallsPerLoad                      48              48       0.0%   unchanged
  cumulativeLayoutShift             0.044           0.121    +175.0%   REGRESSED

  VERDICT: FAIL - 1 regression (cumulativeLayoutShift)
  data fingerprint matched: 266 channels / 34 entities
  raw: runs/P2-eager-bundle-20260825T161200.json
```

- `IMPROVED` / `REGRESSED` are only assigned when the distributions do not overlap. Otherwise the
  metric reads `unchanged` no matter how the medians moved — that is the noise guard.
- Any `REGRESSED` metric fails the run.
- A metric that moved the right way but missed its target is reported and does **not** fail.
- If the data fingerprints differ between sides, the whole comparison is `VOID` and no verdict is
  emitted. Re-run both sides together.

## Worked example: satisfying a work package

From the called-deeweb perf audit, where each package in `tasks/perf-audit/manifest.json` carries a
`verification` block naming metrics and baselines. The same shape works for any task that promises
a number:

1. Run `compare` with `--base-dir <a develop checkout> --head-dir <the package worktree> --label <package id>`.
2. Copy the resulting medians into the package's `reports/<ID>.json` under `measurements`, and the
   run-record path under `verification[].evidence`.
3. Any metric the package promised but the harness did not measure is recorded as
   `"not measured"`. Never fill it with the projection from the audit.

## The measured noise floor

Not a guess — this is the observed spread across 5 cold samples of one unchanged page
(`web.called.app`, signed out, 2026-08-25). It tells you which claims this harness can actually
support:

| Metric | Spread across 5 identical runs | What that means |
|---|---|---|
| `appJsDecodedKB` | **0%** | Deterministic. Any change at all is real. |
| bundle sizes from `dist/` | **0%** | Read from the artifact, not a load. Trust completely. |
| `requestCount` | **2%** | Reliable. A change of a few requests is real. |
| `largestContentfulPaintMs` | **22%** | Needs a large delta before it means anything. |
| `firstContentfulPaintMs` | **29%** | Same. Do not report a 15% FCP "win". |
| `mainThreadBlockedMs` | **235%** | Effectively useless at n=5. Raise `--samples` or ignore it. |

So: **bundle and request-count claims are solid at 5 samples. Timing claims are not**, unless the
change is large. The `overlaps()` guard already refuses to label a metric IMPROVED or REGRESSED
when the sample ranges overlap — which for the timing metrics means most modest changes will
correctly read `unchanged`. Do not talk around that in your prose. If the verdict says
`unchanged`, the honest sentence is "no measurable change at this sample size", not "slightly
faster".

Re-derive this table with `probe --allow-signed-out` against an unchanged target whenever the
machine or the app changes materially.

## Honest limits — state these when reporting

- **Best case, not typical.** Fast desktop, gigabit, local server, no CDN. A cold first visit on a
  mid-range phone will be worse than any number here.
- **Signed-in numbers are only valid as a pair.** They are not comparable to a run from another day,
  because the account data will have moved.
- **Local serving is not production delivery.** Compression and edge caching differ. Bundle-size
  numbers transfer; latency numbers do not.
- **Virtualization work barely shows here.** Desktop scroll already holds ~7 ms frames. Use
  `--throttle 4` to add a CPU-throttled pass, which is where that work actually appears.
- Five samples catches gross change, not a 2% one. Do not claim a small delta the spread does not
  support — the verdict already refuses to, and your prose should match it.
