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
 * All four archetypes share one policy and differ only in how accurately they
 * execute it: aim error, and how often they miss the moment entirely.
 *
 * The policy models the decision the game actually asks for, which is NOT
 * "tap when low". One tap lifts the ball about 4009 sub-units and the rim is
 * around 9500, so climbing is several taps and no skill at all. The skill is
 * knowing when to STOP tapping — a ball that is already above the rim scores by
 * being allowed to fall through it, and every extra tap is a shot declined.
 *
 * So the bot climbs while below the rim, and above it predicts where the ball
 * would next cross rim height if it did nothing. Aligned with the hoop, it
 * holds off and lets the shot happen; not aligned, it taps again and waits for
 * the drift to bring the hoop around. Skill is the accuracy of that prediction.
 *
 * ── Why the previous policy had to go ────────────────────────────────────────
 *
 * It was `tap while y < HOOP_Y + 400 + jitter*60`: an open-loop threshold that
 * never aimed at anything. It survived a stationary rim because a constant
 * offset against a constant rim is just an aim point. Against a rim that moves
 * it inverted the population — the harness reported novices at 8.8 mean baskets
 * against experts at 3.8.
 *
 * The mechanism is worth recording, because it is a trap any tuning harness can
 * fall into. Scoring buys clock, so reach is right-skewed and unbounded: one
 * lucky offset compounds into a runaway round that dominates the mean. Under an
 * open-loop policy `jitter` was not sloppiness, it was SEARCH — the wider the
 * spread, the more often some round drew an offset that happened to line up.
 * Variance was being rewarded, and the archetype with the most variance is the
 * one named novice.
 *
 * There is no temperament axis, unlike Chicken Run, and its absence is the
 * point: Pop Shot gives the player no decision to be brave or cautious about.
 * Adding a fake one would have made the two populations look more alike than the
 * two games are.
 */

'use strict';

const sim = require('../../functions/sim/popShot');

/**
 * Aim error, and how often the player misses a chance entirely.
 *
 * `jitter` is now an error in the player's READ of where the ball will come
 * down, scaled to sub-units by AIM_ERROR_SUB, rather than an offset on a tap
 * threshold. RIM_HALF is 900, so a novice at 7 is wrong by up to 1400 — wider
 * than the hoop, so it genuinely misses — while an expert at 1 is wrong by up
 * to 200 and mostly does not.
 */
const POPULATION = [
  { name: 'novice',   policy: 'aim', jitter: 7, missChance: 0.34, weight: 0.25 },
  { name: 'average',  policy: 'aim', jitter: 4, missChance: 0.18, weight: 0.35 },
  { name: 'strong',   policy: 'aim', jitter: 2, missChance: 0.08, weight: 0.28 },
  { name: 'expert',   policy: 'aim', jitter: 1, missChance: 0.02, weight: 0.12 },
];

/** Sub-units of aim error per unit of jitter. See POPULATION. */
const AIM_ERROR_SUB = 200;

/** Hard stop, so a very good synthetic player cannot run the harness forever. */
const MAX_ROUND_TICKS = 60 * sim.TICK_HZ * 3;

/** Signed distance on a court that wraps, so -1 is next to COURT_W - 1. */
function wrapDelta(d) {
  const w = sim.COURT_W;
  let r = ((d % w) + w) % w;
  if (r > w / 2) r -= w;
  return r;
}

/**
 * Where the ball will be when it NEXT falls through rim height, untouched.
 *
 * Closed form rather than a forward simulation, because this runs on most ticks
 * of every round of every career and a 40-tick lookahead would dominate the
 * harness's runtime.
 *
 * The integrator is `vy -= G; y += vy`, so after k ticks
 *   y_k = y + vy*k - (G/2)*k*(k+1)
 * and setting y_k to the rim gives 11k^2 + (11 - vy)k - (y - hoopY) = 0 for
 * G = 22. The descending crossing is the positive root.
 *
 * Returns null when there is no descending crossing to predict — the ball is
 * below the rim and rising, or already past it.
 */
function crossingX(state) {
  const above = state.y - state.hoopY;
  const a = sim.GRAVITY / 2;
  const b = a - state.vy;
  const disc = b * b + 4 * a * above;
  if (disc < 0) return null;

  const k = (-b + Math.sqrt(disc)) / (2 * a);
  if (!(k > 0)) return null;

  return state.x + state.vx * k;
}

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

  // A player is having a good day or a bad one. Drawn once per round, so the
  // spread across a career is a spread of days rather than noise averaged
  // away inside every round.
  //
  // Symmetric. This used to be clamped with Math.max(0, ...), which turned
  // noise into a bias in proportion to how bad the archetype was meant to be.
  const dayBias = (random() * 2 - 1) * archetype.jitter * AIM_ERROR_SUB * 0.5;

  while (state.reason === null && state.tick < MAX_ROUND_TICKS) {
    pending.length = 0;

    const offCooldown = state.tick - state.lastTapTick >= sim.TAP_COOLDOWN_TICKS;
    if (offCooldown) {
      let wantTap;

      if (state.y < state.hoopY) {
        // Below the rim: climbing is forced, and there is no skill in it. One
        // tap gains about 4009 against a rim near 9500, so this is several
        // taps whoever is playing.
        wantTap = true;
      } else {
        // Above the rim, where the real decision is. Letting the ball fall IS
        // the shot; tapping declines it and waits for the drift to bring the
        // hoop back around.
        const cx = crossingX(state);
        if (cx === null) {
          wantTap = true;
        } else {
          const err = dayBias + (random() * 2 - 1) * archetype.jitter * AIM_ERROR_SUB;
          const missBy = Math.abs(wrapDelta(cx + err - state.hoopX));
          wantTap = missBy > sim.RIM_HALF;
        }
      }

      // Even a correct read gets fumbled sometimes.
      if (wantTap && random() >= archetype.missChance) pending.push(sim.ACT_TAP);
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
