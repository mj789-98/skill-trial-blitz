/**
 * Cloud Functions entry point.
 *
 * JavaScript, not TypeScript, per the brief.
 *
 * Every callable is thin on purpose: verify the caller, validate the input, then
 * hand off to a module that owns the rule. Nothing that moves money lives here —
 * that is money/ledger.js, and the round loop is under blitz/.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { query } = require('./db');

/**
 * Health check. Exists to prove the whole chain end to end — Functions runtime,
 * the pg pool, the network path to Postgres — rather than any one part of it.
 */
exports.ping = onCall(async () => {
  const started = Date.now();
  const { rows } = await query(
    'select current_database() as db, version() as version, now() as at'
  );
  return {
    ok: true,
    database: rows[0].db,
    postgres: String(rows[0].version).split(',')[0],
    roundTripMs: Date.now() - started,
  };
});

/**
 * The games the lobby can show, and whether Blitz is switched on for each.
 *
 * blitz_enabled is read from the database rather than compiled in, which is what
 * makes Blitz a per-game toggle rather than something hard-wired to Chicken Run.
 */
exports.listGames = onCall(async () => {
  const { rows } = await query(
    `select game_id, display_name, blitz_enabled
       from games
      where enabled
      order by sort_order`
  );
  return { games: rows };
});
