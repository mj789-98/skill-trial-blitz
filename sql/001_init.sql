-- ============================================================================
-- 001_init.sql — schema for the skill-gaming trial (Chicken Run + Blitz mode)
--
-- Money rules this schema enforces STRUCTURALLY, not by convention:
--   * every monetary column is bigint CENTS. There is no numeric/float money.
--   * ledger_entries is append-only and carries a UNIQUE idempotency_key. That
--     constraint — not application code — is what makes settlement idempotent.
--     A double submit, a client retry, and a race between the client and the
--     stale-round sweeper all collide on it, and Postgres rejects the loser.
--   * players.cash_cents has a >= 0 check, so an over-spend fails the write
--     rather than quietly going negative.
--
-- Written for the Supabase transaction-mode pooler (port 6543): no advisory
-- locks, no session state, no temp tables. Concurrency control is row locks
-- (SELECT ... FOR UPDATE) only.
-- ============================================================================

begin;

-- ── Players ─────────────────────────────────────────────────────────────────

create table if not exists players (
  player_id    text primary key,                       -- Firebase Auth UID
  display_name text        not null,
  cash_cents   bigint      not null default 0 check (cash_cents >= 0),
  created_at   timestamptz not null default now()
);

-- ── Ledger ──────────────────────────────────────────────────────────────────
-- Append-only. Never UPDATEd, never DELETEd. players.cash_cents is a cached
-- running total; this table is the truth, and the two must always agree.

do $$ begin
  create type ledger_kind as enum
    ('deposit', 'withdrawal', 'stake', 'payout', 'refund', 'adjustment');
exception when duplicate_object then null;
end $$;

create table if not exists ledger_entries (
  entry_id            bigserial   primary key,
  player_id           text        not null references players (player_id),
  kind                ledger_kind not null,
  -- SIGNED, in cents. Negative means money leaves the player.
  amount_cents        bigint      not null,
  -- The player's balance immediately after this entry was applied. Lets an
  -- auditor replay the ledger and assert it reconstructs the current balance.
  balance_after_cents bigint      not null check (balance_after_cents >= 0),
  round_id            uuid,
  -- The whole idempotency story. e.g. 'stake:<round_id>', 'payout:<round_id>'.
  idempotency_key     text        not null,
  memo                text,
  created_at          timestamptz not null default now(),

  constraint ledger_idem_unique unique (idempotency_key),

  -- Direction must match the kind, so a sign-flip bug cannot masquerade as a
  -- valid entry. Note payout/refund allow 0: a losing round settles at 0 and
  -- still writes its row, which is what makes "exactly one outcome" auditable.
  constraint ledger_sign_matches_kind check (
    case kind
      when 'stake'      then amount_cents <  0
      when 'withdrawal' then amount_cents <  0
      when 'deposit'    then amount_cents >  0
      when 'payout'     then amount_cents >= 0
      when 'refund'     then amount_cents >= 0
      when 'adjustment' then true
    end
  )
);

create index if not exists ledger_player_recent_idx
  on ledger_entries (player_id, entry_id desc);
create index if not exists ledger_round_idx
  on ledger_entries (round_id) where round_id is not null;

-- ── Games ───────────────────────────────────────────────────────────────────

create table if not exists games (
  game_id       text primary key,                      -- 'chicken_run', 'pop_shot'
  display_name  text    not null,
  -- The per-game Blitz toggle. Blitz is a mode that WRAPS a game; it is data,
  -- not a build flag, so it can be switched on for one game and off for another
  -- without a rebuild.
  blitz_enabled boolean not null default false,
  enabled       boolean not null default true,
  sort_order    int     not null default 0
);

-- ── Target-engine configuration ─────────────────────────────────────────────
-- Config lives in data so the mode can be retuned without a rebuild. Exactly
-- one row per game may be active at a time.

create table if not exists blitz_configs (
  config_id  bigserial   primary key,
  game_id    text        not null references games (game_id),
  name       text        not null,
  params     jsonb       not null,
  is_active  boolean     not null default false,
  notes      text,
  created_at timestamptz not null default now()
);

create unique index if not exists blitz_config_one_active_per_game
  on blitz_configs (game_id) where is_active;

-- ── Per-player, per-game Blitz profile ──────────────────────────────────────
-- The history the target engine reads. Updated once, at settlement.

