#!/usr/bin/env node
/**
 * model-fitness: which models actually succeed at which kinds of task.
 *
 *   fitness.mjs record  --model <p/m> --task-type <t> --outcome <o> [--label L] [--notes N]
 *   fitness.mjs report  [--task-type <t>] [--model <p/m>]
 *   fitness.mjs suggest --task-type <t>
 *
 * Ledger: ~/.model-fitness/ledger.jsonl, one JSON object per line, append-only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = join(homedir(), '.model-fitness');
const LEDGER = join(HOME, 'ledger.jsonl');

// fail-infra is deliberately unscored: a flaky endpoint is not a bad model.
const OUTCOMES = {
  'pass':         { score: 1,    scored: true,  label: 'passed' },
  'partial':      { score: 0.5,  scored: true,  label: 'partial' },
  'fail-quality': { score: 0,    scored: true,  label: 'wrong work' },
  'fail-scope':   { score: 0,    scored: true,  label: 'out of scope' },
  'fail-honesty': { score: -1,   scored: true,  label: 'fabricated results' },
  'fail-infra':   { score: null, scored: false, label: 'infra failure (unscored)' },
};

const TASK_TYPES = ['refactor-wide', 'refactor-deep', 'debug', 'implement-feature',
  'analysis', 'test-authoring', 'config-infra', 'ui-visual'];

const MIN_ATTEMPTS = 3;      // below this, a bad run is more likely a bad prompt
const SWAP_BELOW = 0.5;      // success rate under which a swap is warranted
const ALTERNATIVE_MIN = 2;   // never swap into something with less evidence than this

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const die = (m) => { console.error(`\nERROR: ${m}\n`); process.exit(1); };

function load() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { console.error(`  (skipping malformed ledger line ${i + 1})`); return null; }
  }).filter(Boolean);
}

/** Success rate over SCORED attempts only. Returns null when there is no evidence. */
function score(rows) {
  const scored = rows.filter(r => OUTCOMES[r.outcome]?.scored);
  if (!scored.length) return null;
  const total = scored.reduce((s, r) => s + OUTCOMES[r.outcome].score, 0);
  return {
    attempts: scored.length,
    infra: rows.length - scored.length,
    rate: Math.max(0, total) / scored.length,
    honesty: scored.filter(r => r.outcome === 'fail-honesty').length,
  };
}

function group(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
}

const bar = (rate) => {
  const n = Math.round(rate * 20);
  return '#'.repeat(n) + '.'.repeat(20 - n);
};

