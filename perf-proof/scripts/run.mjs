#!/usr/bin/env node
/**
 * perf-proof runner: paired, measured before/after for any web app.
 *
 * Everything project-specific lives in targets/<name>.json. The harness is generic.
 *
 *   node run.mjs login   --target called-deeweb
 *   node run.mjs compare --target called-deeweb --base-dir <checkout> --head-dir <checkout> --label P2
 *   node run.mjs probe   --target called-deeweb --url https://example.com/ --label anchor
 *
 * Deliberately has no "measure one side and compare later" mode. Signed-in numbers depend on
 * account data that drifts, so a stored historical baseline is not comparable. Pairing is atomic
 * or it does not happen.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir, hostname, cpus } from 'node:os';

const SKILL_DIR = join(import.meta.dirname, '..');
const HOME = join(homedir(), '.perf-proof');
const PROFILE = join(HOME, 'profile');
const RUNS = join(HOME, 'runs');

const SAMPLES = 5;
const SETTLE_MS = 9000;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

// Lower is better for every metric here, which is what makes the verdict direction unambiguous.
const METRICS = [
  ['entryChunkBytes', 'largest JS chunk in dist/'],
  ['totalJsBytes', 'all JS in dist/'],
  ['appJsDecodedKB', 'JS decoded on load'],
  ['firstContentfulPaintMs', 'FCP'],
  ['largestContentfulPaintMs', 'LCP'],
  ['mainThreadBlockedMs', 'long tasks total'],
  ['cumulativeLayoutShift', 'CLS'],
  ['apiCallsPerLoad', 'API calls'],
  ['duplicateApiCalls', 'duplicate API calls'],
  ['requestCount', 'total requests'],
  ['thirdPartyHosts', 'third-party hosts'],
  ['domNodes', 'DOM nodes'],
];

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const log = (...a) => console.log(...a);
const die = (m) => { console.error(`\nERROR: ${m}\n`); process.exit(1); };

/* ------------------------------------------------------------------ targets */
/* Everything project-specific lives in targets/<name>.json so the harness itself stays generic. */
function loadTarget() {
  const dir = join(SKILL_DIR, 'targets');
  const available = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
    : [];
  const name = flag('target');
  if (!name) {
    die(`--target is required. Available: ${available.join(', ') || '(none)'}\n` +
        `  Add one by copying targets/called-deeweb.json and editing the constants.`);
  }
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) die(`unknown target "${name}". Available: ${available.join(', ') || '(none)'}`);
  const t = JSON.parse(readFileSync(path, 'utf8'));

  // Inline overrides, so a one-off does not need a new target file.
  for (const key of ['apiHost', 'appPath', 'buildCommand', 'distPath', 'defaultRoute', 'loginPattern', 'loginUrl']) {
    const v = flag(key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()));
    if (v) t[key] = v;
  }
  for (const req of ['appPath', 'apiHost', 'loginPattern']) {
    if (!t[req]) die(`target "${name}" is missing required field: ${req}`);
  }
  t._name = name;
  return t;
}

