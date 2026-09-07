/**
 * The payout curve: score → multiplier → cents.
 *
 * ── Why multipliers are integers ─────────────────────────────────────────────
 *
 * Multipliers are stored and interpolated as integer BASIS POINTS, where
 * 10000 bp = 1.00x. They are never floats.
 *
 * The brief's rule is "no floating point anywhere in a balance, stake or
 * payout". A multiplier is not itself money, but it is the last operand before
 * money, and `Math.floor(300 * 2.5)` is only safe until the day the curve says
 * something like 1.1x and the binary representation lands a hair under. Keeping
 * the whole chain in integers means the payout is a function of exact integer
 * arithmetic from end to end, and two different machines cannot disagree about
 * a cent. Every value here is well inside 2^53, so integer maths is exact.
 *
 * `x` values are only ever produced for display (`bpToX`), never consumed.
 *
 * ── Why a materialised curve ─────────────────────────────────────────────────
 *
 * Config defines the curve shape in RELATIVE space — score ÷ target — so one
 * shape serves every stake tier and every player. But a stored curve is
 * ABSOLUTE: at quote time the shape is materialised into concrete score
 * breakpoints against that player's target.
 *
 * That is what makes "the curve shown pre-entry is the curve paid out on"
 * structurally true rather than a promise. The materialised curve is copied into
 * the round row at entry, and settlement reads only that column: it never sees
 * the config, the shape, the player's target, or the profile. Even if every one
 * of those changed a millisecond after entry, the round cannot notice.
 */

'use strict';

/** 1.00x expressed in basis points. */
const ONE_X_BP = 10000;

/**
 * Materialise a relative curve shape into absolute score breakpoints.
 *
 * @param {Array<{rel: number, mult: number}>} shape  Config shape, ascending by `rel`.
 *   `rel` is score ÷ target (so rel 1.0 is the break-even score); `mult` is the
 *   multiplier in x (config is human-edited, so it is written in x, not bp).
 * @param {number} targetScore  The player's break-even score for this round.
 * @param {number} capMultiplierX  Hard ceiling in x, applied after interpolation.
 * @returns {{points: Array<{score: number, multBp: number}>, breakEvenScore: number, capBp: number}}
 */
function materialiseCurve(shape, targetScore, capMultiplierX) {
  if (!Array.isArray(shape) || shape.length < 2) {
    throw new Error('curve shape must have at least two points');
  }
  if (!Number.isFinite(targetScore) || targetScore <= 0) {
    throw new Error(`targetScore must be positive, got ${targetScore}`);
  }

  const capBp = xToBp(capMultiplierX);

  const points = shape.map((p, i) => {
    if (!Number.isFinite(p.rel) || p.rel < 0) {
      throw new Error(`shape[${i}].rel must be a non-negative number`);
    }
    return {
      // Break-even lands on a whole score, because scores are whole. Rounding
      // rather than flooring keeps the materialised break-even honest to the
      // configured rel rather than always shading in the house's favour.
      score: Math.round(p.rel * targetScore),
      multBp: Math.min(xToBp(p.mult), capBp),
    };
  });

  // Materialising can collapse two nearby rel values onto the same integer score
  // (a low target with closely spaced shape points). Keep the most generous
  // multiplier at each score so the collapse never silently costs the player.
  const byScore = new Map();
  for (const p of points) {
    const prev = byScore.get(p.score);
    if (prev === undefined || p.multBp > prev) byScore.set(p.score, p.multBp);
  }

  const collapsed = [...byScore.entries()]
    .map(([score, multBp]) => ({ score, multBp }))
    .sort((a, b) => a.score - b.score);

  if (collapsed.length < 2) {
    throw new Error(
      `curve collapsed to a single point at targetScore=${targetScore}; ` +
        'the shape is too tightly spaced for a target this small'
    );
  }

  // The multiplier must never decrease as the score rises. A config that says
  // otherwise would mean a player is paid less for playing better, which is a
  // bug worth failing loudly on rather than quietly serving.
  for (let i = 1; i < collapsed.length; i++) {
    if (collapsed[i].multBp < collapsed[i - 1].multBp) {
      throw new Error(
        `curve is not monotonic: score ${collapsed[i].score} pays less than ` +
          `score ${collapsed[i - 1].score}`
      );
    }
  }

  const breakEvenScore = findBreakEvenScore(collapsed);

  // A break-even of 0 means scoring nothing returns the stake, and with the
  // breakpoints that tightly packed the very next score jumps to the cap. That
  // is free money, and it is reachable from a legitimate-looking config: a
  // target below ~1 rounds the low rel values onto score 0. The engine should
  // never hand out such a target, but this is the module that turns a target
  // into money, so it refuses one rather than trusting its caller.
  if (breakEvenScore === null || breakEvenScore < 1) {
    throw new Error(
      `curve break-even resolved to ${breakEvenScore} at targetScore=${targetScore}; ` +
        'a score of 0 must never return the stake'
    );
  }

  return {
    points: collapsed,
    breakEvenScore,
    capBp,
  };
}

