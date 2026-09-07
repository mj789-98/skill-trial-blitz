'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sim = require('../sim/chickenRun');
const {
  COLS,
  SUB,
  TRACK_SUB,
  HOP_COOLDOWN_TICKS,
  ACT_FORWARD,
  ACT_LEFT,
  ACT_RIGHT,
  ACT_CASH_OUT,
  encodeTrace,
  decodeTrace,
  simulate,
  rowTypeAt,
  laneTraffic,
  bodyPos,
  mulberry32,
} = sim;

/** Walk straight forward, one hop every cooldown, then optionally bank. */
function marchTrace(hops, { cashOut = true } = {}) {
  const events = [];
  let t = HOP_COOLDOWN_TICKS;
  for (let i = 0; i < hops; i++) {
    events.push({ tick: t, action: ACT_FORWARD });
    t += HOP_COOLDOWN_TICKS;
  }
  if (cashOut) events.push({ tick: t, action: ACT_CASH_OUT });
  return encodeTrace(events);
}

// ── Trace codec ─────────────────────────────────────────────────────────────

test('trace round-trips exactly', () => {
  const events = [
    { tick: 6, action: ACT_FORWARD },
    { tick: 12, action: ACT_LEFT },
    { tick: 900, action: ACT_RIGHT },
    { tick: 901, action: ACT_CASH_OUT },
  ];
  assert.deepEqual(decodeTrace(encodeTrace(events)), events);
});

test('decodeTrace rejects malformed input rather than guessing', () => {
  assert.throws(() => decodeTrace(Buffer.from([1, 2]).toString('base64')), /multiple of 3/);
  // action byte 9 is not a defined action
  assert.throws(
    () => decodeTrace(Buffer.from([0, 0, 9]).toString('base64')),
    /unknown action/
  );
  assert.throws(() => decodeTrace(42), /must be a string/);
});

test('encodeTrace rejects out-of-order events', () => {
  assert.throws(
    () => encodeTrace([{ tick: 10, action: ACT_FORWARD }, { tick: 5, action: ACT_FORWARD }]),
    /ordered by tick/
  );
});

// ── Determinism: the property the whole design rests on ─────────────────────

test('replay is deterministic across many seeds and traces', () => {
  const rng = mulberry32(0xfeed);
  for (let i = 0; i < 300; i++) {
    const seed = String(rng() >>> 0);
    const trace = marchTrace(rng() % 40, { cashOut: rng() % 2 === 0 });
    const a = simulate(seed, trace);
    const b = simulate(seed, trace);
    assert.deepEqual(a, b, `non-deterministic at seed ${seed}`);
  }
});

test('a different seed generally produces a different world', () => {
  // Guards against the seed being ignored entirely, which would make replay
  // validation worthless while still looking deterministic.
  const trace = marchTrace(30);
  const outcomes = new Set();
  for (let s = 1; s <= 40; s++) outcomes.add(JSON.stringify(simulate(String(s), trace)));
  assert.ok(outcomes.size > 1, 'every seed produced an identical outcome');
});

test('no NaN, no fractional values escape the simulation', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const r = simulate(String(rng() >>> 0), marchTrace(rng() % 30));
    for (const k of ['score', 'ticks', 'furthestRow', 'inputs']) {
      assert.ok(Number.isInteger(r[k]), `${k} was not an integer: ${r[k]}`);
      assert.ok(r[k] >= 0);
    }
  }
});

// ── Scoring rules from the brief ────────────────────────────────────────────

test('you score 0 if you die', () => {
  const rng = mulberry32(99);
  let deaths = 0;
  for (let i = 0; i < 400 && deaths < 20; i++) {
    // March a long way with no cash-out; most runs end badly.
    const r = simulate(String(rng() >>> 0), marchTrace(60, { cashOut: false }));
    if (r.reason === 'death' || r.reason === 'idle') {
      deaths++;
      assert.equal(r.score, 0, 'a death paid out a score');
      assert.ok(r.furthestRow >= 0);
    }
  }
  assert.ok(deaths > 0, 'no deaths occurred; the hazard model may be inert');
});

test('an abandoned run does not bank a score', () => {
  // Silence is not a cash-out. If it were, a player could take a risk-free exit
  // by killing the app, and the sweeper would pay them for it.
  const r = simulate('12345', marchTrace(3, { cashOut: false }));
  assert.equal(r.reason, 'aborted');
  assert.equal(r.score, 0);
});

test('cashing out banks the furthest row reached', () => {
  const rng = mulberry32(2024);
  let banked = 0;
  for (let i = 0; i < 300 && banked < 25; i++) {
    const r = simulate(String(rng() >>> 0), marchTrace(2 + (rng() % 5)));
    if (r.reason === 'cash_out') {
      banked++;
      // Banking always pays exactly the furthest row reached — including 0, for a
      // run whose every forward hop was refused by an obstacle. That is correct:
      // cashing out having advanced nowhere is worth nothing.
      assert.equal(r.score, r.furthestRow);
    }
  }
  assert.ok(banked > 0, 'no run ever survived to cash out');
});

test('score is monotonic: retreating never reduces it', () => {
  const events = [];
  let t = HOP_COOLDOWN_TICKS;
  for (let i = 0; i < 3; i++) {
    events.push({ tick: t, action: ACT_FORWARD });
    t += HOP_COOLDOWN_TICKS;
  }
  // Shuffle sideways, which cannot advance the score but must not cut it.
  for (let i = 0; i < 4; i++) {
    events.push({ tick: t, action: i % 2 ? ACT_LEFT : ACT_RIGHT });
    t += HOP_COOLDOWN_TICKS;
  }
  events.push({ tick: t, action: ACT_CASH_OUT });

  const r = simulate('777', encodeTrace(events));
  if (r.reason === 'cash_out') assert.ok(r.score >= 1);
  assert.ok(r.furthestRow <= 3, 'sideways hops advanced the score');
});

