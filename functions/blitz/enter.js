/**
 * blitzEnter — take the entry fee and start the round.
 *
 * This is the first point where money moves, and everything it does happens in
 * ONE transaction: debit the stake, create the round, consume the quote. A crash
 * anywhere inside leaves no trace of any of it.
 *
 * ── The curve is COPIED, not referenced ──────────────────────────────────────
 *
 * The round gets its own copy of the curve from the quote. Settlement reads
 * `blitz_rounds.curve` and nothing else — not the quote, not the config, not the
 * player's profile. So "the curve shown pre-entry is the curve paid out on" is
 * not a rule anyone has to remember to follow; it is the only curve the
 * settlement path can reach.
 *
 * ── Debit at entry, per the brief ────────────────────────────────────────────
 *
 * "Debit the stake at entry, not at settlement." That is also what makes an
 * abandoned round safe to resolve later: the money is already accounted for, and
 * the sweeper only has to decide the payout.
 *
 * ── Idempotent on the quote ──────────────────────────────────────────────────
 *
 * Entering the same quote twice returns the round it already created rather than
 * charging again. A double tap on "Play" is a retry, not a second purchase.
 *
 * ── Lock order ───────────────────────────────────────────────────────────────
 *
 * quote -> player -> profile, always, everywhere. Consistent ordering is what
 * stops two concurrent requests from deadlocking by grabbing the same rows in
 * opposite directions.
 */

'use strict';

const { randomUUID, randomInt } = require('crypto');
const { transaction } = require('../db');
const ledger = require('../money/ledger');
const { consumeBootstrap } = require('../engine/targetEngine');

/** Round lifetime before the sweeper resolves it. Config may override. */
const DEFAULT_DEADLINE_SECONDS = 900;

/**
 * @param {string} playerId
 * @param {string} quoteId
 * @returns {Promise<{roundId, seed, stakeCents, curve, balanceCents, alreadyStarted}>}
 */
async function enterRound({ playerId, quoteId }) {
  return transaction(async (client) => {
    // ── 1. The quote ─────────────────────────────────────────────────────────
    const q = await client.query(
      `select quote_id, player_id, game_id, config_id, stake_cents, curve,
              expires_at, consumed_by_round, superseded_at
         from blitz_quotes
        where quote_id = $1
        for update`,
      [quoteId]
    );
    if (q.rowCount === 0) {
      throw coded('NO_SUCH_QUOTE', `no such quote: ${quoteId}`);
    }
    const quote = q.rows[0];

    // The quote belongs to whoever asked for it. Without this check a player
    // could enter on a curve generated for someone else's profile.
    if (quote.player_id !== playerId) {
      throw coded('QUOTE_NOT_YOURS', 'that quote belongs to another player');
    }

    // Already entered: return what it produced. This is the retry path.
    if (quote.consumed_by_round) {
      const existing = await client.query(
        `select round_id, seed, stake_cents, curve, status
           from blitz_rounds where round_id = $1`,
        [quote.consumed_by_round]
      );
      const bal = await ledger.balance(client, playerId);
      return {
        roundId: existing.rows[0].round_id,
        seed: existing.rows[0].seed,
        stakeCents: Number(existing.rows[0].stake_cents),
        curve: existing.rows[0].curve,
        balanceCents: bal,
        alreadyStarted: true,
      };
    }

    if (quote.superseded_at) {
      throw coded('QUOTE_SUPERSEDED', 'a newer payout screen was generated; re-quote');
    }

    // Expiry is evaluated by the DATABASE clock, not the server's. Two function
    // instances can disagree about the time; Postgres cannot disagree with
    // itself, and it is what wrote expires_at.
    const fresh = await client.query(
      'select (expires_at > now()) as still_valid, expires_at from blitz_quotes where quote_id = $1',
      [quoteId]
    );
    if (!fresh.rows[0].still_valid) {
      throw coded('QUOTE_EXPIRED',
        'this payout screen has expired; request a new one');
    }

    const stakeCents = Number(quote.stake_cents);
    const roundId = randomUUID();

    // ── 2. Debit ─────────────────────────────────────────────────────────────
    // ledger.post locks the player row and refuses to go negative. The key ties
    // the debit to this round, so it can never be applied twice.
    let debit;
    try {
      debit = await ledger.post(client, {
        playerId,
        kind: 'stake',
        amountCents: stakeCents,
        idempotencyKey: `stake:${roundId}`,
        roundId,
        memo: `Blitz entry, ${quote.game_id}`,
      });
    } catch (e) {
      if (e.code === 'INSUFFICIENT_BALANCE') {
        // A real UI state, per the brief — surfaced with the numbers the screen
        // needs rather than a generic failure.
        throw coded('INSUFFICIENT_BALANCE',
          `not enough balance: have ${e.balanceCents}c, need ${stakeCents}c`,
          { balanceCents: e.balanceCents, requiredCents: stakeCents });
      }
      throw e;
    }

    // ── 3. The round ─────────────────────────────────────────────────────────
    const cfg = await client.query(
      'select params from blitz_configs where config_id = $1',
      [quote.config_id]
    );
    const params = cfg.rows[0].params || {};
    const deadlineSeconds = Number(params.round_deadline_seconds) > 0
      ? Number(params.round_deadline_seconds)
      : DEFAULT_DEADLINE_SECONDS;

    // The world seed is issued by the SERVER. If the client chose it, a player
    // could roll until they got an easy board, and the replay defence would be
    // validating a world they had hand-picked.
    const seed = String(randomInt(1, 2 ** 31 - 1));

    await client.query(
      `insert into blitz_rounds
         (round_id, quote_id, player_id, game_id, stake_cents, curve, seed, deadline_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)`,
      [
        roundId, quoteId, playerId, quote.game_id, stakeCents,
        // ★ The curve, copied. Settlement will read THIS and only this.
        JSON.stringify(quote.curve),
        seed, String(deadlineSeconds),
      ]
    );

    await client.query(
      'update blitz_quotes set consumed_by_round = $1 where quote_id = $2',
      [roundId, quoteId]
    );

    // ── 4. Profile ───────────────────────────────────────────────────────────
    // Consume the bootstrap allowance at ENTRY, not at settlement. That is the
    // anti-farm: a player cannot spend the capped-but-friendly starter rounds,
    // abandon the ones going badly, and still hold the allowance.
    await client.query(
      `insert into blitz_profiles (player_id, game_id, target_score, bootstrap_used)
       values ($1, $2, $3, 1)
       on conflict (player_id, game_id) do update
         set bootstrap_used = $4,
             updated_at = now()`,
      [
        playerId, quote.game_id,
        Number(params.cold_start?.seed_target ?? 12),
        await nextBootstrap(client, playerId, quote.game_id, params),
      ]
    );

    return {
      roundId,
      seed,
      gameId: quote.game_id,
      stakeCents,
      curve: quote.curve,
      balanceCents: debit.balanceCents,
      alreadyStarted: false,
    };
  });
}

/** Bootstrap counter for an existing profile, or 1 for a brand new one. */
async function nextBootstrap(client, playerId, gameId, params) {
  const { rows } = await client.query(
    'select bootstrap_used from blitz_profiles where player_id = $1 and game_id = $2',
    [playerId, gameId]
  );
  if (rows.length === 0) return 1;
  return consumeBootstrap({ bootstrap_used: Number(rows[0].bootstrap_used) }, params);
}

function coded(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

module.exports = { enterRound };
