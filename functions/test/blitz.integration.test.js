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
const { recordHeartbeat } = require('../blitz/heartbeat');
const { submitRound } = require('../blitz/submit');
const { sweepStaleRounds } = require('../blitz/sweep');

/**
 * Fixed traces, replayed by the submit tests.
 *
 * Both were produced by running the real simulation over seed 3 and recording
 * what came out, so they are genuine legal traces rather than hand-written
 * blobs. The tests pin each round onto that seed, since enter() issues a random
 * one and a trace is only valid against the world it was played in.
 */
const GOOD = { seed: '3', trace: 'BgABBgABBgABBgABBgABBgABBgAF', score: 6 };
const DEAD = { seed: '3', trace: 'BgABBgABBgABBgABBgABBgABBgABBgABBgABBgABBgABBgABBgABBgABBgAF', score: 0 };

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
  // Sets the toggle itself rather than relying on a game that happens to ship
  // with it off. The first version of this test used pop_shot as its example
  // and broke the day Pop Shot became playable — which is a test coupled to
  // seed data rather than to the behaviour it claims to check.
  await reset(1000);
  await query("update games set blitz_enabled = false where game_id = 'pop_shot'");
  try {
    await assert.rejects(
      () => createQuote({ playerId: PLAYER, gameId: 'pop_shot', stakeCents: 100 }),
      (e) => e.code === 'BLITZ_NOT_ENABLED'
    );
  } finally {
    await query("update games set blitz_enabled = true where game_id = 'pop_shot'");
  }
});

dbTest('a game with the toggle ON can be quoted, whichever game it is', async () => {
  // The other half of the same claim: the toggle is a real per-game switch, not
  // something hard-wired to Chicken Run. Pop Shot has its own config row and its
  // own curve, and quoting it must go through the same code path.
  await reset(1000);
  const q = await createQuote({ playerId: PLAYER, gameId: 'pop_shot', stakeCents: 100 });
  assert.equal(q.gameId, 'pop_shot');
  assert.ok(q.curve.length > 1);
  assert.ok(q.breakEvenScore < q.targetScore, 'break-even was not below the target');
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

// ── heartbeat ───────────────────────────────────────────────────────────────

dbTest('a heartbeat only ever raises the stored score', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 4, tick: 200 });
  const back = await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 2, tick: 300 });

  assert.equal(back.accepted, false, 'a lower score was accepted');
  const { rows } = await query(
    'select heartbeat_score from blitz_rounds where round_id = $1', [r.roundId]
  );
  assert.equal(Number(rows[0].heartbeat_score), 4);
});

dbTest('an implausible heartbeat is CLAMPED to what elapsed time allows', async () => {
  // The cheapest attack in the system: claim an enormous score, never submit,
  // and let the sweeper pay it. The simulation refuses inputs faster than one
  // per 120ms, so the server bounds the claim using its own clock.
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  const hb = await recordHeartbeat({
    playerId: PLAYER, roundId: r.roundId, score: 999999, tick: 10,
  });

  assert.equal(hb.clamped, true, 'an absurd score was stored unclamped');
  assert.ok(hb.heartbeatScore < 100,
    `clamp let through ${hb.heartbeatScore} on a brand new round`);
});

// ── submit ──────────────────────────────────────────────────────────────────

/** Force a round onto the seed the known-good traces were built against. */
async function pinSeed(roundId) {
  await query('update blitz_rounds set seed = $2 where round_id = $1', [roundId, GOOD.seed]);
}

/** What the quoted curve says a score is worth — computed from the QUOTE. */
function expectedPayout(quote, score) {
  let bp = quote.curve[0].multBp;
  for (const p of quote.curve) if (score >= p.score) bp = p.multBp;
  // interpolate the same way the server does
  for (let i = 1; i < quote.curve.length; i++) {
    const hi = quote.curve[i], lo = quote.curve[i - 1];
    if (score > lo.score && score < hi.score) {
      const span = hi.score - lo.score;
      bp = lo.multBp + Math.floor(((hi.multBp - lo.multBp) * (score - lo.score)) / span);
    }
  }
  return Math.floor((quote.stakeCents * bp) / 10000);
}

dbTest('submit settles on the REPLAYED score, not the claimed one', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);

  // The client lies, extravagantly.
  const out = await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: 400, trace: GOOD.trace,
  });

  assert.equal(out.score, GOOD.score, 'the server trusted the client');
  assert.equal(out.claimedScore, 400);
  assert.equal(out.scoreMismatch, true);
  assert.equal(out.endReason, 'cash_out');
});

dbTest('the payout uses the ROUND curve even after the config changes', async () => {
  // The strongest statement of "paid on the curve you were shown": enter, then
  // move the target engine underneath the player, then settle. The payout must
  // be unchanged, because settlement can only reach blitz_rounds.curve.
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);

  const expected = expectedPayout(q, GOOD.score);

  const original = await query(
    'select params from blitz_configs where game_id = $1 and is_active', [GAME]
  );
  // Wreck the live config and the profile AFTER entry.
  await query(
    `update blitz_configs
        set params = jsonb_set(params, '{curve,cap_multiplier}', '0.1')
      where game_id = $1 and is_active`, [GAME]
  );
  await query(
    'update blitz_profiles set target_score = 9999 where player_id = $1 and game_id = $2',
    [PLAYER, GAME]
  );

  const out = await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: GOOD.score, trace: GOOD.trace,
  });

  await query(
    'update blitz_configs set params = $2 where game_id = $1 and is_active',
    [GAME, original.rows[0].params]
  );

  assert.equal(out.payoutCents, expected,
    'the payout moved when the config did — the locked curve was not honoured');
});

