/**
 * End-to-end: the callables through a REAL Firebase Auth token.
 *
 * The unit and integration tests call the modules directly, which means they
 * pass a playerId as an argument. This covers the one thing they structurally
 * cannot: that the uid actually arrives from a VERIFIED token, over HTTPS,
 * through the callable wrapper — and that a playerId in the request body buys
 * an attacker nothing.
 *
 * It is a script rather than a `node --test` file on purpose. It needs the
 * Firebase emulators and Postgres running, and a test suite that fails when a
 * service is not up teaches people to ignore red.
 *
 *   docker compose up -d
 *   npm --prefix functions run db:reset
 *   firebase emulators:start --only functions,auth --project demo-skill-trial
 *   npm --prefix functions run test:e2e
 */

'use strict';

const path = require('path');
const {
  encodeTrace, simulate, ACT_FORWARD, ACT_CASH_OUT, HOP_COOLDOWN_TICKS,
} = require(path.join(__dirname, '..', '..', 'functions', 'sim', 'chickenRun'));

const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const FN = 'http://127.0.0.1:5001/demo-skill-trial/us-central1';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function signIn(email, password) {
  const body = { email, password, returnSecureToken: true };
  let res = await fetch(`${AUTH}:signInWithPassword?key=demo-api-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    res = await fetch(`${AUTH}:signUp?key=demo-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  const json = await res.json();
  if (!json.idToken) throw new Error(`sign-in failed: ${JSON.stringify(json)}`);
  return { idToken: json.idToken, uid: json.localId };
}

async function call(name, data, idToken) {
  const headers = { 'content-type': 'application/json' };
  if (idToken) headers.authorization = `Bearer ${idToken}`;
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST', headers, body: JSON.stringify({ data: data || {} }),
  });
  const json = await res.json();
  if (json.error) {
    const err = new Error(json.error.message);
    err.status = json.error.status;
    err.details = json.error.details;
    throw err;
  }
  return json.result;
}

/** Build a trace that hops forward n times then banks, for this exact seed. */
function traceFor(seed, hops) {
  const events = [];
  for (let i = 1; i <= hops; i++) {
    events.push({ tick: i * HOP_COOLDOWN_TICKS, action: ACT_FORWARD });
  }
  events.push({ tick: (hops + 1) * HOP_COOLDOWN_TICKS, action: ACT_CASH_OUT });
  return encodeTrace(events);
}

/** Find the longest surviving run on this seed, so the round genuinely cashes out. */
function bestTrace(seed) {
  for (let hops = 14; hops >= 1; hops--) {
    const trace = traceFor(seed, hops);
    const out = simulate(seed, trace);
    if (out.reason === 'cash_out' && out.score > 0) return { trace, expected: out.score };
  }
  return { trace: traceFor(seed, 1), expected: 0 };
}

