'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  emptyProfile,
  percentile,
  resolveTarget,
  applyBounds,
  buildQuote,
  consumeBootstrap,
  advanceProfile,
} = require('../engine/targetEngine');
const { multiplierBpForScore, ONE_X_BP } = require('../engine/curve');

/** The shipping config, in the shape blitz_configs.params stores. */
const PARAMS = {
  cold_start: {
    seed_target: 12,
    bootstrap_rounds: 3,
    bootstrap_cap_multiplier: 1.5,
    bootstrap_max_stake_cents: 100,
  },
  ratchet: {
    percentile: 0.7,
    up_alpha: 0.45,
    down_alpha: 0.08,
    max_up_step: 4,
    max_down_step: 2,
  },
  curve: {
    shape: [
      { rel: 0.0, mult: 0.0 },
      { rel: 0.55, mult: 0.2 },
      { rel: 1.0, mult: 1.0 },
      { rel: 1.35, mult: 2.0 },
      { rel: 1.65, mult: 2.5 },
      { rel: 2.0, mult: 3.0 },
    ],
    cap_multiplier: 3.0,
  },
  ceiling_guard: {
    pb_window: 20,
    max_target_vs_pb: 0.92,
    min_target_vs_pb: 0.45,
    floor_percentile: 0.9,
    idle_decay_per_day: 0.04,
  },
  min_target: 5,
  quote_ttl_seconds: 180,
  stake_tiers_cents: [100, 300, 500, 1000, 2000],
};

const NOW = new Date('2026-09-07T12:00:00Z');

/** A profile that has finished bootstrap and has the given history. */
function seasoned(scores, targetScore = 20) {
  return {
    ...emptyProfile('p1', 'chicken_run', PARAMS),
    rounds_played: scores.length,
    bootstrap_used: PARAMS.cold_start.bootstrap_rounds,
    target_score: targetScore,
    best_score: scores.length ? Math.max(...scores) : null,
    recent_scores: scores,
    last_played_at: NOW.toISOString(),
  };
}

// ── Percentile helper ───────────────────────────────────────────────────────

test('percentile uses nearest rank and returns an actual observation', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 0.7), 7);
  assert.equal(percentile(v, 1.0), 10);
  assert.equal(percentile(v, 0.01), 1);
  assert.equal(percentile([], 0.7), null);
});

// ── Cold start ──────────────────────────────────────────────────────────────

test('a new player gets the seed target on capped starter terms', () => {
  const p = emptyProfile('new', 'chicken_run', PARAMS);
  const r = resolveTarget(p, PARAMS, NOW);
  assert.equal(r.bootstrap, true);
  assert.equal(r.targetScore, 12);
  assert.equal(r.capMultiplier, 1.5);
  assert.equal(r.maxStakeCents, 100);
});

test('bootstrap refuses a stake above its limit', () => {
  const p = emptyProfile('new', 'chicken_run', PARAMS);
  assert.throws(
    () => buildQuote(p, PARAMS, { stakeCents: 2000, now: NOW }),
    (e) => e.code === 'STAKE_ABOVE_BOOTSTRAP_LIMIT'
  );
  assert.doesNotThrow(() => buildQuote(p, PARAMS, { stakeCents: 100, now: NOW }));
});

test('the bootstrap cap really binds the curve a new player is shown', () => {
  const q = buildQuote(emptyProfile('new', 'chicken_run', PARAMS), PARAMS, {
    stakeCents: 100,
    now: NOW,
  });
  assert.ok(multiplierBpForScore(q.curve, 100_000) <= 15000);
});

test('bootstrap is a lifetime allowance, consumed at entry not at settlement', () => {
  // The anti-farm: a player must not be able to spend the friendly starter
  // rounds, abandon the bad ones, and still hold the allowance.
  let p = emptyProfile('new', 'chicken_run', PARAMS);
  for (let i = 0; i < 3; i++) {
    assert.equal(resolveTarget(p, PARAMS, NOW).bootstrap, true);
    p = { ...p, bootstrap_used: consumeBootstrap(p, PARAMS) };
  }
  assert.equal(resolveTarget(p, PARAMS, NOW).bootstrap, false);

  // Settling many rounds afterwards never restores it.
  for (let i = 0; i < 10; i++) p = advanceProfile(p, 5, PARAMS, NOW);
  assert.equal(resolveTarget(p, PARAMS, NOW).bootstrap, false);
  assert.equal(consumeBootstrap(p, PARAMS), 3);
});

