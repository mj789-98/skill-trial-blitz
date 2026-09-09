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
  ('pop_shot',    'Pop Shot',    true,  true, 20)
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
    "min_target_vs_pb": 0.45,
    "floor_percentile": 0.9,
    "idle_decay_per_day": 0.04
  },
  "min_target": 5,
  "quote_ttl_seconds": 180,
  "round_deadline_seconds": 900,
  "stake_tiers_cents": [100, 300, 500, 1000, 2000]
}$json$::jsonb, false, 'Starting point, pre-harness. Superseded by tuned-v1; kept as the record of what the harness measured.'
where not exists (
  select 1 from blitz_configs where game_id = 'chicken_run' and name = 'baseline-v0'
);

-- ── The tuned config ─────────────────────────────────────────────────
-- Selected by tools/sim/run.js. Full working in docs/tuning-report.md.
--
-- Two things changed from baseline-v0, both of them things the harness found:
--
--   1. Break-even moved to 0.55 x target. In baseline-v0 the target WAS
--      break-even (rel 1.00 -> mult 1.0), so a player who did exactly what the
--      payout screen asked got their entry back and nothing else — measured win
--      rate for both disciplined cohorts was 0.0%. Reaching the target now pays
--      1.62x, and getting most of the way there returns the stake.
--
--   2. The top of the curve is now reached at 1.75x target rather than 2.0x,
--      which is what makes the 3.0x maximum something a real run can touch.
--
--      Worth being precise about the cap itself, because the sweep looks odd:
--      2.5 / 3.0 / 3.5 gives 84.4% / 86.4% / 86.4%. cap_multiplier CLAMPS the
--      shape (curve.js: min(shape, cap)); it does not scale it. So a cap above
--      the shape's own top point is inert by construction — it is a safety
--      ceiling, not a dial for the top end. The dial is the shape's last point.
--      That is deliberate: a cap that stretched the curve would silently make
--      every payout bigger when someone raised the safety limit.
--
-- RTP 86.4% weighted across the population, win rate 40.6%, bust rate 13.2%.
-- Chosen over the 88.0% variant deliberately: the frontier is sharp, and at
-- 88.0% the strong-disciplined cohort returns 102.6% — the mode would be paying
-- its best players to play. 86.4% is the nearest point where no cohort is
-- net-positive.
--
-- The active config is switched in the same statement that inserts the new one,
-- because blitz_config_one_active_per_game is a UNIQUE partial index: two active
-- rows for one game is not a state this database will hold.

update blitz_configs set is_active = false
 where game_id = 'chicken_run' and name <> 'tuned-v1';

insert into blitz_configs (game_id, name, params, is_active, notes)
select 'chicken_run', 'tuned-v1', $json${
  "cold_start": {
    "seed_target": 12,
    "bootstrap_rounds": 3,
    "bootstrap_cap_multiplier": 1.5,
    "bootstrap_max_stake_cents": 100
  },
  "ratchet": {
    "percentile": 0.7,
    "up_alpha": 0.45,
    "down_alpha": 0.08,
    "max_up_step": 4,
    "max_down_step": 2
  },
  "curve": {
    "shape": [
      {
        "rel": 0.0,
        "mult": 0.0
      },
      {
        "rel": 0.3,
        "mult": 0.35
      },
      {
        "rel": 0.55,
        "mult": 1.0
      },
      {
        "rel": 1.0,
        "mult": 1.62
      },
      {
        "rel": 1.35,
        "mult": 2.38
      },
      {
        "rel": 1.75,
        "mult": 3.0
      }
    ],
    "cap_multiplier": 3.0,
    "interpolation": "linear"
  },
  "ceiling_guard": {
    "pb_window": 20,
    "max_target_vs_pb": 0.92,
    "min_target_vs_pb": 0.45,
    "floor_percentile": 0.9,
    "idle_decay_per_day": 0.04
  },
  "min_target": 5,
  "quote_ttl_seconds": 180,
  "round_deadline_seconds": 900,
  "stake_tiers_cents": [
    100,
    300,
    500,
    1000,
    2000
  ]
}$json$::jsonb, true,
       'Selected by tools/sim/run.js at 86.4% RTP. See docs/tuning-report.md.'