create table if not exists blitz_profiles (
  player_id      text    not null references players (player_id),
  game_id        text    not null references games (game_id),
  rounds_played  int     not null default 0 check (rounds_played >= 0),
  -- Lifetime, never reset: this is what stops the cold-start window from being
  -- farmed by abandoning rounds. Consumed by rounds ENTERED, not rounds won.
  bootstrap_used int     not null default 0 check (bootstrap_used >= 0),
  -- The ratcheting break-even anchor. numeric, not money — it is a score.
  target_score   numeric not null,
  ewma_score     numeric,
  best_score     int,
  -- Rolling window of recent scores, newest first. Feeds the percentile
  -- ratchet and the personal-best ceiling guard.
  recent_scores  jsonb   not null default '[]'::jsonb,
  last_played_at timestamptz,
  updated_at     timestamptz not null default now(),

  primary key (player_id, game_id)
);

-- ── Quotes: a payout screen that was SHOWN to a player ──────────────────────
-- Binding at entry. Single use, and time-limited so a player cannot sit on a
-- stale curve that no longer reflects their profile.

create table if not exists blitz_quotes (
  quote_id          uuid        primary key,
  player_id         text        not null references players (player_id),
  game_id           text        not null references games (game_id),
  config_id         bigint      not null references blitz_configs (config_id),
  stake_cents       bigint      not null check (stake_cents > 0),
  -- FROZEN at generation. Rendered to the player as the payout screen.
  curve             jsonb       not null,
  -- What the engine saw when it generated the curve. Kept for audit: it lets us
  -- answer "why did this player get this curve?" months later.
  profile_snapshot  jsonb       not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  -- Single use. Set at entry, inside the same transaction that debits.
  consumed_by_round uuid,
  -- Superseded when the player requests a newer quote for the same (player,
  -- game), so they cannot hold a basket of curves and enter the friendliest.
  superseded_at     timestamptz
);

create index if not exists blitz_quote_open_idx
  on blitz_quotes (player_id, game_id)
  where consumed_by_round is null and superseded_at is null;

-- ── Rounds ──────────────────────────────────────────────────────────────────

do $$ begin
  create type round_status as enum ('active', 'settled', 'voided');
exception when duplicate_object then null;
end $$;

create table if not exists blitz_rounds (
  round_id        uuid         primary key,
  -- One round per quote, enforced by the database.
  quote_id        uuid         not null unique references blitz_quotes (quote_id),
  player_id       text         not null references players (player_id),
  game_id         text         not null references games (game_id),
  stake_cents     bigint       not null check (stake_cents > 0),

  -- ★ COPIED from the quote at entry. Settlement reads ONLY this column: never
  -- the quote, never the profile, never a freshly generated curve. The player
  -- cannot be paid on a curve other than the one they agreed to, because it is
  -- the only curve the settlement path can see.
  curve           jsonb        not null,

  -- Server-issued world seed. The client generates its world from this, so it
  -- cannot choose a favourable one.
  seed            text         not null,

  status          round_status not null default 'active',
  started_at      timestamptz  not null default now(),
  -- After this, the sweeper resolves the round whether the client returns or not.
  deadline_at     timestamptz  not null,

  -- Last score the SERVER acknowledged mid-round. This is what an interrupted
  -- round settles at, which is what makes that outcome defensible rather than
  -- arbitrary. Monotonic by construction (see the guarded UPDATE in heartbeat).
  heartbeat_score int          not null default 0 check (heartbeat_score >= 0),
  heartbeat_at    timestamptz,

  submitted_score int,                        -- what the client claimed
  validated_score int,                        -- what the server's replay computed
  settle_reason   text,                       -- 'submit' | 'sweep' | 'void'
  multiplier      numeric,
  payout_cents    bigint check (payout_cents is null or payout_cents >= 0),
  settled_at      timestamptz,

  -- A settled round must be fully settled: no half-written outcomes.
  constraint round_settled_is_complete check (
    status <> 'settled' or (
      payout_cents is not null and multiplier is not null
      and validated_score is not null and settled_at is not null
    )
  )
);

-- Drives the sweeper: find active rounds past their deadline.
create index if not exists blitz_round_sweep_idx
  on blitz_rounds (deadline_at) where status = 'active';
create index if not exists blitz_round_player_idx
  on blitz_rounds (player_id, started_at desc);

commit;
