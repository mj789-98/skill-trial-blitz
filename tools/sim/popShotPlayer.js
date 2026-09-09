/**
 * Synthetic Pop Shot players.
 *
 * ── These ones actually play the game ────────────────────────────────────────
 *
 * The Chicken Run population is a MODEL: reach is drawn from a geometric
 * distribution because a one-mistake-and-out game produces one, and the cash-out
 * policy is a separate dial. That is the right approach there, because the thing
 * being modelled — where a human chooses to stop — has no algorithm.
 *
 * Pop Shot has no such choice. There is no cash-out, so a score is purely how
 * many baskets a player lands before the clock beats them, and "how many baskets
 * does this tap policy land" is a question the simulation can answer exactly. So
 * these players run the real functions/sim/popShot.js rather than a distribution
 * fitted to it — which means the tuning numbers cannot drift away from the game
 * when the game changes.
 *
 * ── What skill IS here ───────────────────────────────────────────────────────
 *
 * All four archetypes share one policy: tap when the ball is below rim height
 * and drifting toward the hoop. They differ in how accurately they execute it —
 * timing jitter, and how often they simply miss the moment. That is a fair model
 * of the actual skill, which is a timing skill and nothing else.
 *
 * There is no temperament axis, unlike Chicken Run, and its absence is the
 * point: Pop Shot gives the player no decision to be brave or cautious about.
 * Adding a fake one would have made the two populations look more alike than the
 * two games are.
 */

'use strict';

const sim = require('../../functions/sim/popShot');

/**
 * Timing error, in ticks, and how often the player misses a chance entirely.
 *
 * The mean scores each produces are in the comments — measured, not guessed, so
 * the archetype names can be checked against what they actually do.
 */
const POPULATION = [
  { name: 'novice',   policy: 'timing', jitter: 7, missChance: 0.34, weight: 0.25 },
  { name: 'average',  policy: 'timing', jitter: 4, missChance: 0.18, weight: 0.35 },
  { name: 'strong',   policy: 'timing', jitter: 2, missChance: 0.08, weight: 0.28 },
  { name: 'expert',   policy: 'timing', jitter: 1, missChance: 0.02, weight: 0.12 },
];

/** Hard stop, so a very good synthetic player cannot run the harness forever. */
const MAX_ROUND_TICKS = 60 * sim.TICK_HZ * 3;

/**
 * Play one Pop Shot round with this archetype's competence.
 *
 * The quote is accepted for signature compatibility with the Chicken Run player
 * and deliberately ignored: Pop Shot has no cash-out, so nothing about the
 * payout curve can change how the round is played. In Chicken Run the curve
 * changes behaviour, because the target is where a disciplined player stops.
 * That asymmetry is real and worth not papering over.
 */
function playRound(archetype, quote, random) {
  const state = sim.createState(String(Math.floor(random() * 0xffffffff) >>> 0));
  const pending = [];

  // Jitter is drawn once per round, not per tap: a player is having a good day
  // or a bad one, and re-rolling every tap would average that away and make
  // every round identical.
  const jitter = Math.max(0, Math.round((random() * 2 - 1) * archetype.jitter));

  while (state.reason === null && state.tick < MAX_ROUND_TICKS) {
    pending.length = 0;

    const towardHoop =
      Math.sign(state.hoopX - state.x) === Math.sign(state.vx) || state.vx === 0;
    const lowEnoughToNeedLift = state.y < sim.HOOP_Y + 400 + jitter * 60;
    const offCooldown = state.tick - state.lastTapTick >= sim.TAP_COOLDOWN_TICKS;

    if (towardHoop && lowEnoughToNeedLift && offCooldown) {
      if (random() >= archetype.missChance) pending.push(sim.ACT_TAP);
    }

    sim.step(state, pending);
  }

  return {
    score: sim.scoreFor(state),
    reach: state.baskets,
    stoppedAt: state.baskets,
    died: false,
  };
}

module.exports = { POPULATION, playRound, MAX_ROUND_TICKS };
