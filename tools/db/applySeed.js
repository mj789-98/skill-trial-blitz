#!/usr/bin/env node
/**
 * Apply sql/002_seed.sql to a chosen database.
 *
 * ── Why this is a script and not a pasted query ─────────────────────────────
 *
 * The hosted database drifted: it was seeded before the tuning harness existed,
 * so it carried baseline-v0 as the active config long after tuned-v1 shipped.
 * Nobody did anything wrong — there was simply no repeatable way to push the
 * seed anywhere except the local container, so it only ever went there.
 *
 * That is the actual defect, and a one-off query would not have fixed it. This
 * makes re-seeding a named operation that prints what it changed, so the next
 * drift is visible instead of discovered.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * The seed is idempotent by construction: every insert is guarded by
 * `where not exists` or `on conflict`, and the whole file runs in one
 * transaction. Re-running it against an up-to-date database is a no-op.
 *
 * It deliberately will NOT change `games.blitz_enabled`, so that re-seeding
 * cannot revert a toggle somebody set live. See the comment in the seed. The
 * consequence is that a database seeded before Pop Shot had a config of its own
 * keeps Pop Shot's Blitz toggle OFF, and this script will not turn it on —
 * `--enable-blitz <game_id>` does that, explicitly, because it is a decision
 * about a live game and not a consequence of running a migration.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node tools/db/applySeed.js                        # functions/.env  (local)
 *   node tools/db/applySeed.js --env .env.supabase    # the hosted instance
 *   node tools/db/applySeed.js --env .env.supabase --enable-blitz pop_shot
 *   node tools/db/applySeed.js --env .env.supabase --dry-run
 *
 * No credential is ever printed; the target is reported as host:port only.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const envName = arg('--env', '.env');
const enableBlitz = arg('--enable-blitz', null);
const dryRun = process.argv.includes('--dry-run');

const envPath = path.join(ROOT, 'functions', envName);
if (!fs.existsSync(envPath)) {
  console.error(`No such env file: functions/${envName}`);
  process.exit(1);
}

// The Functions runtime loads these itself; a standalone script has to.
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const { query } = require(path.join(ROOT, 'functions', 'db'));

async function snapshot(label) {
  const games = await query('select game_id, blitz_enabled from games order by sort_order');
  const configs = await query(
    'select game_id, name, is_active from blitz_configs order by game_id, name'
  );
  for (const r of games.rows) {
    console.log(`  ${label} game    ${r.game_id.padEnd(12)} blitz=${r.blitz_enabled}`);
  }
  for (const r of configs.rows) {
    console.log(
      `  ${label} config  ${r.game_id.padEnd(12)} ${r.name}${r.is_active ? '  ← ACTIVE' : ''}`
    );
  }
}

(async () => {
  // Mirror db.js's own defaults rather than echoing the raw variables. The
  // local env sets neither PG_HOST nor PG_PORT and leans on those defaults, so
  // printing the variables verbatim reported "undefined:undefined" — a re-seed
  // script that misreports which database it is about to write to is worse than
  // no script. SSL follows the same rule db.js uses: on for a remote host, off
  // for the local container.
  const host = process.env.PG_HOST || 'localhost (db.js default)';
  const port = process.env.PG_PORT || '5432 (db.js default)';

  console.log(`env      functions/${envName}`);
  console.log(`target   ${host}:${port}`);
  console.log(`database ${process.env.PG_DATABASE || 'postgres (db.js default)'}`);
  console.log(`ssl      ${process.env.PG_HOST ? 'on' : 'off (local)'}\n`);

  await snapshot('before');

  if (dryRun) {
    console.log('\n--dry-run: nothing was written.');
    process.exit(0);
  }

  const sql = fs.readFileSync(path.join(ROOT, 'sql', '002_seed.sql'), 'utf8');
  await query(sql);
  console.log('\nseed applied.');

  if (enableBlitz) {
    // Separate from the seed on purpose: this is the one thing the seed will
    // not do for you, and it should read as a deliberate act.
    const res = await query(
      'update games set blitz_enabled = true where game_id = $1 and not blitz_enabled',
      [enableBlitz]
    );
    console.log(
      res.rowCount
        ? `blitz enabled for ${enableBlitz}.`
        : `blitz already enabled for ${enableBlitz}; nothing to do.`
    );
  }

  console.log('');
  await snapshot('after ');
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