// ── Input rate limiting ─────────────────────────────────────────────────────

test('inputs faster than the cooldown are ignored', () => {
  // A scripted client hammering every tick must not out-run a hand.
  const spam = [];
  for (let t = 0; t < 120; t++) spam.push({ tick: t, action: ACT_FORWARD });
  const fast = simulate('4242', encodeTrace(spam));

  const legit = simulate('4242', marchTrace(120 / HOP_COOLDOWN_TICKS, { cashOut: false }));
  assert.ok(
    fast.furthestRow <= legit.furthestRow + 1,
    `rate limit leaked: spam reached ${fast.furthestRow} vs ${legit.furthestRow}`
  );
});

// ── World generation ────────────────────────────────────────────────────────

test('the first rows are always safe grass', () => {
  for (let s = 1; s <= 50; s++) {
    for (let row = 0; row <= 2; row++) {
      assert.equal(rowTypeAt(sim.parseSeed(String(s)), row), sim.ROW_GRASS);
    }
  }
});

test('row 0 is never blocked, so a run always has somewhere to stand', () => {
  for (let s = 1; s <= 50; s++) {
    assert.equal(sim.grassObstacleMask(sim.parseSeed(String(s)), 0), 0);
  }
});

test('a grass row can never wall the player in', () => {
  for (let s = 1; s <= 200; s++) {
    const seed = sim.parseSeed(String(s));
    for (let row = 3; row < 60; row++) {
      if (rowTypeAt(seed, row) !== sim.ROW_GRASS) continue;
      const mask = sim.grassObstacleMask(seed, row);
      let blocked = 0;
      for (let c = 0; c < COLS; c++) if (mask & (1 << c)) blocked++;
      assert.ok(blocked <= COLS - 2, `row ${row} blocked ${blocked}/${COLS} columns`);
    }
  }
});

test('all four row types occur, and the mix hardens with depth', () => {
  const near = { grass: 0, road: 0, rail: 0, river: 0 };
  const far = { grass: 0, road: 0, rail: 0, river: 0 };
  const names = ['grass', 'road', 'rail', 'river'];
  for (let s = 1; s <= 300; s++) {
    const seed = sim.parseSeed(String(s));
    for (let row = 3; row < 25; row++) near[names[rowTypeAt(seed, row)]]++;
    for (let row = 100; row < 122; row++) far[names[rowTypeAt(seed, row)]]++;
  }
  for (const n of names) {
    assert.ok(near[n] > 0, `row type ${n} never appeared near the start`);
    assert.ok(far[n] > 0, `row type ${n} never appeared deep`);
  }
  assert.ok(far.grass < near.grass, 'grass did not thin out with depth');
  assert.ok(far.river > near.river, 'rivers did not become more common with depth');
});

test('lane bodies stay on the track and wrap cleanly', () => {
  for (let s = 1; s <= 60; s++) {
    const seed = sim.parseSeed(String(s));
    for (let row = 3; row < 40; row++) {
      const kind = rowTypeAt(seed, row);
      if (kind !== sim.ROW_ROAD && kind !== sim.ROW_RIVER) continue;
      const lane = laneTraffic(seed, row, kind);
      assert.ok(lane.count >= 2);
      assert.ok(lane.speed > 0);
      for (let t = 0; t < 400; t += 7) {
        for (let i = 0; i < lane.count; i++) {
          const p = bodyPos(lane, i, t);
          assert.ok(Number.isInteger(p), 'lane position was fractional');
          assert.ok(p >= 0 && p < TRACK_SUB, `lane position ${p} left the track`);
        }
      }
    }
  }
});

test('a river row always has somewhere to land', () => {
  // Logs must not be so sparse that a river is unsurvivable regardless of skill.
  for (let s = 1; s <= 120; s++) {
    const seed = sim.parseSeed(String(s));
    for (let row = 3; row < 60; row++) {
      if (rowTypeAt(seed, row) !== sim.ROW_RIVER) continue;
      const lane = laneTraffic(seed, row, sim.ROW_RIVER);
      const covered = lane.count * lane.lengthSub;
      assert.ok(
        covered >= SUB,
        `river row ${row} on seed ${s} has under one cell of log`
      );
    }
  }
});

test('a train is always announced before it arrives', () => {
  // Dying to a hazard you could not read is unfair; the signal must lead it.
  for (let s = 1; s <= 80; s++) {
    const seed = sim.parseSeed(String(s));
    for (let row = 3; row < 40; row++) {
      if (rowTypeAt(seed, row) !== sim.ROW_RAIL) continue;
      const sched = sim.railSchedule(seed, row);
      assert.ok(sched.periodTicks > sched.occupyTicks + sched.warnTicks);
      for (let t = 0; t < sched.periodTicks * 3; t++) {
        if (sim.trainPresent(sched, t)) {
          assert.ok(sim.trainWarning(sched, t), 'train present with no warning');
          // The warning must have been up for a while beforehand.
          assert.ok(
            sim.trainWarning(sched, t - 1) || t === 0,
            'train arrived without a lead-in'
          );
        }
      }
    }
  }
});
