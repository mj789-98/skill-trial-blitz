'use strict';

/**
 * Integration tests for the Blitz round loop, against a real PostgreSQL.
 *
 *   docker compose up -d
 *   npm --prefix functions run db:reset
 *   npm --prefix functions test
 *
 * Skips itself when no database is reachable.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PG_DATABASE = process.env.PG_DATABASE || 'skilltrial';
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'devpass';

const { query, transaction, getPool } = require('../db');
const ledger = require('../money/ledger');
const { createQuote } = require('../blitz/quote');
const { enterRound } = require('../blitz/enter');

const PLAYER = 'blitz-itest';
const GAME = 'chicken_run';

let available = false;

before(async () => {
  try {
    await query('select 1');
    available = true;
  } catch {
    console.warn('[itest] no database reachable — skipping. Run: docker compose up -d');
  }
});

function dbTest(name, fn) {
  test(name, async (t) => {
    if (!available) return t.skip('no database reachable');
    return fn(t);
  });
}

/** Wipe this player's world and give them a known balance. */
async function reset(startingCents) {
  await transaction(async (c) => {
    await c.query('delete from blitz_rounds where player_id = $1', [PLAYER]);
    await c.query('delete from blitz_quotes where player_id = $1', [PLAYER]);
    await c.query('delete from blitz_profiles where player_id = $1', [PLAYER]);
    await c.query('delete from ledger_entries where player_id = $1', [PLAYER]);
    await c.query('delete from players where player_id = $1', [PLAYER]);
    await c.query(
      'insert into players (player_id, display_name, cash_cents) values ($1, $2, 0)',
      [PLAYER, 'Blitz Integration']
    );
    if (startingCents > 0) {
      await ledger.deposit(c, {
        playerId: PLAYER, amountCents: startingCents,
        idempotencyKey: `blitz-itest:seed:${Date.now()}:${Math.random()}`,
      });
    }
  });
}

/** Let a player past the capped bootstrap window so full stakes are quotable. */
async function graduate(recentScores = [20, 22, 25, 21, 24]) {
  await query(
    `insert into blitz_profiles
       (player_id, game_id, rounds_played, bootstrap_used, target_score,
        best_score, recent_scores)
     values ($1, $2, 10, 99, 20, $3, $4::jsonb)
     on conflict (player_id, game_id) do update
       set bootstrap_used = 99, rounds_played = 10, target_score = 20,
           best_score = excluded.best_score, recent_scores = excluded.recent_scores`,
    [PLAYER, GAME, Math.max(...recentScores), JSON.stringify(recentScores)]
  );
}

after(async () => {
  if (!available) return;
  await query('delete from blitz_rounds where player_id = $1', [PLAYER]);
  await query('delete from blitz_quotes where player_id = $1', [PLAYER]);
  await query('delete from blitz_profiles where player_id = $1', [PLAYER]);
  await query('delete from ledger_entries where player_id = $1', [PLAYER]);
  await query('delete from players where player_id = $1', [PLAYER]);
  await getPool().end();
});

// ── quote ───────────────────────────────────────────────────────────────────

dbTest('a quote moves no money', async () => {
  await reset(1000);
  await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 100 });
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1000);
});

dbTest('Blitz is refused on a game where the toggle is off', async () => {
  await reset(1000);
  await assert.rejects(
    () => createQuote({ playerId: PLAYER, gameId: 'pop_shot', stakeCents: 100 }),
    (e) => e.code === 'BLITZ_NOT_ENABLED'
  );
});

dbTest('break-even on the quoted curve returns exactly the stake', async () => {
  // The screen labels a score "break even". A player who hits it must not lose
  // money, or the screen lied to them.
  await reset(5000);
  await graduate();
  for (const stake of [100, 300, 500, 1000, 2000]) {
    const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: stake });
    const atBreakEven = q.curve.find((p) => p.score >= q.breakEvenScore);
    assert.ok(atBreakEven.payoutCents >= stake,
      `break-even paid ${atBreakEven.payoutCents} on a ${stake} stake`);
  }
});

dbTest('only one quote per player+game stays enterable', async () => {
  await reset(1000);
  await graduate();
  for (let i = 0; i < 3; i++) {
    await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 100 });
  }
  const { rows } = await query(
    `select count(*)::int as open from blitz_quotes
      where player_id = $1 and superseded_at is null and consumed_by_round is null`,
    [PLAYER]
  );
  assert.equal(rows[0].open, 1);
});

