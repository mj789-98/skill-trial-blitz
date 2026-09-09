/**
 * The tuning harness.
 *
 * The brief: "a way to simulate many rounds with synthetic players of varying
 * skill and report RTP, win rate and rounds-to-bust. Pick an RTP number and
 * defend it — show the numbers either side."
 *
 * ── It runs the shipping code, not a model of it ─────────────────────────────
 *
 * `buildQuote`, `materialiseCurve`, `multiplierBpForScore`, `payoutCents` and
 * `advanceProfile` are imported from functions/engine/. Nothing here
 * reimplements the economics. A harness that models the curve instead of
 * calling it measures the model, and the two drift the first time either is
 * touched — which is precisely when you most want the numbers to be true.
 *
 * The consequence worth noticing: the target engine ADAPTS inside every run.
 * Each simulated round updates the profile the next quote is built from, so what
 * this measures is the closed loop — player, engine, curve — not a fixed paytable.
 * A configuration can look generous on round one and be self-correcting by round
 * twenty, and only a closed-loop harness can tell you which.
 *
 * ── Everything is seeded ─────────────────────────────────────────────────────
 *
 * One PRNG, one seed, threaded explicitly. Re-running with the same seed
 * reproduces every number, so a config change can be attributed to the config
 * rather than to variance.
 */

'use strict';

const { multiplierBpForScore, payoutCents } = require('../../functions/engine/curve');
const {
  advanceProfile,
  buildQuote,
  consumeBootstrap,
  emptyProfile,
} = require('../../functions/engine/targetEngine');
const { POPULATION, playRound, rng } = require('./player');

/**
 * Play one synthetic player's career.
 *
 * @returns per-round records plus how long their bankroll lasted.
 */
function simulateCareer({ archetype, params, stakeCents, bankrollCents, rounds, random }) {
  let profile = emptyProfile(`sim:${archetype.name}`, 'chicken_run', params);
  let bankroll = bankrollCents;

  const records = [];
  let bustAtRound = null;

  for (let round = 1; round <= rounds; round++) {
    // Bust is defined as being unable to afford the entry, not as reaching
    // zero: a player with 40c and a 300c entry is out of the mode.
    if (bankroll < stakeCents) {
      bustAtRound = round - 1;
      break;
    }

    // A real player who is refused a tier drops to what they are allowed. The
    // bootstrap cap is a constraint on the player, not an error in the harness.
    let stake = stakeCents;
    let quote;
    try {
      quote = buildQuote(profile, params, { stakeCents: stake });
    } catch (err) {
      if (err.code !== 'STAKE_ABOVE_BOOTSTRAP_LIMIT') throw err;
      stake = err.maxStakeCents;
      quote = buildQuote(profile, params, { stakeCents: stake });
    }

    const outcome = playRound(archetype, quote, random);

    const multBp = multiplierBpForScore(quote.curve, outcome.score);
    const payout = payoutCents(stake, multBp);

    bankroll = bankroll - stake + payout;

    // Same order as the server: bootstrap is consumed at entry, the profile
    // ratchets at settlement.
    profile = { ...profile, bootstrap_used: consumeBootstrap(profile, params) };
    profile = advanceProfile(profile, outcome.score, params);

    records.push({
      round,
      stakeCents: stake,
      payoutCents: payout,
      score: outcome.score,
      reach: outcome.reach,
      stoppedAt: outcome.stoppedAt,
      died: outcome.died,
      targetScore: quote.targetScore,
      breakEvenScore: quote.curve.breakEvenScore,
      multBp,
      bankrollCents: bankroll,
    });
  }

  return { records, bustAtRound, finalBankrollCents: bankroll };
}

/** Sum, mean, and percentile helpers. Small enough not to be worth a dependency. */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