async function main() {
  // The same credentials the app signs in with, and the ones in the README.
  console.log('\n── auth ──────────────────────────────────────────────────────');
  const { idToken, uid } = await signIn('player@skilltrial.test', 'blitz-trial-2026');
  check('signed in against the Auth emulator', !!idToken, `uid ${uid.slice(0, 8)}…`);

  // The whole point of authed(): no uid in the body can substitute for a token.
  let rejected = false;
  try {
    await call('blitzQuote', { gameId: 'chicken_run', stakeCents: 100, playerId: uid }, null);
  } catch (err) {
    rejected = err.status === 'UNAUTHENTICATED';
  }
  check('an unauthenticated call is refused even with a playerId in the body', rejected);

  console.log('\n── lobby ─────────────────────────────────────────────────────');
  const { games } = await call('listGames', {}, idToken);
  const chicken = games.find((g) => g.game_id === 'chicken_run');
  check('listGames returns the stake tiers from the active config',
    Array.isArray(chicken.stakeTiersCents) && chicken.stakeTiersCents.length > 0,
    JSON.stringify(chicken.stakeTiersCents));
  check('pop_shot is offered with Blitz OFF',
    games.find((g) => g.game_id === 'pop_shot').blitz_enabled === false);

  // Asserted as a DELTA, not an absolute. This script is meant to be re-run
  // against a database that already has history in it, and a check that only
  // passes on a fresh account is a check that will be deleted the first time
  // someone runs it twice.
  const before = (await call('getProfile', {}, idToken)).balanceCents;
  const runKey = `e2e:${Date.now()}`;

  const deposited = await call(
    'mockDeposit', { amountCents: 5000, idempotencyKey: runKey }, idToken
  );
  check('the deposit landed', deposited.balanceCents === before + 5000,
    `${before}c → ${deposited.balanceCents}c`);

  const replay = await call(
    'mockDeposit', { amountCents: 5000, idempotencyKey: runKey }, idToken
  );
  check('replaying the SAME deposit key does not double-credit',
    replay.balanceCents === deposited.balanceCents && replay.applied === false,
    `${replay.balanceCents}c`);

  const profile = await call('getProfile', {}, idToken);

  console.log('\n── the tuned curve, as a player sees it ──────────────────────');
  const quote = await call('blitzQuote', { gameId: 'chicken_run', stakeCents: 100 }, idToken);
  check('break-even is now BELOW the target',
    quote.breakEvenScore < quote.targetScore,
    `break-even ${quote.breakEvenScore} < target ${quote.targetScore}`);

  const atTarget = quote.curve.find((p) => p.score === quote.targetScore);
  check('hitting the target actually pays more than the entry',
    !atTarget || atTarget.multiplier > 1,
    atTarget ? `${atTarget.multiplier}x at score ${atTarget.score}` : 'target not a breakpoint');

  console.log('\n── the round loop ───────────────────────────────────────────');
  const round = await call('blitzEnter', { quoteId: quote.quoteId }, idToken);
  check('entering debited the stake',
    round.balanceCents === quote.balanceCents - quote.stakeCents,
    `${quote.balanceCents} → ${round.balanceCents}`);
  check('the seed came from the server', typeof round.seed === 'string' && round.seed.length > 0);

  const { trace, expected } = bestTrace(round.seed);
  await call('blitzHeartbeat', { roundId: round.roundId, score: 1, tick: 100 }, idToken);

  // Claim an absurd score. The server should pay on its own replay.
  const settled = await call(
    'blitzSubmit', { roundId: round.roundId, score: 9999, trace }, idToken
  );
  check('the server settled on ITS replay, not the claim',
    settled.score === expected && settled.score !== 9999,
    `claimed 9999, paid on ${settled.score}`);
  check('the mismatch was flagged', settled.scoreMismatch === true);

  const resubmit = await call(
    'blitzSubmit', { roundId: round.roundId, score: 9999, trace }, idToken
  );
  check('re-submitting returns the same settlement and pays once',
    resubmit.alreadySettled === true && resubmit.payoutCents === settled.payoutCents,
    `${resubmit.payoutCents}c both times`);

  console.log('\n── abandonment ──────────────────────────────────────────────');
  const q2 = await call('blitzQuote', { gameId: 'chicken_run', stakeCents: 100 }, idToken);
  const r2 = await call('blitzEnter', { quoteId: q2.quoteId }, idToken);
  await call('blitzHeartbeat', { roundId: r2.roundId, score: 3, tick: 400 }, idToken);
  check('a round is live with a heartbeat but no submit', !!r2.roundId);

  const swept = await call('sweepNow', {}, null);
  check('the sweeper leaves a round that is still inside its deadline alone',
    !swept.results.some((x) => x.roundId === r2.roundId && x.skipped === false),
    `${swept.swept} settled this pass`);

  console.log('\n── result ───────────────────────────────────────────────────');
  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\ne2e aborted:', err.message);
  process.exit(1);
});