/* ------------------------------------------------------------------ page-side probe */
/* Everything here comes from the browser's own instrumentation. Nothing is estimated. */
const pageProbe = (t) => `(async () => {
  const longTasks = [];
  let cls = 0, lcp = null;
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push(e.duration); })
    .observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; })
    .observe({ type: 'layout-shift', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { const e = l.getEntries(); lcp = e[e.length - 1].startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}

  await new Promise(r => setTimeout(r, ${SETTLE_MS}));

  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const paint = performance.getEntriesByType('paint');
  const origin = location.origin;

  const appJs = res.filter(r => r.name.includes('/assets/') && r.name.endsWith('.js'));
  const apiHost = '${t.apiHost}';
  const api = res.filter(r => r.name.includes(apiHost));
  const seen = {};
  for (const r of api) {
    const key = r.name.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '{id}');
    seen[key] = (seen[key] || 0) + 1;
  }
  const hosts = new Set(res.filter(r => !r.name.startsWith(origin)).map(r => { try { return new URL(r.name).hostname; } catch { return 'x'; } }));

  // Deepest scrollable list: the thing most likely to be unvirtualized.
  let deepestList = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100) {
      deepestList = Math.max(deepestList, el.querySelectorAll('*').length);
    }
  }

  return {
    firstContentfulPaintMs: Math.round(paint.find(p => p.name === 'first-contentful-paint')?.startTime ?? -1),
    largestContentfulPaintMs: lcp === null ? -1 : Math.round(lcp),
    ttfbMs: Math.round((nav.responseStart ?? 0) - (nav.requestStart ?? 0)),
    domInteractiveMs: Math.round(nav.domInteractive ?? -1),
    mainThreadBlockedMs: Math.round(longTasks.reduce((s, d) => s + d, 0)),
    longTaskCount: longTasks.length,
    cumulativeLayoutShift: Math.round(cls * 1000) / 1000,
    appJsDecodedKB: Math.round(appJs.reduce((s, r) => s + (r.decodedBodySize || 0), 0) / 1024),
    requestCount: res.length,
    apiCallsPerLoad: api.length,
    distinctApiEndpoints: Object.keys(seen).length,
    duplicateApiCalls: Object.values(seen).reduce((s, n) => s + (n > 1 ? n - 1 : 0), 0),
    thirdPartyHosts: hosts.size,
    domNodes: document.querySelectorAll('*').length,
    deepestListNodes: deepestList,
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    onLoginScreen: new RegExp(${JSON.stringify(t.loginPattern)}, 'i').test(document.body.innerText.slice(0, 400)),
  };
})()`;

/* Data fingerprint: the drift guard. Uses the app's own Firebase token, the same way the audit did. */
const fingerprintProbe = (t) => `(async () => {
  const token = await (async () => {
    try {
      const dbs = await indexedDB.databases();
      const fb = dbs.find(d => d.name && d.name.includes('firebaseLocalStorage'));
      if (!fb) return null;
      return await new Promise(res => {
        const req = indexedDB.open(fb.name);
        req.onsuccess = () => {
          const tx = req.result.transaction('firebaseLocalStorage', 'readonly');
          const all = tx.objectStore('firebaseLocalStorage').getAll();
          all.onsuccess = () => res(all.result.find(r => r.value?.stsTokenManager?.accessToken)?.value?.stsTokenManager?.accessToken ?? null);
          all.onerror = () => res(null);
        };
        req.onerror = () => res(null);
      });
    } catch { return null; }
  })();
  if (!token) return { ok: false, reason: 'no session token' };
  const get = async (path) => {
    const r = await fetch(${JSON.stringify(t.fingerprint?.apiBase ?? '')} + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return Array.isArray(j) ? j.length : (Array.isArray(j?.items) ? j.items.length : null);
  };
  const counts = {};
  for (const ep of ${JSON.stringify(t.fingerprint?.endpoints ?? [])}) counts[ep.key] = await get(ep.path);
  return { ok: true, counts };
})()`;