// ── The ratchet ─────────────────────────────────────────────────────────────

test('targets rise faster than they fall', () => {
  // The asymmetry is the mode. Same size gap, opposite directions.
  //
  // Both histories carry a PB of 40 so neither the ceiling (0.92*40 = 36.8) nor
  // the PB floor (0.45*40 = 18) binds; this test is about the ratchet alone.
  // p70 of a 20-long window is the 14th value ascending, which is what the
  // mixes below are built to place.
  const upHist = [...Array(6).fill(10), ...Array(8).fill(30), ...Array(6).fill(40)];
  const downHist = [...Array(14).fill(10), ...Array(6).fill(40)];
  const up = advanceProfile(seasoned(upHist, 20), 30, PARAMS, NOW);
  const down = advanceProfile(seasoned(downHist, 20), 10, PARAMS, NOW);
  const rise = up.target_score - 20;
  const fall = 20 - down.target_score;
  assert.ok(rise > 0, 'target did not rise on good play');
  assert.ok(fall > 0, 'target did not fall on bad play');
  assert.ok(rise > fall, `rise ${rise} should exceed fall ${fall}`);
});

test('a single lucky run cannot spike the target out of reach', () => {
  const p = seasoned([9, 10, 11, 10, 9, 10, 11, 10, 9, 10], 10);
  const next = advanceProfile(p, 400, PARAMS, NOW);
  assert.ok(
    next.target_score - p.target_score <= PARAMS.ratchet.max_up_step,
    `target jumped by ${next.target_score - p.target_score}`
  );
});

test('the ratchet reads a percentile, so early cash-outs do not farm it down', () => {
  // THE Cash Out wrinkle. A player who can reach ~30 but banks at 3 most rounds
  // must not walk their target down to 3.
  let farmer = seasoned([30, 30, 30, 30, 30, 30], 25);
  for (let i = 0; i < 40; i++) {
    // Reaches 30 one round in four, deliberately banks 3 the rest.
    farmer = advanceProfile(farmer, i % 4 === 0 ? 30 : 3, PARAMS, NOW);
  }
  assert.ok(
    farmer.target_score >= 10,
    `farming walked the target down to ${farmer.target_score}`
  );

  // A mean-based ratchet would have landed near 10 ((30+3+3+3)/4). The
  // percentile keeps it meaningfully above that.
  const meanOfPattern = (30 + 3 + 3 + 3) / 4;
  assert.ok(farmer.target_score > meanOfPattern);
});

// ── The ceiling problem ─────────────────────────────────────────────────────

test('break-even can never be pushed past the player physical maximum', () => {
  // The answer to design question 1: a ratchet that only goes up eventually
  // prices everyone out of their own game. The guard forbids it.
  let p = seasoned(Array(20).fill(25), 25);
  for (let i = 0; i < 200; i++) p = advanceProfile(p, 25, PARAMS, NOW);

  const pb = Math.max(...p.recent_scores);
  assert.ok(
    p.target_score <= pb * PARAMS.ceiling_guard.max_target_vs_pb + 1,
    `target ${p.target_score} exceeded the guard against PB ${pb}`
  );
});

test('a consistent player keeps a reachable break-even indefinitely', () => {
  // The practical statement of the same thing: 200 rounds of steady play must
  // not end with a target the player cannot hit.
  let p = seasoned(Array(20).fill(25), 20);
  for (let i = 0; i < 200; i++) p = advanceProfile(p, 25, PARAMS, NOW);

  const q = buildQuote(p, PARAMS, { stakeCents: 300, now: NOW });
  assert.ok(
    q.curve.breakEvenScore <= 25,
    `break-even drifted to ${q.curve.breakEvenScore}, above what the player ever scores`
  );
  assert.ok(multiplierBpForScore(q.curve, 25) >= ONE_X_BP);
});

