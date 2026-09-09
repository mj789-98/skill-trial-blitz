/**
 * Cloud Functions entry point.
 *
 * JavaScript, not TypeScript, per the brief.
 *
 * ── The one rule every callable follows ──────────────────────────────────────
 *
 * The player's identity comes from the VERIFIED auth token, never from the
 * request body. `request.auth.uid` is populated by Firebase after it has checked
 * the signature; a `playerId` field in the payload is just something the client
 * typed, and honouring one would let anyone stake from anyone else's balance.
 *
 * Callables stay thin: check the caller, validate the shape of the input, hand
 * off to the module that owns the rule. Nothing that moves money lives here —
 * that is money/ledger.js, and the round loop is under blitz/.
 *
 * ── Errors ───────────────────────────────────────────────────────────────────
 *
 * Domain errors carry a `code` (INSUFFICIENT_BALANCE, QUOTE_EXPIRED, ...) and are
 * mapped onto HttpsError so the app can branch on them and render a real state.
 * Anything unrecognised becomes a generic 'internal' — an unexpected failure
 * should not leak its internals to a hostile client.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

const { query } = require('./db');
const { createQuote } = require('./blitz/quote');
const { enterRound } = require('./blitz/enter');
const { recordHeartbeat } = require('./blitz/heartbeat');
const { submitRound } = require('./blitz/submit');
const { sweepStaleRounds } = require('./blitz/sweep');
const ledger = require('./money/ledger');
const { transaction } = require('./db');

/** Domain error code -> HttpsError code. Anything absent is 'internal'. */
const ERROR_MAP = {
  INVALID_STAKE: 'invalid-argument',
  INVALID_STAKE_TIER: 'invalid-argument',
  INVALID_SCORE: 'invalid-argument',
  NO_SUCH_GAME: 'not-found',
  NO_SUCH_QUOTE: 'not-found',
  NO_SUCH_ROUND: 'not-found',
  NO_ACTIVE_CONFIG: 'failed-precondition',
  BLITZ_NOT_ENABLED: 'failed-precondition',
  STAKE_ABOVE_BOOTSTRAP_LIMIT: 'failed-precondition',
  QUOTE_EXPIRED: 'failed-precondition',
  QUOTE_SUPERSEDED: 'failed-precondition',
  ROUND_VOIDED: 'failed-precondition',
  INSUFFICIENT_BALANCE: 'failed-precondition',
  QUOTE_NOT_YOURS: 'permission-denied',
  ROUND_NOT_YOURS: 'permission-denied',
  NO_VALIDATOR: 'failed-precondition',
};

/**
 * Wrap a handler: require a signed-in caller, translate domain errors.
 *
 * The handler receives the uid — it is never handed the raw request, so it
 * cannot accidentally read an identity out of the body.
 */
function authed(handler) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', 'sign in to play');
    }

    try {
      return await handler(uid, request.data || {});
    } catch (err) {
      const mapped = ERROR_MAP[err.code];
      if (mapped) {
        // Domain errors carry the numbers a screen needs — a balance and a
        // requirement, say — so they travel in the details payload.
        throw new HttpsError(mapped, err.message, {
          code: err.code,
          balanceCents: err.balanceCents,
          requiredCents: err.requiredCents,
          tiers: err.tiers,
          maxStakeCents: err.maxStakeCents,
        });
      }
      console.error('[api] unhandled error:', err);
      throw new HttpsError('internal', 'something went wrong');
    }
  };
}

// ── Health and lobby ────────────────────────────────────────────────────────

/** Proves the whole chain: Functions runtime, the pg pool, the path to Postgres. */
exports.ping = onCall(async () => {
  const started = Date.now();
  const { rows } = await query('select current_database() as db, version() as version');
  return {
    ok: true,
    database: rows[0].db,
    postgres: String(rows[0].version).split(',')[0],
    roundTripMs: Date.now() - started,
  };
});

/**
 * The games the lobby can show.
 *
 * blitz_enabled is read from the database, which is what makes Blitz a per-game
 * toggle rather than something hard-wired to Chicken Run.
 */