dbTest('submitting twice pays once and returns the same result', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);

  const first = await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: GOOD.score, trace: GOOD.trace,
  });
  const second = await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: GOOD.score, trace: GOOD.trace,
  });

  assert.equal(second.alreadySettled, true);
  assert.equal(second.payoutCents, first.payoutCents);
  assert.equal(second.balanceCents, first.balanceCents);

  const { rows } = await query(
    "select count(*)::int as n from ledger_entries where kind = 'payout' and round_id = $1",
    [r.roundId]
  );
  assert.equal(rows[0].n, 1, 'paid out more than once');
});

dbTest('CONCURRENT submits settle exactly once', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      submitRound({
        playerId: PLAYER, roundId: r.roundId, claimedScore: GOOD.score, trace: GOOD.trace,
      }).catch((e) => ({ error: e.code || e.message }))
    )
  );

  const errors = results.filter((x) => x.error);
  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);

  const payouts = new Set(results.map((x) => x.payoutCents));
  assert.equal(payouts.size, 1, 'concurrent submits disagreed about the payout');

  const { rows } = await query(
    "select count(*)::int as n from ledger_entries where kind = 'payout' and round_id = $1",
    [r.roundId]
  );
  assert.equal(rows[0].n, 1);
});

dbTest('a garbage trace settles at the acknowledged heartbeat, not the claim', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 3, tick: 400 });

  const out = await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: 500, trace: 'not-a-real-trace!!',
  });

  assert.equal(out.settleReason, 'invalid_trace');
  assert.equal(out.score, 3, 'a garbage trace was paid on the claimed score');

  // Exactly one outcome — the round is not left hanging for a client to retry.
  const { rows } = await query(
    'select status from blitz_rounds where round_id = $1', [r.roundId]
  );
  assert.equal(rows[0].status, 'settled');
});

dbTest('a losing run settles at zero and still writes a payout row', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);

  const out = await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: 0, trace: DEAD.trace,
  });

  assert.equal(out.score, 0, 'a death paid out a score');
  assert.equal(out.payoutCents, 0);
  assert.equal(out.netCents, -300);

  // A loss must be auditable, and distinguishable from a round never settled.
  const { rows } = await query(
    "select count(*)::int as n from ledger_entries where kind = 'payout' and round_id = $1",
    [r.roundId]
  );
  assert.equal(rows[0].n, 1, 'a loss left no auditable row');
});

dbTest('the profile ratchets on the VALIDATED score, not the claimed one', async () => {
  await reset(1000);
  await graduate([5, 5, 5, 5, 5]);
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);

  await submitRound({
    playerId: PLAYER, roundId: r.roundId, claimedScore: 9999, trace: GOOD.trace,
  });

  const { rows } = await query(
    'select recent_scores from blitz_profiles where player_id = $1 and game_id = $2',
    [PLAYER, GAME]
  );
  const recent = rows[0].recent_scores.map(Number);
  assert.equal(recent[0], GOOD.score, 'a claimed score entered the profile');
  assert.ok(!recent.includes(9999));
});

dbTest('the ledger reconciles after full quote -> enter -> submit cycles', async () => {
  await reset(2000);
  await graduate();
  for (let i = 0; i < 3; i++) {
    const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
    const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
    await pinSeed(r.roundId);
    await submitRound({
      playerId: PLAYER, roundId: r.roundId, claimedScore: GOOD.score, trace: GOOD.trace,
    });
  }
  assert.deepEqual(await transaction((c) => ledger.reconcile(c)), []);
});

// ── sweep ───────────────────────────────────────────────────────────────────

/** Drag a round's deadline into the past so the sweeper will pick it up. */
async function expire(roundId) {
  await query(
    "update blitz_rounds set deadline_at = now() - interval '1 second' where round_id = $1",
    [roundId]
  );
}

dbTest('an abandoned round is settled at the acknowledged score', async () => {
  // The app was killed mid-round. The stake is already gone; something has to
  // decide the outcome, or the money silently disappears.
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 5, tick: 600 });
  await expire(r.roundId);

  const out = await sweepStaleRounds();
  const mine = out.results.find((x) => x.roundId === r.roundId);

  assert.equal(mine.skipped, false);
  assert.equal(mine.score, 5, 'did not settle at the acknowledged heartbeat');
  assert.equal(mine.settleReason, 'sweep');

  const { rows } = await query(
    'select status, settle_reason from blitz_rounds where round_id = $1', [r.roundId]
  );
  assert.equal(rows[0].status, 'settled');
  assert.equal(rows[0].settle_reason, 'sweep');
});