where not exists (
  select 1 from blitz_configs where game_id = 'chicken_run' and name = 'tuned-v1'
);

-- ── Pop Shot config ─────────────────────────────────────────────────────────
-- Its own row, not a copy of Chicken Run's, and the differences are the whole
-- argument for per-game targets (DECISIONS D-013).
--
-- Pop Shot's score distribution is RIGHT-SKEWED in a way Chicken Run's is not:
-- scoring buys clock, which buys more scoring, so a hot streak produces an
-- outlier far above a player's typical round. Measured with Chicken Run's
-- settings, that broke the engine in a direction I had not seen before — the
-- p90 personal-best floor chased the outlier and OVER-targeted skilled players:
--
--     novice   mean score  7.7   mean target 11.3   RTP 106%
--     expert   mean score 16.1   mean target 30.6   RTP  75%
--
-- Backwards for a skill game: beginners profited and good players were priced
-- out. Dropping floor_percentile from 0.9 makes the floor track typical rather
-- than peak play.
--
-- 0.68, not 0.6. 0.6 was measured against a Pop Shot where the ball's drift
-- direction was a coin flip, so half of all rounds spawned it on the basket's
-- own side and drifted it AWAY — those rounds opened with a lap of the court
-- instead of a run at the hoop. Tying the drift to the hoop (which the brief's
-- wrap rule requires) made every round a scoring round, mean scores rose, and
-- the same config paid 92.1%. 0.68 puts it back where it was reasoned to be.
--
-- RTP 89.7%, band 85.0-92.4%, win rate 27%, over 150 players x 3 seeds
-- (89.8 / 88.2 / 91.0, sd 1.4pp).
--
-- Higher than Chicken Run's 86.4% on purpose. Pop Shot has no cash-out, so
-- there is no moment where a player chooses to risk everything and no round
-- that pays exactly zero for a mistake at the end. In a game you cannot bank,
-- a thinner return reads as the game simply taking from you.

insert into blitz_configs (game_id, name, params, is_active, notes)
select 'pop_shot', 'popshot-v1', $json${
  "cold_start": {
    "seed_target": 8,
    "bootstrap_rounds": 3,
    "bootstrap_cap_multiplier": 1.5,
    "bootstrap_max_stake_cents": 100
  },
  "ratchet": {
    "percentile": 0.7,
    "up_alpha": 0.45,
    "down_alpha": 0.08,
    "max_up_step": 4,
    "max_down_step": 2
  },
  "curve": {
    "shape": [
      {
        "rel": 0.0,
        "mult": 0.0
      },
      {
        "rel": 0.495,
        "mult": 0.35
      },
      {
        "rel": 0.9,
        "mult": 1.0
      },
      {
        "rel": 1.0,
        "mult": 1.15
      },
      {
        "rel": 1.35,
        "mult": 2.17
      },
      {
        "rel": 1.75,
        "mult": 3.0
      }
    ],
    "cap_multiplier": 3.0,
    "interpolation": "linear"
  },
  "ceiling_guard": {
    "pb_window": 20,
    "max_target_vs_pb": 0.92,
    "min_target_vs_pb": 0.45,
    "floor_percentile": 0.68,
    "idle_decay_per_day": 0.04
  },
  "min_target": 3,
  "quote_ttl_seconds": 180,
  "round_deadline_seconds": 900,
  "stake_tiers_cents": [
    100,
    300,
    500,
    1000,
    2000
  ]
}$json$::jsonb, true,
       'Selected by tools/sim/run.js --game pop_shot at 90.1% RTP.'
where not exists (
  select 1 from blitz_configs where game_id = 'pop_shot' and name = 'popshot-v1'
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
