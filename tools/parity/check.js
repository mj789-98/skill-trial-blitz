#!/usr/bin/env node
/**
 * The C# ↔ JS determinism cross-check.
 *
 * Why this exists: the server replays a player's input trace through
 * functions/sim/chickenRun.js and pays out on the score IT computes. The client
 * runs the C# port of that simulation. If the two ever disagree, the server
 * silently accuses an honest player of cheating — and the disagreement would
 * show up as a rare, unreproducible complaint rather than a crash.
 *
 * So the agreement is a test, not an assumption.
 *
 * Run:
 *   1. Unity.exe -quit -batchmode -nographics -projectPath unity \
 *        -executeMethod SkillApp.EditorTools.ParityExport.ExportCases
 *   2. node tools/parity/check.js
 *
 * The cases file carries both the inputs and what C# produced for them, so this
 * script is a pure replay: it never regenerates the cases, because a second
 * generator is just a second thing that can drift.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { simulate } = require('../../functions/sim/chickenRun');

const CASES_PATH = path.join(__dirname, 'cases.json');

function main() {
  if (!fs.existsSync(CASES_PATH)) {
    console.error(
      `No cases file at ${CASES_PATH}.\n` +
        'Generate it first with:\n' +
        '  Unity.exe -quit -batchmode -nographics -projectPath unity \\\n' +
        '    -executeMethod SkillApp.EditorTools.ParityExport.ExportCases'
    );
    process.exit(2);
  }

  const { cases } = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error('cases.json contains no cases');
    process.exit(2);
  }

  const failures = [];
  const reasons = new Map();

  for (let i = 0; i < cases.length; i++) {
    const { seed, trace, expected } = cases[i];

    let actual;
    try {
      actual = simulate(seed, trace);
    } catch (err) {
      failures.push({ i, seed, trace, expected, error: err.message });
      continue;
    }

    reasons.set(actual.reason, (reasons.get(actual.reason) || 0) + 1);

    const diff = {};
    for (const key of ['score', 'reason', 'ticks', 'furthestRow', 'inputs']) {
      if (actual[key] !== expected[key]) {
        diff[key] = { csharp: expected[key], js: actual[key] };
      }
    }
    if (Object.keys(diff).length > 0) {
      failures.push({ i, seed, trace, diff });
    }
  }

  // Report the coverage, not just the pass. A run where every case ended the
  // same way would pass this check while testing almost nothing — the point is
  // that deaths, idle-outs, cash-outs and abandoned runs all replay identically.
  console.log(`parity: ${cases.length} cases replayed`);
  console.log(
    '  outcomes: ' +
      [...reasons.entries()]
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
  );

  const distinctOutcomes = reasons.size;
  if (distinctOutcomes < 3) {
    console.warn(
      `  WARNING: only ${distinctOutcomes} distinct outcome(s) exercised; ` +
        'the case generator may not be covering deaths or idle-outs.'
    );
  }

  if (failures.length === 0) {
    console.log('  RESULT: identical. C# and JS agree on every case.');
    process.exit(0);
  }

  console.error(`\n  RESULT: ${failures.length} MISMATCH(ES)\n`);
  for (const f of failures.slice(0, 10)) {
    console.error(`  case ${f.i} seed=${f.seed}`);
    if (f.error) {
      console.error(`    JS threw: ${f.error}`);
    } else {
      for (const [key, v] of Object.entries(f.diff)) {
        console.error(`    ${key}: C#=${JSON.stringify(v.csharp)} JS=${JSON.stringify(v.js)}`);
      }
    }
    console.error(`    trace: ${f.trace}`);
  }
  if (failures.length > 10) {
    console.error(`  ... and ${failures.length - 10} more`);
  }
  process.exit(1);
}

main();