dbTest('a round still inside its deadline is left alone', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  await sweepStaleRounds();

  const { rows } = await query(
    'select status from blitz_rounds where round_id = $1', [r.roundId]
  );
  assert.equal(rows[0].status, 'active', 'the sweeper settled a live round');
});

dbTest('sweeping twice pays once', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 5, tick: 600 });
  await expire(r.roundId);

  await sweepStaleRounds();
  const balanceAfterFirst = await transaction((c) => ledger.balance(c, PLAYER));

  const second = await sweepStaleRounds();
  assert.equal(
    second.results.filter((x) => x.roundId === r.roundId && !x.skipped).length, 0,
    'the second sweep settled an already-settled round'
  );
  assert.equal(await transaction((c) => ledger.balance(c, PLAYER)), balanceAfterFirst);

  const { rows } = await query(
    "select count(*)::int as n from ledger_entries where kind = 'payout' and round_id = $1",
    [r.roundId]
  );
  assert.equal(rows[0].n, 1);
});

dbTest('a submit RACING the sweeper produces exactly one payout', async () => {
  // The genuine race the design has to survive: the player's app reconnects and
  // submits at the same instant the scheduled sweeper fires. Two independent
  // processes, both entitled to settle the round.
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await pinSeed(r.roundId);
  await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 2, tick: 300 });
  await expire(r.roundId);

  const [submitted, swept] = await Promise.all([
    submitRound({
      playerId: PLAYER, roundId: r.roundId, claimedScore: GOOD.score, trace: GOOD.trace,
    }).catch((e) => ({ error: e.code || e.message })),
    sweepStaleRounds().catch((e) => ({ error: e.code || e.message })),
  ]);

  assert.ok(!submitted.error, `submit errored: ${submitted.error}`);
  assert.ok(!swept.error, `sweep errored: ${swept.error}`);

  // Exactly one payout row, whichever of them got there first.
  const { rows } = await query(
    "select count(*)::int as n from ledger_entries where kind = 'payout' and round_id = $1",
    [r.roundId]
  );
  assert.equal(rows[0].n, 1, 'the race produced more than one payout');

  const st = await query(
    'select status, settle_reason from blitz_rounds where round_id = $1', [r.roundId]
  );
  assert.equal(st.rows[0].status, 'settled');
  // Either is a legitimate winner; what matters is that only one paid.
  assert.ok(['submit', 'sweep'].includes(st.rows[0].settle_reason));

  assert.deepEqual(await transaction((c) => ledger.reconcile(c)), []);
});

dbTest('a round abandoned before scoring settles at zero, not in limbo', async () => {
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
  await expire(r.roundId); // never a single heartbeat

  const out = await sweepStaleRounds();
  const mine = out.results.find((x) => x.roundId === r.roundId);

  assert.equal(mine.score, 0);
  assert.equal(mine.payoutCents, 0);

  // The money did not vanish: there is a stake row AND a payout row to point at.
  const { rows } = await query(
    `select kind, amount_cents from ledger_entries
      where round_id = $1 order by entry_id`, [r.roundId]
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'stake');
  assert.equal(Number(rows[0].amount_cents), -300);
  assert.equal(rows[1].kind, 'payout');
  assert.equal(Number(rows[1].amount_cents), 0);
});

dbTest('the sweeper cannot pay above what elapsed time allows', async () => {
  // Defence in depth: even if a heartbeat were written by an older build, or
  // straight into the table, settlement re-applies the physical bound.
  await reset(1000);
  await graduate();
  const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
  const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });

  // Write an absurd heartbeat directly, bypassing the clamp in heartbeat.js.
  await query(
    'update blitz_rounds set heartbeat_score = 999999 where round_id = $1', [r.roundId]
  );
  await expire(r.roundId);

  const out = await sweepStaleRounds();
  const mine = out.results.find((x) => x.roundId === r.roundId);
  assert.ok(mine.score < 1000,
    `the sweeper paid an implausible ${mine.score} on a seconds-old round`);
});

dbTest('one unsettleable round does not block the rest of the batch', async () => {
  await reset(3000);
  await graduate();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const q = await createQuote({ playerId: PLAYER, gameId: GAME, stakeCents: 300 });
    const r = await enterRound({ playerId: PLAYER, quoteId: q.quoteId });
    await recordHeartbeat({ playerId: PLAYER, roundId: r.roundId, score: 2, tick: 300 });
    await expire(r.roundId);
    ids.push(r.roundId);
  }

  // Point the middle round at a game with no validator and no config, so its
  // settlement path fails.
  await query("update blitz_rounds set game_id = 'pop_shot' where round_id = $1", [ids[1]]);

  const out = await sweepStaleRounds();

  const settled = await query(
    `select round_id, status from blitz_rounds where round_id = any($1::uuid[])`, [ids]
  );
  const byId = Object.fromEntries(settled.rows.map((x) => [x.round_id, x.status]));

  assert.equal(byId[ids[0]], 'settled', 'a healthy round was blocked by a broken sibling');
  assert.equal(byId[ids[2]], 'settled', 'a healthy round was blocked by a broken sibling');
  assert.ok(out.swept >= 2);
});