function cmdRecord() {
  const model = flag('model') || die('need --model');
  const taskType = flag('task-type') || die('need --task-type');
  const outcome = flag('outcome') || die('need --outcome');
  if (!OUTCOMES[outcome]) die(`--outcome must be one of: ${Object.keys(OUTCOMES).join(', ')}`);
  if (!TASK_TYPES.includes(taskType)) {
    console.error(`  note: "${taskType}" is not a known task type. Known: ${TASK_TYPES.join(', ')}`);
    console.error(`  Recording it anyway, but an ad-hoc type never accumulates enough evidence to be useful.\n`);
  }
  const row = {
    at: new Date().toISOString(),
    model, taskType, outcome,
    label: flag('label', null),
    harness: flag('harness', 'omp'),
    notes: flag('notes', null),
  };
  mkdirSync(HOME, { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  console.log(`recorded: ${model} / ${taskType} -> ${outcome} (${OUTCOMES[outcome].label})`);
  if (outcome === 'fail-honesty') {
    console.log(`\n  ! fail-honesty is the most serious outcome. Before re-running, tighten the`);
    console.log(`    prompt's reporting contract so the model cannot present an estimate as a`);
    console.log(`    measurement. Consider this actionable now, not at the 3-attempt threshold.`);
  }
}

function cmdReport() {
  let rows = load();
  if (!rows.length) return console.log('\nledger is empty. Record some lanes first.\n');
  const tFilter = flag('task-type'), mFilter = flag('model');
  if (tFilter) rows = rows.filter(r => r.taskType === tFilter);
  if (mFilter) rows = rows.filter(r => r.model === mFilter);
  if (!rows.length) return console.log('\nno entries match that filter.\n');

  console.log(`\nmodel fitness  (${rows.length} entries)\n`);
  for (const [taskType, tRows] of [...group(rows, 'taskType')].sort()) {
    console.log(`  ${taskType}`);
    const scored = [...group(tRows, 'model')]
      .map(([model, mRows]) => ({ model, ...(score(mRows) || {}) }))
      .filter(s => s.attempts)
      .sort((a, b) => b.rate - a.rate || b.attempts - a.attempts);

    for (const s of scored) {
      const warn = s.attempts >= MIN_ATTEMPTS && s.rate < SWAP_BELOW ? '  <-- below threshold' : '';
      const hon = s.honesty ? `  [${s.honesty} honesty failure${s.honesty > 1 ? 's' : ''}]` : '';
      const infra = s.infra ? `  (+${s.infra} infra)` : '';
      console.log(`    ${bar(s.rate)}  ${(s.rate * 100).toFixed(0).padStart(3)}%  ` +
                  `n=${s.attempts}  ${s.model}${infra}${hon}${warn}`);
    }
    console.log('');
  }

  const flagged = [];
  for (const [taskType, tRows] of group(rows, 'taskType')) {
    const per = [...group(tRows, 'model')].map(([model, mRows]) => ({ model, ...(score(mRows) || {}) }))
      .filter(s => s.attempts);
    const bad = per.filter(s => s.attempts >= MIN_ATTEMPTS && s.rate < SWAP_BELOW);
    for (const b of bad) {
      const alt = per.filter(s => s.model !== b.model && s.attempts >= ALTERNATIVE_MIN && s.rate > b.rate)
        .sort((x, y) => y.rate - x.rate)[0];
      flagged.push({ taskType, bad: b, alt });
    }
  }
  if (flagged.length) {
    console.log('  swap candidates\n');
    for (const f of flagged) {
      console.log(`    ${f.taskType}: ${f.bad.model} at ${(f.bad.rate * 100).toFixed(0)}% over ${f.bad.attempts} attempts`);
      console.log(f.alt
        ? `      -> switch to ${f.alt.model} (${(f.alt.rate * 100).toFixed(0)}%, n=${f.alt.attempts})`
        : `      -> no better-evidenced alternative yet. Try one with >=${ALTERNATIVE_MIN} attempts before swapping.`);
    }
    console.log('');
  }
}

function cmdSuggest() {
  const taskType = flag('task-type') || die('need --task-type');
  const rows = load().filter(r => r.taskType === taskType);
  const per = [...group(rows, 'model')].map(([model, mRows]) => ({ model, ...(score(mRows) || {}) }))
    .filter(s => s.attempts).sort((a, b) => b.rate - a.rate || b.attempts - a.attempts);

  console.log(`\ntask type: ${taskType}\n`);
  if (!per.length) {
    console.log('  No evidence yet. Use the roster hypothesis in SKILL.md and start recording.\n');
    return;
  }
  const best = per[0];
  if (best.attempts < MIN_ATTEMPTS) {
    console.log(`  Best so far: ${best.model} (${(best.rate * 100).toFixed(0)}%, n=${best.attempts})`);
    console.log(`  Not enough evidence to be confident - fewer than ${MIN_ATTEMPTS} scored attempts.`);
    console.log(`  Treat this as a weak prior, not a recommendation.\n`);
    return;
  }
  console.log(`  Use: ${best.model}`);
  console.log(`  ${(best.rate * 100).toFixed(0)}% over ${best.attempts} scored attempts` +
              (best.infra ? ` (+${best.infra} infra failures, excluded)` : ''));
  const runnerUp = per[1];
  if (runnerUp?.attempts >= ALTERNATIVE_MIN) {
    console.log(`  Fallback: ${runnerUp.model} (${(runnerUp.rate * 100).toFixed(0)}%, n=${runnerUp.attempts})`);
  }
  console.log('');
}

const COMMANDS = { record: cmdRecord, report: cmdReport, suggest: cmdSuggest };
if (!COMMANDS[cmd]) die('usage: fitness.mjs record|report|suggest  (see SKILL.md)');
COMMANDS[cmd]();
