/**
 * blitzQuote — generate the payout screen a player is about to be shown.
 *
 * NO MONEY MOVES HERE. This produces the offer; `enter` is what charges for it.
 *
 * ── Why the curve is frozen at quote time ────────────────────────────────────
 *
 * The brief: "The payout screen is binding at entry. Once the player pays, the
 * curve for that round is locked, regardless of what happens to their profile
 * afterwards."
 *
 * So the engine runs ONCE, here, and the resulting curve is stored on the quote
 * row as absolute score breakpoints. `enter` copies that stored curve onto the
 * round, and settlement reads only the round's copy. By the time money is
 * involved, the numbers have been fixed for a while and nothing downstream can
 * regenerate them.
 *
 * ── Why an old quote expires ─────────────────────────────────────────────────
 *
 * A player who opens the payout screen and comes back two hours later is holding
 * a curve generated against a profile that has since moved. The quote carries an
 * explicit lifetime; see DECISIONS.md for why 180s.
 *
 * ── Why a new quote supersedes the old one ───────────────────────────────────
 *
 * Without that, a player could open the screen repeatedly, collect several live
 * quotes, and enter on whichever was most generous — turning a targeting system
 * into a slot machine they get to re-roll. One open quote per (player, game).
 */

'use strict';

const { randomUUID } = require('crypto');
const { transaction } = require('../db');
const { buildQuote } = require('../engine/targetEngine');
const { emptyProfile } = require('../engine/targetEngine');
const { bpToX } = require('../engine/curve');

/** Config default, overridable per game in blitz_configs.params. */
const DEFAULT_TTL_SECONDS = 180;

/**
 * @param {string} playerId
 * @param {string} gameId
 * @param {number} stakeCents
 * @returns {Promise<object>} the quote, shaped for the payout screen
 */
async function createQuote({ playerId, gameId, stakeCents }) {
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    const e = new Error(`stakeCents must be a positive integer, got ${stakeCents}`);
    e.code = 'INVALID_STAKE';
    throw e;
  }

  return transaction(async (client) => {
    // ── The game must exist, be enabled, and have Blitz switched on ──────────
    const game = await client.query(
      'select game_id, display_name, blitz_enabled, enabled from games where game_id = $1',
      [gameId]
    );
    if (game.rowCount === 0) {
      const e = new Error(`no such game: ${gameId}`);
      e.code = 'NO_SUCH_GAME';
      throw e;
    }
    if (!game.rows[0].enabled || !game.rows[0].blitz_enabled) {
      // The per-game toggle, enforced server-side. A client asking for Blitz on
      // a game where it is switched off is refused rather than quietly served.
      const e = new Error(`Blitz is not enabled for ${gameId}`);
      e.code = 'BLITZ_NOT_ENABLED';
      throw e;
    }

    // ── Active config ────────────────────────────────────────────────────────
    const cfg = await client.query(
      'select config_id, params from blitz_configs where game_id = $1 and is_active',
      [gameId]
    );
    if (cfg.rowCount === 0) {
      const e = new Error(`no active Blitz config for ${gameId}`);
      e.code = 'NO_ACTIVE_CONFIG';
      throw e;
    }
    const { config_id: configId, params } = cfg.rows[0];

    const tiers = params.stake_tiers_cents;
    if (Array.isArray(tiers) && !tiers.includes(stakeCents)) {
      // Stakes are tiers, not free entry. Accepting an arbitrary amount would
      // let a client pick a stake the economics were never tuned for.
      const e = new Error(`stake ${stakeCents}c is not one of the offered tiers`);
      e.code = 'INVALID_STAKE_TIER';
      e.tiers = tiers;
      throw e;
    }

    // ── Profile ──────────────────────────────────────────────────────────────
    // Locked because a concurrent settlement would otherwise move the target
    // out from under the curve we are about to freeze.
    const prof = await client.query(
      `select * from blitz_profiles
        where player_id = $1 and game_id = $2
        for update`,
      [playerId, gameId]
    );
    const profile = prof.rowCount > 0
      ? normalise(prof.rows[0])
      : emptyProfile(playerId, gameId, params);

    // ── Build the curve ──────────────────────────────────────────────────────
    const built = buildQuote(profile, params, { stakeCents, now: new Date() });

    // ── Supersede any older open quote ───────────────────────────────────────
    await client.query(
      `update blitz_quotes
          set superseded_at = now()
        where player_id = $1
          and game_id = $2
          and consumed_by_round is null
          and superseded_at is null`,
      [playerId, gameId]
    );

    const ttlSeconds = Number(params.quote_ttl_seconds) > 0
      ? Number(params.quote_ttl_seconds)
      : DEFAULT_TTL_SECONDS;

    const quoteId = randomUUID();
    const inserted = await client.query(
      `insert into blitz_quotes
         (quote_id, player_id, game_id, config_id, stake_cents,
          curve, profile_snapshot, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)
       returning quote_id, stake_cents, created_at, expires_at`,
      [
        quoteId, playerId, gameId, configId, stakeCents,
        JSON.stringify(built.curve),
        JSON.stringify(built.profileSnapshot),
        String(ttlSeconds),
      ]
    );

    const row = inserted.rows[0];

    // The player's balance, so the screen can show an insufficient-balance state
    // before they commit rather than failing them at the moment they pay.
    const bal = await client.query(
      'select cash_cents from players where player_id = $1', [playerId]
    );
    const balanceCents = bal.rowCount > 0 ? Number(bal.rows[0].cash_cents) : 0;

    return {
      quoteId: row.quote_id,
      gameId,
      stakeCents: Number(row.stake_cents),
      expiresAt: row.expires_at,
      ttlSeconds,
      balanceCents,
      affordable: balanceCents >= stakeCents,
      bootstrap: built.bootstrap,
      // The curve, rendered for the payout screen. Multipliers travel as integer
      // basis points AND as x for display, so the client never has to derive one
      // from the other and get a different answer than the server.
      breakEvenScore: built.curve.breakEvenScore,
      targetScore: built.targetScore,
      curve: built.curve.points.map((p) => ({
        score: p.score,
        multBp: p.multBp,
        multiplier: bpToX(p.multBp),
        payoutCents: Math.floor((stakeCents * p.multBp) / 10000),
      })),
      maxMultiplier: bpToX(built.curve.capBp),
    };
  });
}

/**
 * Postgres returns numerics as strings and jsonb as parsed objects. The engine
 * expects numbers, so the conversion happens once, here, rather than being
 * guessed at by every caller.
 */
function normalise(row) {
  return {
    player_id: row.player_id,
    game_id: row.game_id,
    rounds_played: Number(row.rounds_played),
    bootstrap_used: Number(row.bootstrap_used),
    target_score: Number(row.target_score),
    ewma_score: row.ewma_score === null ? null : Number(row.ewma_score),
    best_score: row.best_score === null ? null : Number(row.best_score),
    recent_scores: Array.isArray(row.recent_scores) ? row.recent_scores.map(Number) : [],
    last_played_at: row.last_played_at,
  };
}

module.exports = { createQuote, normalise };