exports.listGames = onCall(async () => {
  // The stake tiers come from the ACTIVE config, not from a constant in the app.
  // The brief requires the target engine be retunable without a rebuild, and a
  // client with its own copy of the tiers is a rebuild waiting to happen: change
  // them in the database and the lobby would offer a stake the server refuses.
  const { rows } = await query(
    `select g.game_id, g.display_name, g.blitz_enabled,
            c.params -> 'stake_tiers_cents'      as stake_tiers_cents,
            c.params -> 'cold_start' -> 'bootstrap_max_stake_cents'
              as bootstrap_max_stake_cents
       from games g
       left join blitz_configs c
         on c.game_id = g.game_id and c.is_active
      where g.enabled
      order by g.sort_order`
  );

  return {
    games: rows.map((r) => ({
      game_id: r.game_id,
      display_name: r.display_name,
      // A game with Blitz on but no active config cannot be entered, so it is
      // reported as disabled rather than as an offer that will fail at quote.
      blitz_enabled: r.blitz_enabled && Array.isArray(r.stake_tiers_cents),
      stakeTiersCents: Array.isArray(r.stake_tiers_cents)
        ? r.stake_tiers_cents.map(Number)
        : [],
      bootstrapMaxStakeCents:
        r.bootstrap_max_stake_cents === null ? null : Number(r.bootstrap_max_stake_cents),
    })),
  };
});

/** The signed-in player's balance and profile summary. */
exports.getProfile = onCall(authed(async (uid) => {
  // Create the player row on first sight. Firebase Auth owns identity; this
  // table owns the money, and the two meet here.
  await query(
    `insert into players (player_id, display_name)
     values ($1, $2) on conflict (player_id) do nothing`,
    [uid, 'Player']
  );

  const { rows } = await query(
    'select player_id, display_name, cash_cents from players where player_id = $1',
    [uid]
  );
  const profiles = await query(
    `select game_id, rounds_played, best_score, target_score
       from blitz_profiles where player_id = $1`,
    [uid]
  );

  return {
    playerId: rows[0].player_id,
    displayName: rows[0].display_name,
    balanceCents: Number(rows[0].cash_cents),
    profiles: profiles.rows,
  };
}));

// ── The Blitz round loop ────────────────────────────────────────────────────

exports.blitzQuote = onCall(authed(async (uid, data) =>
  createQuote({
    playerId: uid,
    gameId: String(data.gameId || ''),
    stakeCents: Number(data.stakeCents),
  })
));

exports.blitzEnter = onCall(authed(async (uid, data) =>
  enterRound({ playerId: uid, quoteId: String(data.quoteId || '') })
));

exports.blitzHeartbeat = onCall(authed(async (uid, data) =>
  recordHeartbeat({
    playerId: uid,
    roundId: String(data.roundId || ''),
    score: Number(data.score),
    tick: Number(data.tick) || 0,
  })
));

exports.blitzSubmit = onCall(authed(async (uid, data) =>
  submitRound({
    playerId: uid,
    roundId: String(data.roundId || ''),
    // Deliberately optional. The trace is the evidence; the claim is only ever
    // compared against what the replay produces.
    claimedScore: Number.isFinite(Number(data.score)) ? Number(data.score) : null,
    trace: String(data.trace || ''),
  })
));

// ── Mock payments ───────────────────────────────────────────────────────────

/**
 * Mock deposit. The brief asks for mock functions to move a balance, with no
 * real payment provider — this is the whole of "payments".
 *
 * It still goes through the ledger like everything else. Even fake money leaves
 * an auditable row.
 */
exports.mockDeposit = onCall(authed(async (uid, data) => {
  const amountCents = Number(data.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 50000) {
    throw new HttpsError('invalid-argument', 'amountCents must be 1..50000');
  }

  return transaction(async (client) => {
    await client.query(
      `insert into players (player_id, display_name)
       values ($1, $2) on conflict (player_id) do nothing`,
      [uid, 'Player']
    );
    const posted = await ledger.deposit(client, {
      playerId: uid,
      amountCents,
      // Client-supplied so a retry is safe, namespaced by uid so one player
      // cannot collide with — or replay — another's key.
      idempotencyKey: `deposit:${uid}:${String(data.idempotencyKey || Date.now())}`,
    });
    return { balanceCents: posted.balanceCents, applied: posted.applied };
  });
}));

// ── Sweeper ─────────────────────────────────────────────────────────────────

/**
 * Resolve rounds whose player never came back.
 *
 * Every minute. The brief's rule that an entry must never silently disappear
 * with the player's money is only true if something runs on a timer.
 */
exports.sweepRounds = onSchedule('every 1 minutes', async () => {
  const result = await sweepStaleRounds();
  if (result.swept > 0 || result.failed > 0) {
    console.log(`[sweep] settled ${result.swept}, failed ${result.failed}`);
  }
});

/**
 * Manual trigger for the same sweep.
 *
 * The emulator registers scheduled functions but does not fire them on a timer,
 * so without this the sweeper could not be demonstrated locally — and it is one
 * of the more interesting things to show working.
 */
exports.sweepNow = onCall(async () => sweepStaleRounds());
