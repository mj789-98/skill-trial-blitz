/**
 * PostgreSQL Connection Pool for Firebase Cloud Functions
 *
 * Provided with the work-trial brief. Kept UNMODIFIED on purpose — it is the
 * production helper, and rewriting it would throw away the guard rails its
 * comments document.
 *
 * Usage:
 *   const { pool, query, transaction } = require('./db');
 *
 *   // Simple query
 *   const result = await query('SELECT * FROM players WHERE player_id = $1', [uid]);
 *
 *   // Transaction
 *   const result = await transaction(async (client) => {
 *     await client.query('UPDATE players SET gems = gems - $1 WHERE player_id = $2', [stake, uid]);
 *     const { rows } = await client.query('INSERT INTO matches ... RETURNING match_id');
 *     return rows[0];
 *   });
 */

const { Pool } = require('pg');
const functions = require('firebase-functions');

let pool = null;

function getPool() {
  if (!pool) {
    // process.env (per-project .env.<project-id> files) wins; functions.config()
    // is the deprecated fallback.
    const legacy = functions.config().pg || {};
    const config = {
      host: process.env.PG_HOST || legacy.host,
      port: process.env.PG_PORT || legacy.port,
      database: process.env.PG_DATABASE || legacy.database,
      user: process.env.PG_USER || legacy.user,
      password: process.env.PG_PASSWORD || legacy.password,
    };
    pool = new Pool({
      host: config.host,
      port: parseInt(config.port || '5432', 10),
      database: config.database || 'postgres',
      user: config.user,
      password: config.password,
      ssl: config.host ? { rejectUnauthorized: false } : false, // SSL for Supabase pooler, off for local
      // ── TRANSACTION-MODE POOLER (Supabase, port 6543) ─────────────────────────────
      // In transaction mode the pooler holds a backend only for the duration of a
      // transaction, so idle client connections cost a cheap client slot instead of
      // pinning a Postgres backend. That removes the session-mode connection ceiling.
      //
      // ⚠ TRANSACTION MODE FORBIDS SESSION STATE. A later statement may land on a
      // DIFFERENT backend, so these break — intermittently, only under load:
      //     • pg_advisory_lock() / pg_advisory_unlock()  → use pg_advisory_xact_lock()
      //     • bare `SET foo = ...`                       → use SET LOCAL, inside a txn
      //     • named prepared statements (pg `name:`)     → leave queries unnamed
      //     • temp tables, cursors held across txns, LISTEN/NOTIFY
      max: 2,                    // gen-1 concurrency is 1/instance; 2 covers parallel queries
      idleTimeoutMillis: 10000,  // idle client slots are cheap in txn mode, but don't hoard
      connectionTimeoutMillis: 10000, // note: pool exhaustion is an instant FATAL, not a timeout
      // ⚠ THESE TWO ARE SILENTLY IGNORED THROUGH THE POOLER. node-pg sends them as startup
      // parameters and the pooler does not forward client startup parameters to the backend,
      // so a pooled connection ignores them entirely. They are kept only because they DO
      // apply on a direct (non-pooled) connection. Server-side enforcement comes from
      // role-level settings (`ALTER ROLE ... SET statement_timeout` etc.) instead.
      statement_timeout: 25000,
      idle_in_transaction_session_timeout: 30000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  }
  return pool;
}

// Pool exhaustion is TRANSIENT and, through the pooler, arrives as an instant FATAL rather
// than a timeout — so connectionTimeoutMillis never covers it and a single attempt just
// fails the request.
// Retry ONLY connection acquisition: it happens before BEGIN, so a retry can never re-run
// a partially-applied transaction. Anything else (a real SQL error, a constraint
// violation) must propagate untouched.
const ACQUIRE_BACKOFF_MS = [80, 200, 500, 1200];

function isTransientAcquireError(e) {
  const m = String(e && e.message || '');
  return /EMAXCONNSESSION|max clients reached|too many clients|Connection terminated due to connection timeout|timeout exceeded when trying to connect/i.test(m);
}

async function connectWithRetry(p) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await p.connect();
    } catch (e) {
      if (!isTransientAcquireError(e) || attempt >= ACQUIRE_BACKOFF_MS.length) throw e;
      const wait = ACQUIRE_BACKOFF_MS[attempt] + Math.floor(Math.random() * 100);
      console.warn(`[db] pool acquire failed (${e.message}) — retry ${attempt + 1}/${ACQUIRE_BACKOFF_MS.length} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Execute a simple query
 * @param {string} text - SQL query with $1, $2, etc. placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<{rows: Array, rowCount: number}>}
 */
async function query(text, params) {
  const p = getPool();
  // Single statements go through an explicit checkout so they get the same acquire-retry
  // as transaction(). p.query() would acquire internally with no retry.
  const client = await connectWithRetry(p);
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Per-transaction guard rails, applied with SET LOCAL (see transaction() below).
// These duplicate the role-level settings documented above. That redundancy is deliberate:
// the role settings are the real floor, but they only reach a backend at login, so a fresh
// ALTER ROLE takes minutes to propagate through the pooler's long-lived backends. SET LOCAL
// runs INSIDE our own transaction, so it applies immediately, on every backend, and reverts
// at COMMIT/ROLLBACK — it cannot leak onto the next borrower the way a plain SET would.
const TX_STATEMENT_TIMEOUT = '25s';
// Caps the gap BETWEEN statements. Without it the backend default is 0 = no limit, so a
// Cloud Function killed mid-transaction (instance recycled, OOM, dropped pooler socket)
// leaves its row locks held INDEFINITELY, blocking every later request touching those rows.
// Kept at 10s: transactions here complete in well under a second, and no transaction may
// do network I/O while open.
const TX_IDLE_TIMEOUT = '10s';
// Caps TOTAL transaction duration (PostgreSQL 17+). statement_timeout and the idle timeout
// both miss the case of a steady stream of individually-fast statements, which can hold a
// FOR UPDATE lock indefinitely without ever tripping either one. This is the real backstop.
const TX_TRANSACTION_TIMEOUT = '30s';
// Fail fast instead of queueing behind someone else's stranded lock. Without this, a request
// that hits a held row lock burns the full statement_timeout holding a pool slot.
const TX_LOCK_TIMEOUT = '5s';

/**
 * Execute multiple queries in a transaction
 * @param {Function} callback - Async function receiving a client object
 * @returns {Promise<any>} - Return value from callback
 */
async function transaction(callback) {
  const p = getPool();
  const client = await connectWithRetry(p);
  // REQUIRED, not defensive. When the server terminates this session — the
  // idle-in-transaction reaper above, an admin pg_terminate_backend, a dropped pooler
  // socket — pg delivers a FATAL as an 'error' EVENT on the client. If no query is in
  // flight at that moment (i.e. we're between statements inside the callback) there is
  // no promise to reject, and an 'error' event with no listener is a hard Node crash
  // that takes the whole function instance down.
  let fatal = null;
  const onClientError = (e) => {
    fatal = e;
    console.error(`[db] session terminated mid-transaction: ${e.message}`);
  };
  client.on('error', onClientError);
  try {
    // Single simple-query round trip: BEGIN and all four guards travel together, so this
    // costs no extra latency versus a bare BEGIN. Only SET commands precede the callback,
    // so a callback may still legally open with SET TRANSACTION READ ONLY.
    await client.query(
      `BEGIN;
       SET LOCAL statement_timeout = '${TX_STATEMENT_TIMEOUT}';
       SET LOCAL idle_in_transaction_session_timeout = '${TX_IDLE_TIMEOUT}';
       SET LOCAL transaction_timeout = '${TX_TRANSACTION_TIMEOUT}';
       SET LOCAL lock_timeout = '${TX_LOCK_TIMEOUT}';`
    );
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // The server may already have killed this session, in which case ROLLBACK itself
    // throws. Swallow that so the ORIGINAL error propagates — otherwise the real cause
    // is replaced by a misleading "connection terminated".
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {
      console.warn(`ROLLBACK failed (connection likely already terminated): ${rollbackErr.message}`);
    }
    throw err;
  } finally {
    // Order matters: release() FIRST. pg-pool removes its own idle error listener while a
    // client is checked out and only re-attaches it inside _release(), so removing ours
    // before releasing leaves a window with no 'error' listener at all — and an 'error'
    // event with no listener is a hard process crash. Releasing first means the pool's
    // listener is already back in place before ours goes away.
    // Pass the error so a poisoned connection is DESTROYED rather than handed back to the
    // pool — returning a dead socket makes the next caller fail.
    client.release(fatal || undefined);
    client.removeListener('error', onClientError);
  }
}

module.exports = { getPool, query, transaction };