function percentile(xs, p) {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Roll a set of per-round records up into the numbers the brief asks for. */
function summarise(records, careers, rounds) {
  const staked = sum(records.map((r) => r.stakeCents));
  const paid = sum(records.map((r) => r.payoutCents));

  const busted = careers.filter((c) => c.bustAtRound !== null);
  const survivedRounds = careers.map((c) => (c.bustAtRound === null ? rounds : c.bustAtRound));

  return {
    rounds: records.length,
    players: careers.length,

    // RTP: cents returned per cent staked, over every round played. The single
    // number the mode's economics live or die by.
    rtp: staked === 0 ? 0 : paid / staked,
    // House edge is 1 - RTP by definition; stated separately because it is the
    // number a finance conversation uses.
    houseEdge: staked === 0 ? 0 : 1 - paid / staked,

    // Two different questions a player asks. "Did I get anything?" and "did I
    // come out ahead?" are far apart in a mode where break-even is a real
    // outcome, and reporting only one of them flatters the design.
    winRate: records.length ? records.filter((r) => r.payoutCents > r.stakeCents).length / records.length : 0,
    nonZeroRate: records.length ? records.filter((r) => r.payoutCents > 0).length / records.length : 0,
    deathRate: records.length ? records.filter((r) => r.died).length / records.length : 0,

    // Rounds-to-bust. The median is the honest headline; p10 is the one that
    // tells you how a bad session feels, and that is the session people talk
    // about.
    bustRate: careers.length ? busted.length / careers.length : 0,
    medianRoundsSurvived: percentile(survivedRounds, 0.5),
    p10RoundsSurvived: percentile(survivedRounds, 0.1),

    meanScore: mean(records.map((r) => r.score)),
    meanTarget: mean(records.map((r) => r.targetScore)),
    meanReach: mean(records.map((r) => r.reach)),
    meanMultiplierWhenPaid: mean(
      records.filter((r) => r.payoutCents > 0).map((r) => r.multBp / 10000)
    ),
  };
}

/**
 * Run the whole population.
 *
 * @param {object} opts
 * @param {object} opts.params        the blitz config to measure
 * @param {number} [opts.playersPer]  synthetic players per archetype
 * @param {number} [opts.rounds]      rounds each player attempts
 * @param {number} [opts.stakeCents]  the tier they play
 * @param {number} [opts.bankrollCents]
 * @param {number} [opts.seed]
 */
function runHarness({
  params,
  playersPer = 200,
  rounds = 60,
  stakeCents = 300,
  bankrollCents = 6000,
  seed = 20260101,
  population = POPULATION,
} = {}) {
  const random = rng(seed);

  const byArchetype = {};
  const allRecords = [];
  const allCareers = [];

  for (const archetype of population) {
    const careers = [];
    const records = [];

    for (let i = 0; i < playersPer; i++) {
      const career = simulateCareer({
        archetype,
        params,
        stakeCents,
        bankrollCents,
        rounds,
        random,
      });
      careers.push(career);
      records.push(...career.records);
    }

    byArchetype[archetype.name] = {
      ...summarise(records, careers, rounds),
      weight: archetype.weight,
      survival: archetype.survival,
      policy: archetype.policy,
    };

    allRecords.push(...records);
    allCareers.push(...careers);
  }

  // The population RTP is WEIGHTED, not a raw pool average. An unweighted
  // average would let a rare archetype that plays many rounds before busting
  // dominate the headline number for a population it does not represent.
  const weightTotal = sum(population.map((a) => a.weight));
  const weightedRtp =
    sum(population.map((a) => byArchetype[a.name].rtp * a.weight)) / weightTotal;
  const weightedWinRate =
    sum(population.map((a) => byArchetype[a.name].winRate * a.weight)) / weightTotal;

  return {
    settings: { playersPer, rounds, stakeCents, bankrollCents, seed },
    overall: {
      ...summarise(allRecords, allCareers, rounds),
      weightedRtp,
      weightedWinRate,
    },
    byArchetype,
  };
}

module.exports = { runHarness, simulateCareer, summarise, percentile };