/**
 * The multiplier a score earns on a materialised curve, in basis points.
 *
 * Below the first breakpoint the player gets that first point's multiplier;
 * above the last, the last one. Between them, linear interpolation, floored.
 *
 * Flooring means interpolation always resolves in the house's favour by at most
 * one basis point — one ten-thousandth of the stake, which cannot move a cent at
 * any stake in this app's $1–$20 range. It is chosen over rounding only because
 * a single consistent direction is easier to reason about and to test than one
 * that depends on the fractional part.
 *
 * @param {{points: Array<{score: number, multBp: number}>}} curve
 * @param {number} score  Integer score.
 * @returns {number} multiplier in basis points.
 */
function multiplierBpForScore(curve, score) {
  const pts = curve && curve.points;
  if (!Array.isArray(pts) || pts.length === 0) {
    throw new Error('curve has no points');
  }
  if (!Number.isInteger(score) || score < 0) {
    throw new Error(`score must be a non-negative integer, got ${score}`);
  }

  if (score <= pts[0].score) return pts[0].multBp;
  const last = pts[pts.length - 1];
  if (score >= last.score) return last.multBp;

  for (let i = 1; i < pts.length; i++) {
    const hi = pts[i];
    if (score > hi.score) continue;
    const lo = pts[i - 1];
    const span = hi.score - lo.score;
    if (span <= 0) return Math.max(lo.multBp, hi.multBp);
    const rise = hi.multBp - lo.multBp;
    return lo.multBp + Math.floor((rise * (score - lo.score)) / span);
  }

  return last.multBp;
}

/**
 * Payout in whole cents.
 *
 * Floor is the single rounding rule in this codebase, applied here and nowhere
 * else. Sub-cent amounts cannot be paid, so some rule is forced; what matters is
 * that there is exactly one of them, in exactly one place, so no two code paths
 * can ever disagree about what a score is worth.
 *
 * @param {number} stakeCents  Integer cents, positive.
 * @param {number} multBp  Multiplier in basis points.
 * @returns {number} Integer cents, >= 0.
 */
function payoutCents(stakeCents, multBp) {
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    throw new Error(`stakeCents must be a positive integer, got ${stakeCents}`);
  }
  if (!Number.isInteger(multBp) || multBp < 0) {
    throw new Error(`multBp must be a non-negative integer, got ${multBp}`);
  }
  return Math.floor((stakeCents * multBp) / ONE_X_BP);
}

/**
 * The lowest score that returns at least the stake — what the payout screen
 * labels "Break Even".
 *
 * Derived from the materialised points rather than assumed to be the rel-1.0
 * point, so the label on the screen is guaranteed to describe what the curve
 * actually pays. If nothing on the curve reaches 1.00x, this is null and the
 * screen must not claim a break-even exists.
 */
function findBreakEvenScore(points) {
  for (let i = 0; i < points.length; i++) {
    if (points[i].multBp < ONE_X_BP) continue;
    if (i === 0) return points[0].score;

    const lo = points[i - 1];
    const hi = points[i];
    if (lo.multBp === hi.multBp) return hi.score;

    // First integer score on the lo→hi segment that reaches 1.00x.
    const span = hi.score - lo.score;
    const rise = hi.multBp - lo.multBp;
    const needed = ONE_X_BP - lo.multBp;
    const exact = lo.score + (needed * span) / rise;
    const candidate = Math.ceil(exact);

    // Guard against the ceiling landing a basis point short of 1.00x through
    // the floor in multiplierBpForScore.
    const curve = { points };
    return multiplierBpForScore(curve, candidate) >= ONE_X_BP
      ? candidate
      : candidate + 1;
  }
  return null;
}

/** Config is written in x by humans; convert to exact basis points. */
function xToBp(x) {
  if (!Number.isFinite(x) || x < 0) {
    throw new Error(`multiplier must be a non-negative number, got ${x}`);
  }
  return Math.round(x * ONE_X_BP);
}

/** For display only. Never feed the result back into a money calculation. */
function bpToX(bp) {
  return bp / ONE_X_BP;
}

module.exports = {
  ONE_X_BP,
  materialiseCurve,
  multiplierBpForScore,
  payoutCents,
  xToBp,
  bpToX,
};