test('the ceiling guard beats the min_target floor when they conflict', () => {
  // A weak player's PB sits below the floor. The floor protects revenue; the
  // ceiling stops the mode selling a round that cannot be won. The ceiling wins.
  const weak = seasoned([3, 4, 3, 2, 4, 3], 20);
  const bounded = applyBounds(20, weak, PARAMS);
  const pb = 4;
  assert.ok(
    bounded.target <= Math.round(pb * PARAMS.ceiling_guard.max_target_vs_pb) + 1,
    `floor overrode the ceiling: target ${bounded.target} vs PB ${pb}`
  );
  assert.ok(bounded.target < PARAMS.min_target);
});

test('the floor still applies to a player with no demonstrated ceiling', () => {
  const fresh = { ...seasoned([], 1), recent_scores: [] };
  assert.equal(applyBounds(1, fresh, PARAMS).target, PARAMS.min_target);
});

// ── Decay, bounds, purity ───────────────────────────────────────────────────

test('time away decays the target', () => {
  const p = seasoned(Array(20).fill(40), 30);
  const fresh = resolveTarget(p, PARAMS, NOW).targetScore;
  const later = resolveTarget(p, PARAMS, new Date('2026-10-07T12:00:00Z')).targetScore;
  assert.ok(later < fresh, `30 days away did not decay the target (${fresh} -> ${later})`);
});

test('the target never goes below 1, so a curve can always materialise', () => {
  let p = seasoned([0, 0, 0, 0, 0, 0], 5);
  for (let i = 0; i < 100; i++) p = advanceProfile(p, 0, PARAMS, NOW);
  assert.ok(p.target_score >= 1);
  assert.doesNotThrow(() => buildQuote(p, PARAMS, { stakeCents: 100, now: NOW }));
});

test('advanceProfile does not mutate the profile it is given', () => {
  const p = seasoned([10, 12, 11], 15);
  const snapshot = JSON.parse(JSON.stringify(p));
  advanceProfile(p, 40, PARAMS, NOW);
  assert.deepEqual(p, snapshot);
});

test('the recent-score window stays bounded', () => {
  let p = seasoned([], 12);
  for (let i = 0; i < 200; i++) p = advanceProfile(p, i % 30, PARAMS, NOW);
  assert.equal(p.recent_scores.length, PARAMS.ceiling_guard.pb_window);
  assert.equal(p.rounds_played, 200);
});

test('advanceProfile rejects a non-integer score', () => {
  assert.throws(() => advanceProfile(seasoned([]), 12.5, PARAMS, NOW), /non-negative integer/);
  assert.throws(() => advanceProfile(seasoned([]), -1, PARAMS, NOW), /non-negative integer/);
});

test('a quote records why the player got the target they got', () => {
  // profile_snapshot.reasons is what makes a curve explainable months later.
  const p = seasoned(Array(20).fill(8), 40);
  const q = buildQuote(p, PARAMS, { stakeCents: 300, now: NOW });
  assert.ok(Array.isArray(q.profileSnapshot.reasons));
  assert.ok(
    q.profileSnapshot.reasons.some((r) => /ceiling guard/.test(r)),
    `expected a ceiling-guard reason, got ${JSON.stringify(q.profileSnapshot.reasons)}`
  );
  assert.equal(q.profileSnapshot.resolved_target, q.targetScore);
});

test('a partial config still produces a usable quote', () => {
  // Config is edited by hand in a JSONB column; a missing key must not 500 a
  // player mid-session.
  const partial = { curve: PARAMS.curve, cold_start: { bootstrap_rounds: 0 } };
  const q = buildQuote(seasoned([15, 18, 20], 18), partial, { stakeCents: 300, now: NOW });
  assert.ok(q.curve.breakEvenScore >= 1);
});