/* ------------------------------------------------------------------ helpers */
function sh(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', stdio: 'pipe' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function median(xs) {
  const v = xs.filter(x => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const range = (xs) => {
  const v = xs.filter(x => typeof x === 'number' && x >= 0);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
};

/** Overlapping min/max ranges mean the difference is not distinguishable from noise. */
function overlaps(a, b) {
  const ra = range(a), rb = range(b);
  if (!ra || !rb) return true;
  return ra.min <= rb.max && rb.min <= ra.max;
}

function measureDist(dir) {
  const assets = join(dir, 'assets');
  if (!existsSync(assets)) return { entryChunkBytes: null, totalJsBytes: null, chunks: [] };
  const chunks = readdirSync(assets)
    .filter(f => f.endsWith('.js'))
    .map(f => ({ file: f, bytes: statSync(join(assets, f)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    entryChunkBytes: chunks[0]?.bytes ?? null,
    totalJsBytes: chunks.reduce((s, c) => s + c.bytes, 0),
    chunkCount: chunks.length,
    chunks: chunks.slice(0, 15),
  };
}

function serve(dir) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = join(dir, url === '/' ? 'index.html' : url);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html'); // SPA fallback
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function openBrowser(headless) {
  mkdirSync(PROFILE, { recursive: true });
  return chromium.launchPersistentContext(PROFILE, {
    headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/** One sample. cold clears HTTP cache + service workers first so "cold" means something. */
async function sample(ctx, url, cold, throttle, t) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (cold) {
    await cdp.send('Network.clearBrowserCache');
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations().catch(() => [])) await r.unregister();
      for (const k of await caches.keys().catch(() => [])) await caches.delete(k);
    }).catch(() => {});
    await cdp.send('Network.clearBrowserCache');
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

  await page.goto(url, { waitUntil: 'commit' });
  let data = null;
  try { data = await page.evaluate(pageProbe(t)); } catch (e) { data = null; }
  if (!data) data = { onLoginScreen: false, probeFailed: String(1) };
  let fp = null;
  if (t.fingerprint?.authSource === 'firebase-indexeddb') {
    try { fp = await page.evaluate(fingerprintProbe(t)); } catch { fp = { ok: false, reason: 'eval failed' }; }
  } else { fp = { ok: false, reason: 'no fingerprint configured for this target' }; }
  await page.close().catch(() => {});
  return { data, fp };
}

async function measureSide(name, url, headless, throttle, t) {
  const ctx = await openBrowser(headless);
  const cold = [], warm = [];
  let fingerprint = null, loginSeen = false;
  try {
    for (let i = 0; i < SAMPLES; i++) {
      const c = await sample(ctx, url, true, throttle, t);
      cold.push(c.data);
      // Fail on the FIRST sample rather than burning all ten against a login screen.
      if (c.data.onLoginScreen) {
        loginSeen = true;
        // Bail immediately on an unintended login screen rather than burning ten samples.
        // When signed-out is the deliberate target, keep sampling normally.
        if (!has('allow-signed-out')) break;
      }
      if (!fingerprint && c.fp?.ok) fingerprint = c.fp;
      process.stdout.write(`\r  ${name}: cold ${i + 1}/${SAMPLES}   `);
    }
    for (let i = 0; i < SAMPLES; i++) {
      warm.push((await sample(ctx, url, false, throttle, t)).data);
      process.stdout.write(`\r  ${name}: warm ${i + 1}/${SAMPLES}   `);
    }
  } finally { await ctx.close().catch(() => {}); }
  process.stdout.write('\r');
  if (loginSeen && !has('allow-signed-out')) {
    die(`landed on the login screen while measuring ${name}.
` +
        `  The perf-proof session is missing or expired. Fix it with:
` +
        `    node ${join(import.meta.dirname ?? '.', 'run.mjs')} login
` +
        `  Or pass --allow-signed-out if you meant to measure the signed-out page.`);
  }
  return { cold, warm, fingerprint };
}

function buildRef(dir, skip, t) {
  const app = join(dir, ...t.appPath.split('/'));
  const dist = join(app, t.distPath || 'dist');
  if (skip && existsSync(dist)) { log(`  reusing existing dist/ in ${dir}`); return dist; }
  if (!existsSync(join(dir, 'node_modules'))) die(`${dir} has no node_modules. Run npm install there first, or pass --skip-build with a prebuilt dist/.`);
  log(`  building ${dir} ...`);
  const r = sh(t.buildCommand || 'npm run build', app);
  if (r.code !== 0) die(`build failed in ${dir}\n${r.out.split('\n').slice(-25).join('\n')}`);
  if (!existsSync(dist)) die(`build produced no dist/ in ${app}`);
  return dist;
}

const gitSha = (dir) => sh('git rev-parse --short HEAD', dir).out.trim();
const gitBranch = (dir) => sh('git rev-parse --abbrev-ref HEAD', dir).out.trim();

function collapse(samples) {
  const out = {};
  for (const key of Object.keys(samples[0] || {})) {
    if (typeof samples[0][key] !== 'number') continue;
    out[key] = { median: median(samples.map(s => s[key])), samples: samples.map(s => s[key]) };
  }
  return out;
}

/* ------------------------------------------------------------------ commands */
async function cmdLogin() {
  const t = loadTarget();
  const url = flag('url') || t.loginUrl || die(`target "${t._name}" has no loginUrl; pass --url`);
  log(`\nOpening a browser at ${url}. Log in, then close the window.\n`);
  const ctx = await openBrowser(false);
  const page = await ctx.newPage();
  await page.goto(url);
  await new Promise(r => ctx.on('close', r));
  log('Session saved to ' + PROFILE + '\n');
}

async function cmdProbe() {
  const t = loadTarget();
  const url = flag('url') || die('probe needs --url');
  const label = flag('label', 'probe');
  log(`\nprobe ${url}  (target: ${t._name})\n`);
  const side = await measureSide('probe', url, !has('headed'), Number(flag('throttle', 1)), t);
  const rec = {
    kind: 'probe', label, url, target: t._name, capturedAt: new Date().toISOString(),
    env: { host: hostname(), cpus: cpus().length, node: process.version },
    fingerprint: side.fingerprint,
    cold: collapse(side.cold), warm: collapse(side.warm),
  };
  const path = writeRecord(label, rec);
  for (const [m] of METRICS) {
    const v = rec.cold[m]?.median;
    if (v != null) log(`  ${m.padEnd(28)} ${String(v).padStart(12)}`);
  }
  log(`\n  no verdict: a single side proves nothing.\n  raw: ${path}\n`);
}

function writeRecord(label, rec) {
  mkdirSync(RUNS, { recursive: true });
  const path = join(RUNS, `${label}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`);
  writeFileSync(path, JSON.stringify(rec, null, 2));
  return path;
}

async function cmdCompare() {
  const t = loadTarget();
  const baseDir = resolve(flag('base-dir') || die('need --base-dir'));
  const headDir = resolve(flag('head-dir') || die('need --head-dir'));
  const label = flag('label', 'compare');
  const route = flag('route') || t.defaultRoute || '/';
  const throttle = Number(flag('throttle', 1));
  const skip = has('skip-build');

  log(`\nperf-proof compare: ${label}`);
  log(`  base ${baseDir} (${gitBranch(baseDir)} ${gitSha(baseDir)})`);
  log(`  head ${headDir} (${gitBranch(headDir)} ${gitSha(headDir)})\n`);

  const baseDist = buildRef(baseDir, skip, t);
  const headDist = buildRef(headDir, skip, t);
  const baseBundle = measureDist(baseDist);
  const headBundle = measureDist(headDist);

  const b = await serve(baseDist);
  const baseSide = await measureSide('base', `http://127.0.0.1:${b.port}${route}`, !has('headed'), throttle, t);
  b.server.close();

  const h = await serve(headDist);
  const headSide = await measureSide('head', `http://127.0.0.1:${h.port}${route}`, !has('headed'), throttle, t);
  h.server.close();

  const rec = {
    kind: 'compare', label, target: t._name, route, samples: SAMPLES, throttle,
    capturedAt: new Date().toISOString(),
    env: { host: hostname(), cpus: cpus().length, node: process.version },
    base: { dir: baseDir, branch: gitBranch(baseDir), sha: gitSha(baseDir), bundle: baseBundle,
      fingerprint: baseSide.fingerprint, cold: collapse(baseSide.cold), warm: collapse(baseSide.warm) },
    head: { dir: headDir, branch: gitBranch(headDir), sha: gitSha(headDir), bundle: headBundle,
      fingerprint: headSide.fingerprint, cold: collapse(headSide.cold), warm: collapse(headSide.warm) },
  };

  // ---- drift guard -------------------------------------------------------
  const bf = baseSide.fingerprint, hf = headSide.fingerprint;
  const fpStr = (f) => f?.ok ? Object.entries(f.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(' / ') : '(none)';
  const drifted = bf?.ok && hf?.ok && JSON.stringify(bf.counts) !== JSON.stringify(hf.counts);
  const noFp = !bf?.ok || !hf?.ok;

  const rows = [];
  for (const [metric] of METRICS) {
    const bv = metric in baseBundle ? baseBundle[metric] : rec.base.cold[metric]?.median;
    const hv = metric in headBundle ? headBundle[metric] : rec.head.cold[metric]?.median;
    if (bv == null || hv == null) continue;
    const bs = metric in baseBundle ? [bv] : rec.base.cold[metric].samples;
    const hs = metric in headBundle ? [hv] : rec.head.cold[metric].samples;
    const delta = bv === 0 ? 0 : ((hv - bv) / bv) * 100;
    let verdict = 'unchanged';
    if (!overlaps(bs, hs) && Math.abs(delta) >= 1) verdict = hv < bv ? 'IMPROVED' : 'REGRESSED';
    rows.push({ metric, base: bv, head: hv, deltaPct: Math.round(delta * 10) / 10, verdict });
  }

  const regressions = rows.filter(r => r.verdict === 'REGRESSED');
  rec.comparison = rows;
  rec.verdict = drifted ? 'VOID' : noFp ? 'UNVERIFIED' : regressions.length ? 'FAIL' : 'PASS';
  rec.regressions = regressions.map(r => r.metric);
  const path = writeRecord(label, rec);

  // ---- report ------------------------------------------------------------
  log(`\n${label}   base ${rec.base.sha} -> head ${rec.head.sha}\n`);
  log(`  ${'metric'.padEnd(28)}${'base'.padStart(14)}${'head'.padStart(14)}${'delta'.padStart(10)}   verdict`);
  for (const r of rows) {
    log(`  ${r.metric.padEnd(28)}${String(r.base).padStart(14)}${String(r.head).padStart(14)}` +
        `${(r.deltaPct > 0 ? '+' : '') + r.deltaPct + '%'}`.padStart(10) + `   ${r.verdict}`);
  }
  log('');
  if (drifted) {
    log(`  VERDICT: VOID - account data changed between sides`);
    log(`    base ${fpStr(bf)}`);
    log(`    head ${fpStr(hf)}`);
    log(`  These numbers are not comparable. Re-run both sides together.`);
  } else if (noFp) {
    log(`  VERDICT: UNVERIFIED - could not read the data fingerprint on both sides.`);
    log(`  The numbers may be signed-out or against drifted data. Treat as indicative only.`);
  } else if (regressions.length) {
    log(`  VERDICT: FAIL - ${regressions.length} regression(s): ${regressions.map(r => r.metric).join(', ')}`);
    log(`  data fingerprint matched: ${fpStr(bf)}`);
  } else {
    log(`  VERDICT: PASS - no regression`);
    log(`  data fingerprint matched: ${bf.channels} channels / ${bf.entities} entities`);
  }
  log(`\n  ${SAMPLES} samples per condition, cold-cache medians. Local build, no CDN: bundle sizes`);
  log(`  transfer to production, latency numbers do not.`);
  log(`  raw: ${path}\n`);

  process.exit(rec.verdict === 'FAIL' || rec.verdict === 'VOID' ? 1 : 0);
}

const COMMANDS = { login: cmdLogin, compare: cmdCompare, probe: cmdProbe };
if (!COMMANDS[cmd]) die(
  [
    'usage (all commands need --target <name>):',
    '  run.mjs login   --target <t>',
    '  run.mjs compare --target <t> --base-dir <d> --head-dir <d> --label <l> [--route /x]',
    '  run.mjs probe   --target <t> --url <u> --label <l> [--allow-signed-out]',
  ].join('\n'));
await COMMANDS[cmd]();
