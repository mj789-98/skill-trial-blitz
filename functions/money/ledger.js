/**
 * The ledger. The ONLY module in this codebase that writes a balance.
 *
 * Everything that moves money goes through `post()`. Nothing else may UPDATE
 * players.cash_cents — if you find another query doing it, that is the bug.
 *
 * ── The invariant ────────────────────────────────────────────────────────────
 *
 *     sum(ledger_entries.amount_cents) == players.cash_cents
 *
 * for every player, always. `ledger_entries` is the truth and `cash_cents` is a
 * cached running total kept in step inside the same transaction. `reconcile()`
 * asserts it, and the integration tests run it after every scenario.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * Every post carries an `idempotencyKey`, and the database has a UNIQUE index on
 * it. Posting the same key twice applies the money ONCE and returns the original
 * entry the second time.
 *
 * That is done with `ON CONFLICT DO NOTHING` rather than by catching the unique
 * violation. In PostgreSQL a constraint violation aborts the entire transaction,
 * so a try/catch around the INSERT would leave the caller holding a dead
 * transaction it could not commit — the settlement would fail precisely when it
 * was doing the right thing. `ON CONFLICT` does not raise, so the transaction
 * survives and the caller can carry on.
 *
 * ── Locking ──────────────────────────────────────────────────────────────────
 *
 * The player row is locked FOR UPDATE before the balance is read, because the
 * new balance is computed from the old one. Without the lock, two concurrent
 * stakes both read 500, both write 200, and the player has spent 600 from a 500
 * balance. The row lock is what makes read-then-write safe.
 */

'use strict';

/** Money leaves the player on these. Mirrors the CHECK constraint in the schema. */
const NEGATIVE_KINDS = new Set(['stake', 'withdrawal']);

/**
 * Post one movement to the ledger and update the cached balance.
 *
 * MUST be called inside a `transaction()` — it takes a client, not a pool. The
 * caller owns the transaction, because a stake and the round it pays for have to
 * commit together or not at all.
 *
 * @param {object} client            pg client, inside an open transaction
 * @param {object} o
 * @param {string} o.playerId
 * @param {string} o.kind            deposit | withdrawal | stake | payout | refund | adjustment
 * @param {number} o.amountCents     MAGNITUDE, always positive. The sign is derived
 *                                   from `kind`, so a caller cannot get it backwards.
 * @param {string} o.idempotencyKey  e.g. `stake:<roundId>`, `payout:<roundId>`
 * @param {string} [o.roundId]
 * @param {string} [o.memo]
 * @returns {Promise<{entry: object, applied: boolean, balanceCents: number}>}
 *          `applied` is false when this key had already been posted.
 */
async function post(client, o) {
  const { playerId, kind, amountCents, idempotencyKey, roundId = null, memo = null } = o;

  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error(`amountCents must be a non-negative integer, got ${amountCents}`);
  }
  if (!idempotencyKey) throw new Error('idempotencyKey is required');

  // The caller passes a magnitude; the sign comes from the kind. A caller cannot
  // accidentally credit a stake, which is the sort of mistake that is invisible
  // in review and obvious in the balance sheet.
  const signed = NEGATIVE_KINDS.has(kind) ? -amountCents : amountCents;

  // Lock FIRST, then read. See the note above.
  const locked = await client.query(
    'select cash_cents from players where player_id = $1 for update',
    [playerId]
  );
  if (locked.rowCount === 0) throw new Error(`no such player: ${playerId}`);

  const before = Number(locked.rows[0].cash_cents);
  const after = before + signed;

  // Check before writing so the caller gets a meaningful error rather than a
  // constraint violation from the depths of Postgres. The CHECK on the column is
  // still the real guarantee — this is just a better message.
  if (after < 0) {
    const err = new Error(
      `insufficient balance: ${playerId} has ${before}c, tried to move ${signed}c`
    );
    err.code = 'INSUFFICIENT_BALANCE';
    err.balanceCents = before;
    err.requiredCents = -signed;
    throw err;
  }

  const inserted = await client.query(
    `insert into ledger_entries
       (player_id, kind, amount_cents, balance_after_cents, round_id, idempotency_key, memo)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (idempotency_key) do nothing
     returning *`,
    [playerId, kind, signed, after, roundId, idempotencyKey, memo]
  );

  if (inserted.rowCount === 0) {
    // Already posted. Return the original entry and touch nothing — this is the
    // retry, the double tap, or the sweeper racing the client.
    const existing = await client.query(
      'select * from ledger_entries where idempotency_key = $1',
      [idempotencyKey]
    );
    return {
      entry: existing.rows[0],
      applied: false,
      balanceCents: before,
    };
  }

  await client.query(
    'update players set cash_cents = $1 where player_id = $2',
    [after, playerId]
  );

  return { entry: inserted.rows[0], applied: true, balanceCents: after };
}

/** Current balance, in integer cents. */
async function balance(client, playerId) {
  const { rows } = await client.query(
    'select cash_cents from players where player_id = $1',
    [playerId]
  );
  if (rows.length === 0) throw new Error(`no such player: ${playerId}`);
  return Number(rows[0].cash_cents);
}

/**
 * Assert the ledger and the cached balance agree.
 *
 * The cached balance exists only so that reading it is one indexed lookup rather
 * than a sum over every entry a player has ever made. That optimisation is only
 * safe while the two agree, so this is run after every integration scenario. If
 * it ever fails, the ledger is right and cash_cents is wrong.
 *
 * @returns {Promise<Array<{playerId: string, cached: number, summed: number}>>}
 *          the players that disagree — empty means healthy.
 */
async function reconcile(client) {
  const { rows } = await client.query(
    `select p.player_id,
            p.cash_cents::bigint                       as cached,
            coalesce(sum(l.amount_cents), 0)::bigint   as summed
       from players p
       left join ledger_entries l on l.player_id = p.player_id
      group by p.player_id, p.cash_cents
     having p.cash_cents <> coalesce(sum(l.amount_cents), 0)`
  );
  return rows.map((r) => ({
    playerId: r.player_id,
    cached: Number(r.cached),
    summed: Number(r.summed),
  }));
}

/**
 * Mock deposit. The brief asks for mock functions to move a balance, with no
 * real payment provider — so this is the whole of "payments".
 *
 * It goes through `post()` like everything else rather than writing the balance
 * directly, which is the point: even fake money obeys the ledger.
 */
async function deposit(client, { playerId, amountCents, idempotencyKey, memo = 'mock deposit' }) {
  return post(client, { playerId, kind: 'deposit', amountCents, idempotencyKey, memo });
}

async function withdraw(client, { playerId, amountCents, idempotencyKey, memo = 'mock withdrawal' }) {
  return post(client, { playerId, kind: 'withdrawal', amountCents, idempotencyKey, memo });
}

module.exports = { post, balance, reconcile, deposit, withdraw };
