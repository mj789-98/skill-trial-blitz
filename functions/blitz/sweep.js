/**
 * sweepStaleRounds — resolve rounds whose player never came back.
 *
 * The brief's hardest rule: "an entry must never silently disappear with the
 * player's money. Every path — a round that is abandoned, an app killed
 * mid-play, a crash between debit and settlement — has to end in a payout or a
 * refund you can point at in the ledger."
 *
 * The stake is debited at entry, so an abandoned round is money already taken
 * with nothing decided. This is what decides it.
 *
 * ── Why it settles rather than refunds ───────────────────────────────────────
 *
 * The round settles at the last score the SERVER acknowledged. Refunding instead
 * would hand the player a free option: start a round, see it going badly, kill
 * the app, get the money back. That is a strictly dominant strategy and it would
 * break the mode. Forfeiting at zero is the opposite failure — it punishes a
 * player for a dropped connection, which in a cash app is how you earn a
 * chargeback. Settling at the acknowledged score has neither problem: killing
 * the app on a bad run banks the bad run, which is what would have happened
 * anyway. Reasoned through in DECISIONS.md.
 *
 * ── Why it cannot double-pay ─────────────────────────────────────────────────
 *
 * It calls the SAME settle() as submit, with the SAME idempotency key
 * `payout:<roundId>`. A client submitting at the exact moment the sweeper fires
 * is a real race — the two are independent processes — and the loser collides on
 * the unique index instead of paying twice.
 *
 * ── Why each round gets its own transaction ──────────────────────────────────
 *
 * One bad round must not block the rest. A single transaction over a batch would
 * roll all of them back on one failure, and would hold row locks across the
 * whole batch while doing it.
 */

'use strict';

const { query, transaction } = require('../db');
const { settle } = require('./submit');
const { maxPlausibleScore } = require('./heartbeat');

/** Rounds per run. Bounded so one invocation cannot run unboundedly long. */
const DEFAULT_BATCH = 100;

/**
 * @param {number} [limit]
 * @returns {Promise<{swept: number, skipped: number, failed: number, results: Array}>}
 */
async function sweepStaleRounds({ limit = DEFAULT_BATCH } = {}) {
  // Candidates are selected OUTSIDE a transaction and re-checked inside one.
  // Between this query and the lock, a round may legitimately be settled by the
  // player's own submit — which is not an error, just a race we lost.
  const { rows: candidates } = await query(
    `select round_id
       from blitz_rounds
      where status = 'active'
        and deadline_at < now()
      order by deadline_at
      limit $1`,
    [limit]
  );

  const results = [];
  let swept = 0;
  let skipped = 0;
  let failed = 0;

  for (const { round_id: roundId } of candidates) {
    try {
      const outcome = await sweepOne(roundId);
      if (outcome.skipped) skipped++;
      else swept++;
      results.push(outcome);
    } catch (err) {
      // Logged and counted, never rethrown. One unresolvable round must not
      // stop the rest of the batch — the others are also holding player money.
      failed++;
      console.error(`[sweep] failed to settle ${roundId}: ${err.message}`);
      results.push({ roundId, skipped: false, error: err.message });
    }
  }

  if (candidates.length > 0) {
    console.log(
      `[sweep] ${candidates.length} candidate(s): ${swept} settled, ` +
      `${skipped} already resolved, ${failed} failed`
    );
  }

  return { swept, skipped, failed, results };
}

/** Settle one stale round. Its own transaction, its own row lock. */
async function sweepOne(roundId) {
  return transaction(async (client) => {
    const r = await client.query(
      `select round_id, player_id, game_id, stake_cents, curve, seed, status,
              heartbeat_score,
              extract(epoch from (now() - started_at)) as elapsed_seconds,
              (deadline_at < now()) as past_deadline
         from blitz_rounds
        where round_id = $1
        for update`,
      [roundId]
    );
    if (r.rowCount === 0) return { roundId, skipped: true, reason: 'vanished' };

    const round = r.rows[0];

    // Re-checked under the lock. The player's own submit may have landed in the
    // gap between selecting candidates and taking this lock.
    if (round.status !== 'active') {
      return { roundId, skipped: true, reason: `already ${round.status}` };
    }
    if (!round.past_deadline) {
      return { roundId, skipped: true, reason: 'not yet due' };
    }

    // The acknowledged score, bounded again by elapsed time. The heartbeat was
    // already clamped when written; re-applying it here means a round whose
    // heartbeat predates the clamp, or was written by an older build, still
    // cannot settle above what is physically possible.
    const score = Math.max(0, Math.min(
      Number(round.heartbeat_score),
      maxPlausibleScore(Number(round.elapsed_seconds))
    ));

    const outcome = await settle(client, {
      round,
      playerId: round.player_id,
      roundId,
      validatedScore: score,
      claimedScore: null,
      settleReason: 'sweep',
    });

    return { roundId, skipped: false, ...outcome };
  });
}

module.exports = { sweepStaleRounds, sweepOne, DEFAULT_BATCH };
