'use strict';

/**
 * Integration tests for the ledger, against a REAL PostgreSQL.
 *
 * These are not unit tests with a fake database, and that is the whole point.
 * The guarantees being tested — idempotency, atomicity, safe concurrent reads —
 * are enforced by Postgres, not by JavaScript. A mock would only test that the
 * mock agrees with itself.
 *
 * Requires the local database:
 *   docker compose up -d
 *   npm --prefix functions run db:reset
 *
 * Skipped automatically when nothing is listening, so `npm test` still passes on
 * a machine without Docker rather than failing for the wrong reason.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PG_DATABASE = process.env.PG_DATABASE || 'skilltrial';
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'devpass';

const { query, transaction, getPool } = require('../db');
const ledger = require('../money/ledger');

const PLAYER = 'itest-player';

async function databaseReachable() {
  try {
    await query('select 1');
    return true;
  } catch {
    return false;
  }
}

// Determined in a before() hook rather than at module scope: a top-level await
// would make Node treat this CommonJS file as an ES module and require() would
// stop working.
let available = false;

before(async () => {
  available = await databaseReachable();
  if (!available) {
    console.warn('[itest] no database reachable — skipping. Run: docker compose up -d');
  }
});

/** Registers a test that skips itself when there is no database. */
function dbTest(name, fn) {
  test(name, async (t) => {
    if (!available) return t.skip('no database reachable');
    return fn(t);
  });
}

/** Fresh player with a known balance, seeded through the ledger like any other money. */
async function resetPlayer(startingCents) {
  await transaction(async (c) => {
    await c.query('delete from ledger_entries where player_id = $1', [PLAYER]);
    await c.query('delete from players where player_id = $1', [PLAYER]);
    await c.query(
      'insert into players (player_id, display_name, cash_cents) values ($1, $2, 0)',
      [PLAYER, 'Integration Test']
    );
    if (startingCents > 0) {
      await ledger.deposit(c, {
        playerId: PLAYER,
        amountCents: startingCents,
        idempotencyKey: `itest:seed:${Date.now()}:${Math.random()}`,
      });
    }
  });
}

after(async () => {
  if (!available) return;
  await query('delete from ledger_entries where player_id = $1', [PLAYER]);
  await query('delete from players where player_id = $1', [PLAYER]);
  await getPool().end();
});

dbTest('a stake debits exactly once, however many times it is posted', async () => {
  await resetPlayer(1000);

  const key = 'stake:round-abc';
  for (let i = 0; i < 5; i++) {
    await transaction((c) =>
      ledger.post(c, {
        playerId: PLAYER, kind: 'stake', amountCents: 300, idempotencyKey: key,
      })
    );
  }

  const after = await transaction((c) => ledger.balance(c, PLAYER));
  assert.equal(after, 700, 'five identical posts moved more than one stake');

  const { rows } = await query(
    'select count(*)::int as n from ledger_entries where idempotency_key = $1', [key]
  );
  assert.equal(rows[0].n, 1);
});

dbTest('the second post returns the original entry and reports applied:false', async () => {
  await resetPlayer(1000);
  const key = 'payout:round-def';

  const first = await transaction((c) =>
    ledger.post(c, { playerId: PLAYER, kind: 'payout', amountCents: 450, idempotencyKey: key })
  );
  const second = await transaction((c) =>
    ledger.post(c, { playerId: PLAYER, kind: 'payout', amountCents: 450, idempotencyKey: key })
  );

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  // Same row, so a retry can safely be told what the original outcome was.
  assert.equal(second.entry.entry_id, first.entry.entry_id);
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1450);
});

dbTest('CONCURRENT identical settlements pay out exactly once', async () => {
  // The real race: the client submits at the same moment the sweeper resolves
  // the round. Both call settle with the same key, genuinely in parallel.
  await resetPlayer(0);
  const key = 'payout:round-race';

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      transaction((c) =>
        ledger.post(c, {
          playerId: PLAYER, kind: 'payout', amountCents: 250, idempotencyKey: key,
        })
      ).catch((e) => ({ error: e.message }))
    )
  );

  const applied = results.filter((r) => r.applied === true).length;
  const errors = results.filter((r) => r.error);

  assert.equal(applied, 1, `expected exactly one apply, got ${applied}`);
  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 250);
});

