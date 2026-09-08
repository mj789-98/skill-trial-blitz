/**
 * blitzHeartbeat — record how far the player has got, mid-round.
 *
 * Cheap and frequent: roughly once a second while a round is live. It exists so
 * that a round which never finishes — app killed, battery died, tunnel — still
 * has a score the server acknowledged, instead of the sweeper having to guess.
 *
 * ── The trust problem, and the bound ─────────────────────────────────────────
 *
 * A heartbeat is a CLAIM. There is no trace behind it and nothing to replay, so
 * it cannot be verified the way a submitted round can. That matters because an
 * interrupted round settles on this number, which makes the cheapest attack in
 * the system obvious: report an enormous score, then never submit, and let the
 * sweeper pay it.
 *
 * So the server bounds it by physics rather than trusting it.
 *
 * The simulation refuses any input arriving less than HOP_COOLDOWN_TICKS after
 * the last accepted one. At 50Hz with a 6-tick cooldown that is one hop per
 * 120ms, so no run — human, scripted, or modified — can gain rows faster than
 * 8.33 per second. The server measures elapsed time from its OWN clock
 * (round.started_at, not anything the client says) and clamps the reported score
 * to what that many seconds could possibly have produced.
 *
 * That does not make the heartbeat honest. It makes it BOUNDED, which is what
 * settling on it requires. The residual hole is documented in DECISIONS.md: a
 * player can still claim the maximum physically-possible score for their elapsed
 * time. Closing that properly means carrying the trace on every heartbeat, which
 * is future work.
 *
 * ── Monotonic ────────────────────────────────────────────────────────────────
 *
 * The update only ever raises the stored score. Scores in this game never go
 * down — it is the furthest row reached — so a regression is either a bug or a
 * probe, and neither should be able to lower a banked figure.
 */

'use strict';

const { query } = require('../db');

/** Must match HOP_COOLDOWN_TICKS and TICK_HZ in sim/chickenRun.js. */
const TICK_HZ = 50;
const HOP_COOLDOWN_TICKS = 6;

/**
 * Generous slack on the physical bound.
 *
 * The clamp is a cheat ceiling, not a scoring rule, so it must never clip an
 * honest player. Clock skew, a slow heartbeat, and the round having started a
 * moment before the first tick all push the real figure slightly above the naive
 * calculation. The multiplier keeps the bound useful (it still rejects the
 * order-of-magnitude lie) while leaving no chance of penalising real play.
 */
const PLAUSIBILITY_SLACK = 1.5;
const PLAUSIBILITY_FLOOR = 5;

/**
 * The most rows a run could possibly have gained in `elapsedSeconds`.
 * Exported because the sweeper applies the same bound.
 */
function maxPlausibleScore(elapsedSeconds) {
  const hopsPerSecond = TICK_HZ / HOP_COOLDOWN_TICKS; // 8.33
  return Math.max(
    PLAUSIBILITY_FLOOR,
    Math.floor(elapsedSeconds * hopsPerSecond * PLAUSIBILITY_SLACK)
  );
}

/**
 * @param {string} playerId
 * @param {string} roundId
 * @param {number} score  the client's claim
 * @param {number} tick
 * @returns {Promise<{accepted: boolean, heartbeatScore: number, clamped: boolean}>}
 */
async function recordHeartbeat({ playerId, roundId, score, tick }) {
  if (!Number.isInteger(score) || score < 0) {
    const e = new Error(`score must be a non-negative integer, got ${score}`);
    e.code = 'INVALID_SCORE';
    throw e;
  }

  // One guarded statement. No transaction: there is nothing to keep consistent
  // with anything else, and a heartbeat every second per live round is exactly
  // the wrong place to be taking row locks.
  //
  // The elapsed time comes from the DATABASE — now() minus started_at — so a
  // client cannot widen its own allowance by lying about the clock.
  const { rows } = await query(
    `update blitz_rounds
        set heartbeat_score = least(
              $3::int,
              greatest(
                $4::int,
                floor(extract(epoch from (now() - started_at)) * $5 * $6)::int
              )
            ),
            heartbeat_at = now(),
            submitted_score = coalesce(submitted_score, null)
      where round_id = $1
        and player_id = $2
        and status = 'active'
        and $3::int > heartbeat_score
      returning heartbeat_score,
                floor(extract(epoch from (now() - started_at)) * $5 * $6)::int as ceiling`,
    [
      roundId,
      playerId,
      score,
      PLAUSIBILITY_FLOOR,
      TICK_HZ / HOP_COOLDOWN_TICKS,
      PLAUSIBILITY_SLACK,
    ]
  );

  if (rows.length === 0) {
    // Not an error. The round may be settled, may belong to someone else, or the
    // score may simply not be an improvement — all normal, and none worth
    // failing a request that fires every second.
    const current = await query(
      `select heartbeat_score, status from blitz_rounds
        where round_id = $1 and player_id = $2`,
      [roundId, playerId]
    );
    return {
      accepted: false,
      heartbeatScore: current.rows[0] ? Number(current.rows[0].heartbeat_score) : 0,
      status: current.rows[0] ? current.rows[0].status : 'unknown',
      clamped: false,
    };
  }

  const stored = Number(rows[0].heartbeat_score);
  return {
    accepted: true,
    heartbeatScore: stored,
    // Surfaced so a clamp shows up in logs. An honest client should never see
    // this true; a stream of them is a signal worth looking at.
    clamped: stored < score,
  };
}

module.exports = { recordHeartbeat, maxPlausibleScore, TICK_HZ, HOP_COOLDOWN_TICKS };
