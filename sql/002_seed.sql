-- ============================================================================
-- 002_seed.sql — baseline rows: games, the shipping Blitz config, dev players.
--
-- Idempotent: safe to re-run against an existing database.
-- ============================================================================

begin;

-- ── Games ───────────────────────────────────────────────────────────────────
-- blitz_enabled is the per-game toggle. Chicken Run ships with Blitz on;
-- Pop Shot is registered with it OFF, which is what proves the toggle is a real
-- switch and not hard-wired to one game.

insert into games (game_id, display_name, blitz_enabled, enabled, sort_order)
values
  ('chicken_run', 'Chicken Run', true,  true, 10),
  ('pop_shot',    'Pop Shot',    false, true, 20)
on conflict (game_id) do update
  set display_name = excluded.display_name,
      enabled      = excluded.enabled,
      sort_order   = excluded.sort_order;
      -- NOTE: blitz_enabled deliberately NOT overwritten on re-run, so a live
      -- toggle is not silently reverted by re-applying the seed.

-- ── Blitz target-engine config ──────────────────────────────────────────────
-- Every parameter is documented in DECISIONS.md. Values here are the starting
-- point; the shipping numbers are whatever the tuning harness selects, and this
-- row is updated (or superseded by a new row) once that run exists.

insert into blitz_configs (game_id, name, params, is_active, notes)
select 'chicken_run', 'baseline-v0', $json${
  "cold_start": {
    "seed_target": 12,
    "bootstrap_rounds": 3,
    "bootstrap_cap_multiplier": 1.5,
    "bootstrap_max_stake_cents": 100
  },
  "ratchet": {
    "percentile": 0.70,
    "up_alpha": 0.45,
    "down_alpha": 0.08,
    "max_up_step": 4,
    "max_down_step": 2
  },
  "curve": {
    "shape": [
      { "rel": 0.00, "mult": 0.0 },
      { "rel": 0.55, "mult": 0.2 },
      { "rel": 1.00, "mult": 1.0 },
      { "rel": 1.35, "mult": 2.0 },
      { "rel": 1.65, "mult": 2.5 },
      { "rel": 2.00, "mult": 3.0 }
    ],
    "cap_multiplier": 3.0,
    "interpolation": "linear"
  },
  "ceiling_guard": {
    "pb_window": 20,
    "max_target_vs_pb": 0.92,
    "idle_decay_per_day": 0.04
  },
  "quote_ttl_seconds": 180,
  "round_deadline_seconds": 900,
  "stake_tiers_cents": [100, 300, 500, 1000, 2000]
}$json$::jsonb, true, 'Starting point, pre-harness. Superseded by the tuned config.'
where not exists (
  select 1 from blitz_configs where game_id = 'chicken_run' and name = 'baseline-v0'
);

-- ── Development players ─────────────────────────────────────────────────────
-- player_id is the Firebase Auth UID. These are placeholders overwritten by the
-- real UIDs once the test accounts exist; the README names the login.
--
-- Balances are seeded through the LEDGER, not by writing cash_cents directly, so
-- that even the dev fixture obeys the rule that every balance movement has a
-- ledger row behind it.

insert into players (player_id, display_name, cash_cents)
values ('dev-test-player', 'Test Player', 0)
on conflict (player_id) do nothing;

with entry as (
  insert into ledger_entries
    (player_id, kind, amount_cents, balance_after_cents, idempotency_key, memo)
  select 'dev-test-player', 'deposit', 5000, 5000,
         'seed:dev-test-player:initial-deposit', 'Seeded dev balance ($50.00)'
  where not exists (
    select 1 from ledger_entries
     where idempotency_key = 'seed:dev-test-player:initial-deposit'
  )
  returning player_id, balance_after_cents
)
update players p
   set cash_cents = e.balance_after_cents
  from entry e
 where p.player_id = e.player_id;

commit;