dbTest('CONCURRENT different stakes cannot overspend the balance', async () => {
  // Without FOR UPDATE both would read 500, both write 200, and the player
  // spends 600 from a 500 balance.
  await resetPlayer(500);

  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      transaction((c) =>
        ledger.post(c, {
          playerId: PLAYER, kind: 'stake', amountCents: 300,
          idempotencyKey: `stake:concurrent-${i}`,
        })
      ).catch((e) => ({ error: e.code || e.message }))
    )
  );

  const ok = results.filter((r) => r.applied === true).length;
  const refused = results.filter((r) => r.error === 'INSUFFICIENT_BALANCE').length;

  assert.equal(ok, 1, 'more than one 300c stake cleared a 500c balance');
  assert.equal(refused, 3);
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 200);
});

dbTest('a balance can never go negative', async () => {
  await resetPlayer(100);
  await assert.rejects(
    () => transaction((c) =>
      ledger.post(c, {
        playerId: PLAYER, kind: 'stake', amountCents: 500, idempotencyKey: 'stake:too-big',
      })
    ),
    (e) => e.code === 'INSUFFICIENT_BALANCE'
  );
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 100);
});

dbTest('a failed transaction leaves NO trace — atomicity', async () => {
  await resetPlayer(1000);

  // Debit, then throw. The ledger row and the balance change must both vanish.
  await assert.rejects(() =>
    transaction(async (c) => {
      await ledger.post(c, {
        playerId: PLAYER, kind: 'stake', amountCents: 300,
        idempotencyKey: 'stake:rolled-back',
      });
      throw new Error('settlement blew up after the debit');
    })
  );

  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1000);
  const { rows } = await query(
    'select count(*)::int as n from ledger_entries where idempotency_key = $1',
    ['stake:rolled-back']
  );
  assert.equal(rows[0].n, 0, 'a rolled-back transaction left a ledger row behind');
});

dbTest('the sign is derived from the kind, so a caller cannot get it backwards', async () => {
  await resetPlayer(1000);
  await transaction((c) =>
    ledger.post(c, {
      playerId: PLAYER, kind: 'stake', amountCents: 250, idempotencyKey: 'stake:sign',
    })
  );
  const { rows } = await query(
    'select amount_cents from ledger_entries where idempotency_key = $1', ['stake:sign']
  );
  assert.equal(Number(rows[0].amount_cents), -250);
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 750);
});

dbTest('post rejects a negative or fractional amount rather than coercing it', async () => {
  await resetPlayer(1000);
  for (const bad of [-100, 12.5, NaN]) {
    await assert.rejects(
      () => transaction((c) =>
        ledger.post(c, {
          playerId: PLAYER, kind: 'payout', amountCents: bad,
          idempotencyKey: `bad:${bad}`,
        })
      ),
      /non-negative integer/
    );
  }
});

dbTest('the ledger and the cached balance always agree', async () => {
  await resetPlayer(2000);

  await transaction(async (c) => {
    await ledger.post(c, { playerId: PLAYER, kind: 'stake', amountCents: 500, idempotencyKey: 'r:s1' });
    await ledger.post(c, { playerId: PLAYER, kind: 'payout', amountCents: 1200, idempotencyKey: 'r:p1' });
  });
  await transaction((c) =>
    ledger.post(c, { playerId: PLAYER, kind: 'refund', amountCents: 500, idempotencyKey: 'r:rf1' })
  );

  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 3200);

  const drift = await transaction((c) => ledger.reconcile(c));
  assert.deepEqual(drift, [], `ledger and balance disagree: ${JSON.stringify(drift)}`);
});

dbTest('a zero payout still writes a row — a loss is auditable too', async () => {
  // A losing round must leave evidence. "No row" and "not settled" have to be
  // distinguishable, or an unpaid round looks identical to a lost one.
  await resetPlayer(1000);
  const r = await transaction((c) =>
    ledger.post(c, {
      playerId: PLAYER, kind: 'payout', amountCents: 0,
      idempotencyKey: 'payout:lost-round', roundId: null, memo: 'score below break-even',
    })
  );
  assert.equal(r.applied, true);
  assert.equal(Number(r.entry.amount_cents), 0);
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1000);
});
