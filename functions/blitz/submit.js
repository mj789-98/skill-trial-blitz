/**
 * blitzSubmit — validate the run and settle it.
 *
 * This is where the client's claim meets the server's arithmetic, and the two
 * rules that matter most both live here.
 *
 * ── 1. The score is RECOMPUTED, never accepted ───────────────────────────────
 *
 * The client sends an input trace and a score. The score is used for exactly one
 * thing: comparison. The server replays the trace against the seed IT issued,
 * through the same simulation the client ran, and settles on the score that
 * replay produces. A client that reports 400 having played a 12 is paid for 12,
 * and the mismatch is recorded.
 *
 * ── 2. Settlement can only see the round's own curve ─────────────────────────
 *
 * The payout is resolved against `blitz_rounds.curve` — the copy taken at entry.
 * Not the quote, not the config, not the player's profile, none of which this
 * function reads. So "paid on the curve you were shown" is not a rule anyone has
 * to remember; there is no other curve reachable from here.
 *
 * ── Exactly one outcome, once ────────────────────────────────────────────────
 *
 * The round row is locked FOR UPDATE. An already-settled round returns its
 * existing result rather than erroring, because a retry deserves an answer, not
 * a failure. And the payout carries the key `payout:<roundId>` — the SAME key
 * the sweeper uses — so if a client submit and a sweeper settlement genuinely
 * race, the second one loses on the unique index instead of paying twice.
 */

'use strict';

const { transaction } = require('../db');
const ledger = require('../money/ledger');
const { validatorFor } = require('../sim');
const { multiplierBpForScore, payoutCents, bpToX } = require('../engine/curve');
const { advanceProfile } = require('../engine/targetEngine');
const { normalise } = require('./quote');
const { maxPlausibleScore } = require('./heartbeat');

/**
 * @param {string} playerId
 * @param {string} roundId
 * @param {number} claimedScore  what the client believes it scored
 * @param {string} trace         base64 input trace
 */
async function submitRound({ playerId, roundId, claimedScore, trace }) {
  return transaction(async (client) => {
    // ── The round ────────────────────────────────────────────────────────────
    const r = await client.query(
      `select round_id, player_id, game_id, stake_cents, curve, seed, status,
              heartbeat_score, payout_cents, multiplier, validated_score,
              settle_reason, settled_at,
              extract(epoch from (now() - started_at)) as elapsed_seconds
         from blitz_rounds
        where round_id = $1
        for update`,
      [roundId]
    );
    if (r.rowCount === 0) throw coded('NO_SUCH_ROUND', `no such round: ${roundId}`);
    const round = r.rows[0];

    if (round.player_id !== playerId) {
      throw coded('ROUND_NOT_YOURS', 'that round belongs to another player');
    }

    // ── Already settled: hand back the original outcome ──────────────────────
    // A retry, a double tap, or a client that submits after the sweeper already
    // resolved the round. None of these is an error.
    if (round.status === 'settled') {
      return {
        roundId,
        alreadySettled: true,
        score: Number(round.validated_score),
        multiplier: Number(round.multiplier),
        payoutCents: Number(round.payout_cents),
        stakeCents: Number(round.stake_cents),
        settleReason: round.settle_reason,
        balanceCents: await ledger.balance(client, playerId),
      };
    }
    if (round.status === 'voided') {
      throw coded('ROUND_VOIDED', 'this round was voided');
    }

    // ── Validate ─────────────────────────────────────────────────────────────
    const validator = validatorFor(round.game_id);

    let validatedScore;
    let settleReason = 'submit';
    let replayReason = null;
    let mismatch = false;

    try {
      const replay = validator.simulate(round.seed, trace);
      validatedScore = replay.score;
      replayReason = replay.reason;
      mismatch = Number.isInteger(claimedScore) && claimedScore !== validatedScore;

      if (mismatch) {
        // Recorded, not thrown. The player is simply paid what they earned; a
        // hard rejection would turn every client bug into a support ticket while
        // gaining nothing, since the honest figure is already known.
        console.warn(
          `[submit] score mismatch on ${roundId}: client claimed ${claimedScore}, ` +
          `replay produced ${validatedScore} (${replayReason})`
        );
      }
    } catch (err) {
      // The trace did not decode, or was not a legal trace for this seed. There
      // is no evidence of what happened, so this falls back to the interrupted-
      // round outcome: the last score the SERVER acknowledged, which is bounded
      // by the plausibility clamp in heartbeat.js.
      //
      // Settling rather than rejecting is deliberate — the brief requires every
      // round to end in exactly one outcome, and leaving it active would let a
      // client hold a debited round open by sending rubbish.
      const bounded = Math.min(
        Number(round.heartbeat_score),
        maxPlausibleScore(Number(round.elapsed_seconds))
      );
      validatedScore = bounded;
      settleReason = 'invalid_trace';
      console.warn(
        `[submit] invalid trace on ${roundId} (${err.message}); ` +
        `settling at the acknowledged heartbeat ${bounded}`
      );
    }

    return settle(client, {
      round, playerId, roundId,
      validatedScore,
      claimedScore: Number.isInteger(claimedScore) ? claimedScore : null,
      settleReason, mismatch, replayReason,
    });
  });
}

