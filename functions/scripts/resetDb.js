#!/usr/bin/env node
/**
 * Drop and rebuild the local development database.
 *
 * Applies sql/001_init.sql then sql/002_seed.sql against whatever the
 * environment points at. Used by the integration tests, which need a known
 * starting state, and by anyone setting up from a clean checkout.
 *
 *   docker compose up -d
 *   npm --prefix functions run db:reset
 *
 * REFUSES to run against a non-local host. Everything here is destructive, and
 * the same command pointed at the Supabase connection string would drop
 * production. That check is not paranoia — the connection settings come from the
 * environment, and the environment is exactly the thing that differs between a
 * laptop and a deploy.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_DIR = path.join(__dirname, '..', '..', 'sql');
const FILES = ['001_init.sql', '002_seed.sql'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '', undefined, null]);

function connectionSettings() {
  return {
    host: process.env.PG_HOST || process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PG_PORT || process.env.PGPORT || '5432', 10),
    database: process.env.PG_DATABASE || process.env.PGDATABASE || 'skilltrial',
    user: process.env.PG_USER || process.env.PGUSER || 'postgres',
    password: process.env.PG_PASSWORD || process.env.PGPASSWORD || 'devpass',
  };
}

async function main() {
  const cfg = connectionSettings();

  if (!LOCAL_HOSTS.has(cfg.host)) {
    console.error(
      `Refusing to reset a non-local database (host: ${cfg.host}).\n` +
        'This drops every table. If you genuinely mean to rebuild a remote ' +
        'database, apply the SQL files by hand.'
    );
    process.exit(2);
  }

  const client = new Client(cfg);
  await client.connect();

  try {
    // Drop the whole schema rather than dropping tables one by one: the tables
    // reference each other, and a list of DROPs has to be maintained in
    // dependency order forever. This cannot drift.
    await client.query('drop schema public cascade; create schema public;');
    console.log(`reset ${cfg.database} on ${cfg.host}:${cfg.port}`);

    for (const file of FILES) {
      const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      await client.query(sql);
      console.log(`  applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`db:reset failed: ${err.message}`);
  process.exit(1);
});