// ── enter ───────────────────────────────────────────────────────────────────

dbTest('entering debits the stake and locks the curve onto the round', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  assert.equal(r.stakeCents, 300);
  assert.equal(r.balanceCents, 700);

  const round = await query('select curve from blitz_rounds where round_id = $1', [r.roundId]);
  const quote = await query('select curve from blitz_quotes where quote_id = $1', [q.quoteId]);
  // The whole "paid on the curve you were shown" guarantee, in one assertion.
  assert.deepEqual(round.rows[0].curve, quote.rows[0].curve);
});

dbTest('the seed is issued by the server, not the client', async () => {
  await reset(1000);
  await graduate();
  const seeds = new Set();
  for (let i = 0; i < 5; i++) {
    const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 100 });
    const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
    seeds.add(r.seed);
  }
  // Distinct seeds mean a player cannot re-enter to farm one easy board.
  assert.ok(seeds.size >= 4, `expected varied seeds, got ${seeds.size} distinct`);
});

dbTest('entering the same quote twice charges once', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });

  const first = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  const second = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  assert.equal(second.alreadyStarted, true);
  assert.equal(second.roundId, first.roundId);
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 700);
});

dbTest('CONCURRENT entries on one quote charge exactly once', async () => {
  // The double tap on Play, genuinely in parallel.
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      enterRound({ playerId: PLAYER, quoteId: q.quoteId })
        .catch((e) => ({ error: e.code || e.message }))
    )
  );

  const errors = results.filter((r) => r.error);
  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);

  const rounds = new Set(results.map((r) => r.roundId));
  assert.equal(rounds.size, 1, 'one quote produced more than one round');

  const { rows } = await query(
    `select count(*)::int as n from ledger_entries
      where player_id = $1 and kind = 'stake'`, [PLAYER]
  );
  assert.equal(rows[0].n, 1, 'charged more than once');
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 700);
});

dbTest('insufficient balance is refused with the numbers the screen needs', async () => {
  await reset(50);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  assert.equal(q.affordable, false, 'the quote should already know it is unaffordable');

  await assert.rejects(
    () => enterRound({ playerId: PLAYER, quoteId: q.quoteId }),
    (e) => e.code === 'INSUFFICIENT_BALANCE' &&
           e.balanceCents === 50 && e.requiredCents === 300
  );

  // Nothing partial: no round, no debit.
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 50);
  const { rows } = await query(
    'select count(*)::int as n from blitz_rounds where player_id = $1', [PLAYER]
  );
  assert.equal(rows[0].n, 0, 'a refused entry still created a round');
});

dbTest('an expired quote cannot be entered', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  // Reach into the past rather than waiting 180 seconds.
  await query(
    "update blitz_quotes set expires_at = now() - interval '1 second' where quote_id = $1",
    [q.quoteId]
  );
  await assert.rejects(
    () => enterRound({ playerId: PLAYER, quoteId: q.quoteId }),
    (e) => e.code === 'QUOTE_EXPIRED'
  );
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1000);
});

dbTest('a superseded quote cannot be entered', async () => {
  await reset(1000);
  await graduate();
  const stale = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 }); // supersedes it

  await assert.rejects(
    () => enterRound({ playerId: PLAYER, quoteId: stale.quoteId }),
    (e) => e.code === 'QUOTE_SUPERSEDED'
  );
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1000);
});

dbTest('a quote cannot be entered by a different player', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  await assert.rejects(
    () => enterRound({ playerId: 'dev-test-player', quoteId: q.quoteId }),
    (e) => e.code === 'QUOTE_NOT_YOURS'
  );
});

dbTest('the bootstrap allowance is consumed at ENTRY, not at settlement', async () => {
  // The anti-farm: a player must not be able to spend the capped starter rounds,
  // abandon the bad ones, and still hold the allowance.
  await reset(1000);
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 100 });
  assert.equal(q.bootstrap, true);
  await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  const { rows } = await query(
    'select bootstrap_used from blitz_profiles where player_id = $1 and game_id = $2',
    [PLAYER, GAME]
  );
  // Consumed even though the round was never played or settled.
  assert.equal(Number(rows[0].bootstrap_used), 1);
});

dbTest('the ledger still reconciles after the whole entry flow', async () => {
  await reset(2000);
  await graduate();
  for (let i = 0; i < 3; i++) {
    const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
    await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  }
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), 1100);
  assert.deepEqual(await transaction((c) => ledger.reconcile(c)), []);
});
