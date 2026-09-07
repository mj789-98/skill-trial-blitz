'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ONE_X_BP,
  materialiseCurve,
  multiplierBpForScore,
  payoutCents,
} = require('../engine/curve');

/** The shipping shape, in the same form config stores it. */
const SHAPE = [
  { rel: 0.0, mult: 0.0 },
  { rel: 0.55, mult: 0.2 },
  { rel: 1.0, mult: 1.0 },
  { rel: 1.35, mult: 2.0 },
  { rel: 1.65, mult: 2.5 },
  { rel: 2.0, mult: 3.0 },
];

test('materialise: break-even lands on the target score at 1.00x', () => {
  const curve = materialiseCurve(SHAPE, 20, 3.0);
  assert.equal(multiplierBpForScore(curve, 20), ONE_X_BP);
  assert.equal(curve.breakEvenScore, 20);
});

test('materialise: the cap is applied, so no score can exceed it', () => {
  const curve = materialiseCurve(SHAPE, 20, 2.5);
  const top = curve.points[curve.points.length - 1];
  assert.equal(top.multBp, 25000);
  assert.equal(multiplierBpForScore(curve, 10_000), 25000);
});

test('multiplier is monotonic across the whole score range', () => {
  const curve = materialiseCurve(SHAPE, 37, 3.0);
  let prev = -1;
  for (let s = 0; s <= 120; s++) {
    const bp = multiplierBpForScore(curve, s);
    assert.ok(bp >= prev, `multiplier fell at score ${s}: ${bp} < ${prev}`);
    prev = bp;
  }
});

test('multiplier clamps below the first and above the last breakpoint', () => {
  const curve = materialiseCurve(SHAPE, 20, 3.0);
  assert.equal(multiplierBpForScore(curve, 0), curve.points[0].multBp);
  const last = curve.points[curve.points.length - 1];
  assert.equal(multiplierBpForScore(curve, last.score + 500), last.multBp);
});

test('a losing score pays zero, not a negative number', () => {
  const curve = materialiseCurve(SHAPE, 40, 3.0);
  assert.equal(multiplierBpForScore(curve, 0), 0);
  assert.equal(payoutCents(300, multiplierBpForScore(curve, 0)), 0);
});

test('payout is exact integer cents at every stake tier', () => {
  const curve = materialiseCurve(SHAPE, 20, 3.0);
  for (const stake of [100, 300, 500, 1000, 2000]) {
    for (let s = 0; s <= 45; s++) {
      const cents = payoutCents(stake, multiplierBpForScore(curve, s));
      assert.ok(Number.isInteger(cents), `non-integer payout at stake ${stake}, score ${s}`);
      assert.ok(cents >= 0);
      assert.ok(cents <= stake * 3, 'payout exceeded the 3.0x cap');
    }
  }
});

test('break-even actually returns the stake at every tier', () => {
  // The screen labels a score "Break Even"; the player must not lose money on it.
  const curve = materialiseCurve(SHAPE, 23, 3.0);
  for (const stake of [100, 300, 500, 1000, 2000]) {
    const cents = payoutCents(stake, multiplierBpForScore(curve, curve.breakEvenScore));
    assert.ok(cents >= stake, `break-even paid ${cents} on a ${stake} stake`);
  }
});

test('the curve shape is stake-invariant: same score, same multiplier', () => {
  // Stake tiers must not change the shape, only what it is worth. A player
  // learns one curve.
  const curve = materialiseCurve(SHAPE, 20, 3.0);
  for (let s = 0; s <= 40; s++) {
    const bp = multiplierBpForScore(curve, s);
    assert.equal(payoutCents(100, bp), Math.floor((100 * bp) / ONE_X_BP));
    assert.equal(payoutCents(2000, bp), Math.floor((2000 * bp) / ONE_X_BP));
  }
});

test('no floating point creeps into a payout', () => {
  // Guards the reason multipliers are basis points: a float multiplier such as
  // 1.1 cannot represent exactly, and stake * 1.1 can land a hair low.
  const curve = materialiseCurve(
    [
      { rel: 0.0, mult: 0.0 },
      { rel: 1.0, mult: 1.1 },
      { rel: 2.0, mult: 2.2 },
    ],
    10,
    3.0
  );
  assert.equal(multiplierBpForScore(curve, 10), 11000);
  // The float route gives 329.99999999999994 -> floor 329. Integers give 330.
  assert.equal(payoutCents(300, 11000), 330);
});

test('rejects a non-monotonic config rather than serving it', () => {
  assert.throws(
    () =>
      materialiseCurve(
        [
          { rel: 0.0, mult: 0.0 },
          { rel: 1.0, mult: 2.0 },
          { rel: 1.5, mult: 1.0 },
        ],
        20,
        3.0
      ),
    /not monotonic/
  );
});

test('rejects a target too small to have a real break-even', () => {
  // A target below ~1 rounds the low rel points onto score 0, which would mean
  // scoring nothing returns the stake and score 1 pays the cap.
  assert.throws(() => materialiseCurve(SHAPE, 0.4, 3.0), /break-even resolved to 0/);
  assert.throws(() => materialiseCurve(SHAPE, 0, 3.0), /must be positive/);
});

test('scoring zero never returns the stake, across many targets', () => {
  for (let target = 1; target <= 400; target++) {
    const curve = materialiseCurve(SHAPE, target, 3.0);
    assert.ok(curve.breakEvenScore >= 1, `break-even hit 0 at target ${target}`);
    assert.equal(payoutCents(2000, multiplierBpForScore(curve, 0)), 0);
  }
});

test('collapsed breakpoints keep the most generous multiplier', () => {
  // A small target rounds several rel values onto the same integer score.
  const curve = materialiseCurve(SHAPE, 2, 3.0);
  let prev = -1;
  for (const p of curve.points) {
    assert.ok(p.multBp >= prev);
    prev = p.multBp;
  }
  assert.equal(new Set(curve.points.map((p) => p.score)).size, curve.points.length);
});

test('payoutCents rejects nonsense rather than coercing it', () => {
  assert.throws(() => payoutCents(0, ONE_X_BP), /positive integer/);
  assert.throws(() => payoutCents(1.5, ONE_X_BP), /positive integer/);
  assert.throws(() => payoutCents(-100, ONE_X_BP), /positive integer/);
  assert.throws(() => payoutCents(100, -1), /non-negative integer/);
});

test('multiplierBpForScore rejects a non-integer score', () => {
  const curve = materialiseCurve(SHAPE, 20, 3.0);
  assert.throws(() => multiplierBpForScore(curve, 12.5), /non-negative integer/);
  assert.throws(() => multiplierBpForScore(curve, -1), /non-negative integer/);
});
