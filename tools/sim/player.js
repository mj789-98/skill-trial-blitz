/**
 * Synthetic players.
 *
 * ── A skill number is not enough ─────────────────────────────────────────────
 *
 * The obvious model is "player of skill S scores S on average", and it is wrong
 * for this game in a way that matters. A Blitz score is not how far a player
 * CAN get. It is:
 *
 *     min(how far they get, where they chose to stop)   if they reach that far
 *     0                                                 if they died first
 *
 * Which means the payout distribution is driven at least as much by cash-out
 * discipline as by reflexes. A cautious player of modest skill who banks at
 * break-even every time returns close to their stake forever. A better player
 * who always pushes for the cap busts more often than they win. Tuning against
 * a model that only has a skill dial would size the curve for a population that
 * does not exist.
 *
 * So a player here is two independent things: a hand, and a temperament.
 *
 * ── The reach model ──────────────────────────────────────────────────────────
 *
 * Chicken Run kills you on a single mistake, and each row is roughly an
 * independent attempt at not being hit. That makes reach geometric: with a
 * per-row survival probability p,
 *
 *     P(reach >= k) = p^k,     E[reach] = p / (1 - p)
 *
 * Geometric is not a decoration — it is the distribution a memoryless
 * one-mistake-and-out game actually produces, and it has the fat tail that
 * matters here: rare very long runs are exactly what a capped multiplier has to
 * survive. A normal distribution around a mean would hide the risk the cap
 * exists to bound.
 *
 * Real players are not stationary — attention drifts within a session — so p is
 * jittered per run. Small, but enough that a "disciplined" player is not a
 * deterministic machine that hits their target every single time.
 */

'use strict';

/**
 * Deterministic PRNG (mulberry32).
 *
 * Every number this harness reports has to be reproducible, or "RTP is 92%" is
 * an anecdote. Math.random would make every run a different experiment.
 */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, for the per-run skill jitter. */
function gaussian(random) {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Cash-out policies.
 *
 * Each returns the score at which this player intends to stop, given the offer
 * they were shown. They read the QUOTE, because that is all a real player has:
 * the break-even score, the target, and the shape of the curve.
 */
const POLICIES = {
  /**
   * Bank as soon as the entry is recovered. The rational floor: this player
   * never loses money except when they die before break-even.
   */
  cautious: (quote) => quote.curve.breakEvenScore,

  /** Play the game as designed: stop at the target the screen asked for. */
  disciplined: (quote) => quote.targetScore,

  /** Stop a little past the target, where the curve is still climbing. */
  ambitious: (quote) => Math.ceil(quote.targetScore * 1.35),

  /** Chase the cap. The last breakpoint, or nothing. */
  greedy: (quote) => quote.curve.points[quote.curve.points.length - 1].score,

  /**
   * No plan. Stops somewhere between break-even and well past the target.
   * Present because most real players are this, not one of the four above.
   */
  erratic: (quote, random) => {
    const lo = quote.curve.breakEvenScore;
    const hi = Math.ceil(quote.targetScore * 1.5);
    return lo + Math.floor(random() * Math.max(1, hi - lo + 1));
  },
};

/**
 * A population, chosen to bracket the design rather than to flatter it.
 *
 * The skill numbers are per-row survival probabilities; the mean reach each
 * implies is in the comment, because that is the number a human can sanity
 * check against watching someone play.
 */
const POPULATION = [
  { name: 'novice-cautious',    survival: 0.86, policy: 'cautious',    weight: 0.10 }, //  ~6
  { name: 'novice-erratic',     survival: 0.86, policy: 'erratic',     weight: 0.15 }, //  ~6
  { name: 'average-disciplined',survival: 0.92, policy: 'disciplined', weight: 0.20 }, // ~12
  { name: 'average-erratic',    survival: 0.92, policy: 'erratic',     weight: 0.20 }, // ~12
  { name: 'strong-disciplined', survival: 0.95, policy: 'disciplined', weight: 0.15 }, // ~19
  { name: 'strong-ambitious',   survival: 0.95, policy: 'ambitious',   weight: 0.10 }, // ~19
  { name: 'expert-greedy',      survival: 0.97, policy: 'greedy',      weight: 0.10 }, // ~32
];

/** Per-run jitter on survival probability. Attention is not constant. */
const SKILL_JITTER = 0.012;

/**
 * How far this player would have got on this run if nothing stopped them.
 *
 * Inverse-transform sampled from the geometric distribution rather than looped,
 * so the cost does not grow with the length of the run — an expert's 200-row
 * run costs the same as a novice's 3-row one.
 */
function sampleReach(survival, random) {
  const p = Math.min(0.995, Math.max(0.5, survival + gaussian(random) * SKILL_JITTER));
  const u = Math.max(random(), Number.EPSILON);
  return Math.floor(Math.log(u) / Math.log(p));
}

/**
 * Play one round against an offer.
 *
 * @returns {{score: number, reach: number, stoppedAt: number, died: boolean}}
 */
function playRound(archetype, quote, random) {
  const reach = sampleReach(archetype.survival, random);
  const policy = POLICIES[archetype.policy];
  const stoppedAt = Math.max(1, policy(quote, random));

  // The rule the whole mode rests on: if the run ends before they bank, the
  // score is zero. Not "the score they had" — zero.
  const died = reach < stoppedAt;

  return { score: died ? 0 : stoppedAt, reach, stoppedAt, died };
}

module.exports = { rng, gaussian, POLICIES, POPULATION, sampleReach, playRound };