/**
 * Resolve a round to money. Shared by submit and the sweeper so both produce
 * byte-identical outcomes — two settlement paths that could disagree would be a
 * second source of truth about what a round was worth.
 *
 * Caller MUST hold the round row lock.
 */
async function settle(client, {
  round, playerId, roundId, validatedScore, claimedScore = null,
  settleReason, mismatch = false, replayReason = null,
}) {
  const stakeCents = Number(round.stake_cents);

  // ★ The round's own curve. Nothing else is read.
  const multBp = multiplierBpForScore(round.curve, validatedScore);
  const payout = payoutCents(stakeCents, multBp);

  // Same key as the sweeper. Whichever gets there second loses on the unique
  // index rather than paying twice.
  const posted = await ledger.post(client, {
    playerId,
    kind: 'payout',
    amountCents: payout,
    idempotencyKey: `payout:${roundId}`,
    roundId,
    memo: `Blitz ${round.game_id}: score ${validatedScore} at ${bpToX(multBp)}x`,
  });

  await client.query(
    `update blitz_rounds
        set status = 'settled',
            submitted_score = $2,
            validated_score = $3,
            multiplier = $4,
            payout_cents = $5,
            settle_reason = $6,
            settled_at = now()
      where round_id = $1`,
    [roundId, claimedScore, validatedScore, bpToX(multBp), payout, settleReason]
  );

  await updateProfile(client, {
    playerId, gameId: round.game_id, score: validatedScore,
  });

  return {
    roundId,
    alreadySettled: false,
    score: validatedScore,
    claimedScore,
    scoreMismatch: mismatch,
    endReason: replayReason,
    multiplier: bpToX(multBp),
    multBp,
    stakeCents,
    payoutCents: payout,
    netCents: payout - stakeCents,
    settleReason,
    balanceCents: posted.balanceCents,
  };
}

/**
 * Fold the settled score into the profile, so the NEXT round is quoted from it.
 *
 * Done here, at settlement, on the VALIDATED score. Ratcheting on a claimed
 * score would let a player inflate their own targets — which sounds
 * self-defeating until you notice it also inflates the multipliers a legitimate
 * run would pay.
 */
async function updateProfile(client, { playerId, gameId, score }) {
  const cfg = await client.query(
    'select params from blitz_configs where game_id = $1 and is_active',
    [gameId]
  );
  const params = cfg.rows[0] ? cfg.rows[0].params : {};

  const existing = await client.query(
    `select * from blitz_profiles
      where player_id = $1 and game_id = $2
      for update`,
    [playerId, gameId]
  );

  const profile = existing.rowCount > 0
    ? normalise(existing.rows[0])
    : {
        player_id: playerId, game_id: gameId, rounds_played: 0,
        bootstrap_used: 0, target_score: Number(params.cold_start?.seed_target ?? 12),
        ewma_score: null, best_score: null, recent_scores: [], last_played_at: null,
      };

  const next = advanceProfile(profile, score, params, new Date());

  await client.query(
    `insert into blitz_profiles
       (player_id, game_id, rounds_played, bootstrap_used, target_score,
        ewma_score, best_score, recent_scores, last_played_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
     on conflict (player_id, game_id) do update
       set rounds_played = excluded.rounds_played,
           target_score  = excluded.target_score,
           ewma_score    = excluded.ewma_score,
           best_score    = excluded.best_score,
           recent_scores = excluded.recent_scores,
           last_played_at = now(),
           updated_at    = now()`,
    [
      playerId, gameId, next.rounds_played,
      // bootstrap_used is owned by enter(), which consumes it. Preserved here so
      // a settlement cannot hand the allowance back.
      profile.bootstrap_used,
      next.target_score, next.ewma_score, next.best_score,
      JSON.stringify(next.recent_scores),
    ]
  );
}

function coded(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

module.exports = { submitRound, settle };
