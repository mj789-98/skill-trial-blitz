# Work Trial — Project Kickoff Plan

**Target platform:** Android (Windows-only dev machine; brief explicitly says nothing is penalised)
**Budget assumed:** ~8–10 hrs/day, 10 days
**Prepared:** 7 Sep 2026

---

## 0. Read this first — what the brief is actually testing

The scoring table gives you the answer, and it is not the answer most candidates will act on:

| Weight | Dimension |
| --- | --- |
| **30%** | Correctness & server authority |
| **25%** | Game feel |
| 20% | Code quality & architecture |
| 15% | Product judgement & written reasoning |
| 10% | Polish & completeness |

**55% of the mark is "money is never wrong" + "the game feels good."** Only 10% is completeness. That means:

- A submission with Chicken Run + Blitz, where the ledger is provably correct and the game feels genuinely good, beats a submission with all three games and a settlement path that can double-pay.
- **Pop Shot (basketball) is the last thing you touch.** It is worth bonus points on a 10% category. Do not start it before Day 9.
- The written `DECISIONS.md` is worth more than the basketball game (15% vs. a slice of 10%). Budget real hours for it, not the last hour of Day 10.

There is one architectural decision (Section 7) that lets you score near-top on both the 30% and the 20% categories with the same piece of work. It is the single highest-leverage thing in this plan. Read Section 7 before you write any Unity code, because it changes how you write the game loop.

---

## 1. What I extracted from the reference material

I stepped through all three recordings frame by frame plus the eight screenshots. This is spec-grade detail you can build straight from — you don't need to re-watch them.

### 1.1 Chicken Run (the required game)

**Camera & framing** — Portrait. Orthographic projection, camera yawed roughly 30–40° and pitched ~50–55° down, so lanes run as diagonals from lower-left to upper-right. Camera follows the chicken's *furthest* row with smoothing and **never scrolls backward**.

**Lane types observed:**

| Lane | Contents | Behaviour |
| --- | --- | --- |
| Grass | Trees (dense clusters form walls), bushes, grey rocks | Trees/rocks block the hop — the hop is *refused*, not fatal |
| Road | Cars, vans, box trucks, both directions, little dust puffs behind them | Collision = death |
| Railway | Track + crossing signal pole with flashing lights | Signal flashes ahead of the train; train is fast and spans the lane |
| River | Blue water, floating logs (brown), static lily pads (green) | Log/lily pad = platform, water = death. Logs carry the chicken sideways |

**The idle mechanic is visualised.** There is a soft dark diagonal band across the upper-left of the play area, parallel to the lanes, that creeps forward. It is the "don't linger" kill line made visible — no eagle, no timer UI, just advancing shadow. This is a much better answer to the brief's *"you decide the threshold — state it and say why"* than a hidden countdown, and you should copy it.

**HUD:**
- Score: rounded pill, top centre, dark slate-teal fill with a thick cream/off-white border, white bold numerals.
- **Cash Out**: bottom right, a white **egg** with a dark elliptical drop shadow beneath it, "CASH OUT" in white outlined caps below. Press-and-hold — a green ring fills clockwise around the egg (visible at ~0.8s in the third recording), then it fires.
- Score is **monotonic** — it is *furthest row reached*, not net rows. Going backwards doesn't reduce it.

**States:**
- Pre-game: SOUND / MUSIC / HAPTICS round toggles across the top, "HOW TO PLAY" panel, big green START button.
- Death: screen dims, RIP gravestone drops in, **"YOU DIED"** in yellow caps.
- Cash out: gold radial burst, chicken cheering with coins around it, **"YOU SCORED 12"** in yellow, big white number, green **CONTINUE** button.
- Lobby: game banner art, "Practice Mode", *"Cash games aren't available in your area. Play for free!"*, orange **Play** button, bottom tab bar: Results / Play / Profile.

### 1.2 Pop Shot (bonus)

Portrait, 2D side-on. The mechanic is **not** aim-and-shoot — it's Flappy-Bird-with-a-basketball:

- The ball carries constant rightward velocity and constant gravity. **A tap applies a fixed upward impulse.** No aiming, no charge, no position sensitivity — I traced the ball across 20 frames at 5fps and it moves right at a steady rate while taps bump it up.
- The world scrolls left. Hoops arrive on white poles at **varying heights**, red rim, some with a backboard, pole sometimes left of the rim and sometimes right.
- A red LED shot clock is mounted in the scene (not in the HUD) and counts **down** from 20. Each basket adds time (I watched 15 → 15 → 14 → 14 → 13 → 13 → 12, then a `+1` popup and it jumps back up).
- `+1` floats off the rim on a normal score. The screenshots confirm `+2` and a **"CLEAN!"** graffiti stamp for a swish (no rim, no backboard).
- Score: big white/red graffiti numeral, top centre. Game over: **"GAME OVER"** graffiti wordmark, score below, "TAP TO CONTINUE".
- Setting: night rooftop court, "TRIUMPH" neon sign, brick buildings, bleachers, blue-and-red court.

### 1.3 The competitor's Blitz payout screen (screenshot 3)

This is your UI reference for the money screen, and it encodes the whole model:

```
Result
$0
Your score: 0                    2.5x ---- 8810
                                              8292
                                 2x ------ 7932
                                              7589
                                              7175
                                              6547
                     Break Even -------- 6418
                                              6232
Buy in: $3  |  Multiplier: 0.00x
Prize Wheel  [▮▯▯▯▯▯▯▯▯▯]
```

Read carefully, three things fall out:

1. **The y-axis ticks are not evenly spaced** — they are the actual score breakpoints. The curve is a piecewise thing rendered smoothly, not a formula plotted.
2. **The curve visibly continues below the break-even line and to the left**, and the lowest tick (6232) is *below* break-even (6418). So there is a sub-break-even payout band — you don't get zero for a near-miss. **The brief never states this. Decide it, state it, and raise it on Telegram.** (My recommendation in §9.)
3. Buy-in $3, cap around 2.5x on that screen. The brief's cap band is 2.5x–3.5x.

---

## 2. The decisions I've already closed for you

| Question | Answer | Why |
| --- | --- | --- |
| Platform | **Android** | No Mac. Brief: *"Android is completely fine and nothing is penalised."* Say so plainly in README. |
| Unity render pipeline | **URP, 2D+3D** | Chicken Run is low-poly 3D under an ortho camera; Pop Shot is 2D. One URP project handles both. |
| Unity scripting backend | **IL2CPP, ARM64 only** | Required for Play, and halves APK size vs. including armeabi-v7a. |
| Who talks to the backend | **React Native only. Unity never makes a network call.** | It's the cleanest trust boundary and the easiest thing in the world to defend in review. Unity is a renderer + input recorder that gets handed a seed and hands back a trace. |
| Blitz per-game toggle | **A `games` table row with `blitz_enabled`**, not a build flag | The brief explicitly tests this. Data, not code. |

---

## 3. Risk map — what actually kills this trial

Ordered by probability × damage.

### R1 — The Unity ↔ RN 0.86 embed doesn't build (HIGH / FATAL)

React Native 0.86 is New-Architecture-only (bridgeless; the legacy bridge was removed in 0.85). `@azesmway/react-native-unity` is at **1.0.7** and its README does now claim New Architecture support, but its issue tracker still carries *"Unimplemented Component: `<ReactNativeUnityView>`"* — which is precisely the symptom of a view that hasn't been registered as a Fabric component. There is also an open issue on iOS builds with Unity 6.

If this doesn't build, nothing else in the project matters. **This is Day 1, hour 1.** Section 4 is the spike.

Fallbacks, in order of preference:
1. Fork `@azesmway/react-native-unity`, add the Fabric component spec / codegen config, use the fork from a git URL. The brief *explicitly* invites this: *"Pick whatever version of it builds, and record what you used in your `README.md`."* A fork is fully within the letter of that.
2. Only if the fork stalls: pin RN down a minor version. This is a **spec deviation** — the versions table is pinned — so it must be raised on Telegram before you do it, and documented loudly in DECISIONS.md.

### R2 — Gradle/AGP mismatch between Unity's export and RN's template (HIGH / 1–2 days)

Expect at least three of these:
- Unity's exported `unityLibrary/build.gradle` missing a `namespace` declaration (AGP 8+ requires it).
- `compileSdk` / `minSdk` / `ndkVersion` disagreeing between `unityLibrary` and RN's `app` module.
- The 16 KB page-size requirement for Play — Unity 6 handles it, but verify.
- Duplicate `.so` / packaging conflicts needing `packagingOptions { pickFirst }`.
- Black screen when returning from background → call `windowFocusChanged(true)`; that's what the prop exists for.

### R3 — Deterministic replay drifts between C# and JS (MEDIUM / 1 day)

Section 7 depends on Unity and Node producing byte-identical simulation results. Float drift is the enemy. Mitigation: **the entire Chicken Run simulation is integer / fixed-point.** Grid positions are ints. Vehicle positions are integer sub-units. No `float` anywhere in a decision path. Write the cross-check test on Day 4, not Day 9.

### R4 — Money bugs found in review (MEDIUM / kills the 30%)

Mitigated structurally in §6: settlement idempotency is enforced by a **unique constraint in Postgres**, not by application logic. You cannot double-pay because the database will not let you.

### R5 — Running out of time on `DECISIONS.md` (HIGH / kills the 15%)

Mitigated by writing it **incrementally from Day 1**. Every time you make a call, write the paragraph immediately. Do not leave it to Day 10.

---

## 4. Day 0 / Day 1 — the de-risking spike (timebox: 8 hours, hard stop)

Do this before writing one line of game code, backend code, or UI.

```
[ ] 1. Node 22.11+ active (nvm). Confirm: node -v
[ ] 2. npx @react-native-community/cli init SkillApp --version 0.86.0
       Run on a real device over USB. Confirm the stock app renders.
[ ] 3. npm i @azesmway/react-native-unity
[ ] 4. Unity 6000.1.13f1: new URP 3D project. One scene:
       - a rotating cube
       - a GameObject named exactly "RNBridge" with a script exposing
         public void OnMessage(string json)
         and calling UnityMessageManager.Instance.SendMessageToRN(json) on tap
[ ] 5. Unity Build Settings → Android:
       - Export Project: CHECKED
       - IL2CPP, ARM64 only, Min API 24
       - Export to  <rn-project>/unity/builds/android
[ ] 6. Wire the Gradle files (exact snippets from the package README):
       settings.gradle    → include ':unityLibrary' + projectDir
       build.gradle       → flatDir { dirs "${project(':unityLibrary').projectDir}/libs" }
       gradle.properties  → unityStreamingAssets=.unity3d
       strings.xml        → <string name="game_view_content_description">Game view</string>
[ ] 7. Delete the <intent-filter> block from
       unity/builds/android/unityLibrary/src/main/AndroidManifest.xml
[ ] 8. ./gradlew assembleDebug  →  install on device
[ ] 9. VERIFY ALL FOUR:
       (a) the cube renders inside the RN screen
       (b) RN → Unity: postMessage('RNBridge','OnMessage', '{"hello":1}') lands
       (c) Unity → RN: onUnityMessage fires with the payload
       (d) background the app, reopen it — no black screen
           (call windowFocusChanged(true) on AppState change if it is black)
[ ] 10. Write the exact versions that worked into README.md IMMEDIATELY.
```

**Gate:** if step 9 isn't green by the end of Day 1, that is your escalation. Post it in the Telegram group that evening with what you tried. Asking early is explicitly a positive signal in the brief; going quiet for four days and then surfacing a blocker is not.

Also on Day 1, in parallel while Gradle churns:
- Create the Supabase project. Note the **transaction-mode pooler** connection string (**port 6543**, not 5432) — `db.js` is written for it.
- Create the Firebase project, enable Auth (email/password is enough), init Functions on Node 20 with `firebase-functions@^5`, `firebase-admin@^12`, `pg@^8.20.0`.
- Drop in the provided `db.js` unmodified. Deploy one trivial callable that runs `SELECT 1` through `query()` and confirm it reaches Supabase.
- Post your Telegram questions (§10).

---

## 5. Repository & architecture

```
skill-trial/
├── README.md                    # run-from-clean-checkout, versions, platform, test account
├── DECISIONS.md                 # written from Day 1, not Day 10
│
├── app/                         # React Native 0.86, TypeScript ^5.8.3
│   ├── src/
│   │   ├── screens/
│   │   │   ├── LobbyScreen.tsx
│   │   │   ├── blitz/PayoutScreen.tsx     # the curve. judged like a player.
│   │   │   ├── blitz/ResultScreen.tsx     # judged like a player.
│   │   │   └── GameScreen.tsx             # hosts the Unity view
│   │   ├── unity/
│   │   │   ├── UnityHost.tsx              # the ONLY place the Unity view is mounted
│   │   │   └── protocol.ts                # bridge message types, shared source of truth
│   │   ├── api/                           # typed client for the callables
│   │   └── state/
│   └── android/
│
├── unity/                       # Unity 6000.1.13f1
│   ├── Assets/_Project/
│   │   ├── Core/
│   │   │   ├── DeterministicRandom.cs     # mulberry32, integer-only
│   │   │   ├── FixedStepLoop.cs           # 50 Hz, decoupled from frame rate
│   │   │   └── InputTrace.cs              # records (tick, action)
│   │   ├── ChickenRun/
│   │   │   ├── Sim/                       # PURE LOGIC. no UnityEngine types. no floats.
│   │   │   └── View/                      # renders Sim state. all the juice lives here.
│   │   ├── PopShot/
│   │   └── Bridge/RNBridge.cs             # single GameObject entry point
│   └── builds/android/                    # gitignored (except a README note)
│
├── functions/                   # Firebase Functions — JAVASCRIPT, not TypeScript
│   ├── db.js                    # provided, unmodified
│   ├── index.js
│   ├── money/ledger.js          # the ONLY module that writes a balance
│   ├── blitz/
│   │   ├── quote.js  enter.js  heartbeat.js  submit.js  sweep.js
│   ├── engine/
│   │   ├── targetEngine.js      # history → curve
│   │   └── curve.js             # score → multiplier → cents
│   └── sim/
│       └── chickenRun.js        # ★ JS mirror of the C# sim. Used by submit.js AND the harness.
│
├── sql/
│   ├── 001_init.sql
│   └── 002_seed.sql
│
└── tools/sim/                   # tuning harness. imports functions/engine + functions/sim.
    ├── run.js
    ├── players.js               # synthetic skill + cash-out policy models
    └── out/                     # committed CSVs + the chart that justified your config
```

**The two architectural claims this layout makes**, and you should say both out loud in DECISIONS.md:

1. **Unity's `Sim/` folder contains no `UnityEngine` types and no floats.** It is a pure state machine that advances by ticks. `View/` reads it and renders. This is what makes §7 possible, and it is also what makes the game testable.
2. **`functions/sim/chickenRun.js` is imported by both the score validator and the tuning harness.** One simulation, two consumers. The harness isn't a toy that models the game approximately — it runs the real thing.

### Bridge protocol (write this down once, in `protocol.ts`, and mirror it in C#)

```ts
// RN → Unity   via  postMessage('RNBridge', 'OnMessage', JSON.stringify(msg))
type ToUnity =
  | { type: 'START_ROUND'; gameId: string; seed: string; roundId: string; mode: 'blitz' | 'practice' }
  | { type: 'ABORT' }
  | { type: 'SET_AUDIO'; sound: boolean; music: boolean; haptics: boolean };

// Unity → RN   via  onUnityMessage
type FromUnity =
  | { type: 'READY' }
  | { type: 'SCORE_TICK'; score: number; tick: number }       // throttled, ~1/sec
  | { type: 'ROUND_END'; reason: 'cash_out' | 'death' | 'idle'; score: number;
      tick: number; trace: string }                            // trace = base64 packed inputs
```

RN receives `SCORE_TICK` and forwards it to the heartbeat endpoint. RN receives `ROUND_END` and calls submit. Unity holds no auth token, no URL, no knowledge that money exists.

---

## 6. The money layer — get this exactly right, it's 30%

### 6.1 Schema (`sql/001_init.sql`)

```sql
create table players (
  player_id     text primary key,                  -- Firebase Auth UID
  display_name  text not null,
  cash_cents    bigint not null default 0 check (cash_cents >= 0),
  created_at    timestamptz not null default now()
);

create type ledger_kind as enum
  ('deposit','withdrawal','stake','payout','refund','adjustment');

-- append-only. never updated, never deleted.
create table ledger_entries (
  entry_id            bigserial primary key,
  player_id           text        not null references players(player_id),
  kind                ledger_kind not null,
  amount_cents        bigint      not null,        -- SIGNED. negative = leaves the player.
  balance_after_cents bigint      not null,
  round_id            uuid,
  idempotency_key     text        not null,
  created_at          timestamptz not null default now(),
  constraint ledger_idem_unique unique (idempotency_key)   -- ★ THE WHOLE GAME
);
create index on ledger_entries (player_id, entry_id desc);

create table games (
  game_id       text primary key,                  -- 'chicken_run', 'pop_shot'
  display_name  text not null,
  blitz_enabled boolean not null default false,    -- ★ the per-game toggle
  enabled       boolean not null default true
);

-- target engine config lives in DATA, retunable without a rebuild
create table blitz_configs (
  config_id  bigserial primary key,
  name       text not null,
  params     jsonb not null,
  is_active  boolean not null default false,
  created_at timestamptz not null default now()
);

create table blitz_profiles (
  player_id     text not null references players(player_id),
  game_id       text not null references games(game_id),
  rounds_played int  not null default 0,
  target_score  numeric not null,                  -- the ratcheting break-even anchor
  ewma_score    numeric,
  best_score    int,
  recent_scores jsonb not null default '[]',       -- rolling window for the ceiling guard
  last_played_at timestamptz,
  primary key (player_id, game_id)
);

-- a payout screen that was SHOWN to a player. binding.
create table blitz_quotes (
  quote_id          uuid primary key,
  player_id         text not null,
  game_id           text not null,
  config_id         bigint not null references blitz_configs(config_id),
  stake_cents       bigint not null,
  curve             jsonb not null,                -- FROZEN at generation
  profile_snapshot  jsonb not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  consumed_by_round uuid                           -- single use
);

create type round_status as enum ('active','settled','voided');

create table blitz_rounds (
  round_id        uuid primary key,
  quote_id        uuid not null unique references blitz_quotes(quote_id),
  player_id       text not null,
  game_id         text not null,
  stake_cents     bigint not null,
  curve           jsonb not null,     -- ★ COPIED from the quote. settlement reads ONLY this.
  seed            text not null,      -- server-issued world seed
  status          round_status not null default 'active',
  started_at      timestamptz not null default now(),
  deadline_at     timestamptz not null,
  heartbeat_score int not null default 0,
  heartbeat_at    timestamptz,
  submitted_score int,
  validated_score int,
  multiplier      numeric,
  payout_cents    bigint,
  settled_at      timestamptz
);
create index on blitz_rounds (status, deadline_at);
```

**The single most important line in the whole schema is `constraint ledger_idem_unique unique (idempotency_key)`.** Every settlement writes its payout row with key `'payout:' || round_id`. Every stake writes `'stake:' || round_id`. Double submission, a retry, a race between the client and the sweeper, a double tap — they all collide on that constraint and the second one is rejected by Postgres. You are not relying on your own code being careful. **Say this sentence in DECISIONS.md.**

### 6.2 Round lifecycle

```
 quote ──► enter ──► [playing, heartbeats] ──► submit ──► settled
                              │
                              └─ app killed / crash ──► sweeper ──► settled
```

**`POST blitzQuote { gameId, stakeCents }`** — no money moves. Loads profile, runs the target engine, freezes a curve, writes a `blitz_quotes` row with `expires_at = now() + ttl`. Invalidates any prior open quote for that (player, game) so a player can't hold a basket of curves and pick the best one later. Returns the curve for rendering.

**`POST blitzEnter { quoteId }`** — one `transaction()`:
```
SELECT ... FROM blitz_quotes WHERE quote_id = $1 FOR UPDATE
  → reject if consumed_by_round IS NOT NULL   (single use)
  → reject if expires_at < now()              (binding, but not forever)
SELECT cash_cents FROM players WHERE player_id = $1 FOR UPDATE
  → reject if < stake_cents  → 'insufficient balance' (a real UI state, per the brief)
INSERT ledger_entries (kind='stake', amount = -stake, key = 'stake:'||round_id)
UPDATE players SET cash_cents = cash_cents - stake
INSERT blitz_rounds (curve = <copied from quote>, seed = <server random>)
UPDATE blitz_quotes SET consumed_by_round = round_id
```
Stake is debited **at entry**, per the brief. `curve` is *copied into the round row*. Settlement never reads the quote, never reads the profile, never regenerates anything. **The player can only ever be paid on the curve they agreed to, because that is the only curve the settlement code can see.**

**`POST blitzHeartbeat { roundId, score, tick }`** — cheap, no transaction needed beyond a guarded update:
```sql
UPDATE blitz_rounds
   SET heartbeat_score = $2, heartbeat_at = now()
 WHERE round_id = $1 AND status = 'active' AND $2 > heartbeat_score;
```
Monotonic by construction. This row is what makes "settle at the last score the server saw" a real, defensible option rather than a hand-wave.

**`POST blitzSubmit { roundId, score, trace }`** — one `transaction()`:
```
SELECT ... FROM blitz_rounds WHERE round_id = $1 FOR UPDATE
  → if status = 'settled': RETURN THE EXISTING RESULT.  (idempotent read-back, not an error)
validated = replaySim(round.seed, trace)          ← §7
  → if validated ≠ submitted: log, flag, and settle on `validated`
multiplier = curveLookup(round.curve, validated)
payout     = Math.floor(stake_cents * multiplier)   ← ONE rounding rule, always floor
INSERT ledger_entries (kind='payout', amount=+payout, key='payout:'||round_id)
UPDATE players SET cash_cents = cash_cents + payout
UPDATE blitz_rounds SET status='settled', ...
UPDATE blitz_profiles (ratchet the target)
```

**`sweepStaleRounds`** — scheduled every minute:
```sql
SELECT round_id FROM blitz_rounds
 WHERE status = 'active' AND deadline_at < now() LIMIT 100
```
Settle each at `heartbeat_score` with the *same* `'payout:'||round_id` key. If the client comes back and submits at the same moment, one of them loses on the unique constraint. Exactly one outcome, always.

**Lock ordering rule:** always `players` → `blitz_quotes` → `blitz_rounds`. Consistent order, no deadlocks.

### 6.3 Gotchas the provided `db.js` is warning you about

Read its comments — they're a trap detector, and mentioning them in DECISIONS.md shows you read the code you were given:

- **Transaction-mode pooler forbids session state.** No `pg_advisory_lock()`. Use `FOR UPDATE` row locks only. No named prepared statements, no temp tables, no `LISTEN/NOTIFY`.
- `statement_timeout` and `idle_in_transaction_session_timeout` set in the pool config are **silently ignored** through the pooler. The `SET LOCAL` guards inside `transaction()` are the ones that actually apply.
- `max: 2` — gen-1 concurrency is 1 per instance. Don't fan out parallel queries expecting a big pool.
- **No transaction may do network I/O while open.** So: verify the Firebase ID token *before* `transaction()`, never inside it.

---

## 7. ★ Server authority — the deterministic replay

This is the play that scores top marks on the 30% and demonstrates the architecture for the 20%, with one piece of work.

**The insight: Chicken Run is a discrete, grid-based, fixed-step game. That makes it fully replayable.**

**Design:**

1. **The server issues the seed.** `blitzEnter` returns a `seed`. The client generates the entire world from it — lane type sequence, tree/rock placement, vehicle spawn schedule, train timings, log positions — via a `mulberry32`-style integer PRNG. The client cannot choose its own world.
2. **The client's only output is an input trace.** A packed list of `(tick, action)` where `tick` is an index into a **50 Hz fixed step** and `action ∈ {FORWARD, BACK, LEFT, RIGHT, CASH_OUT}`. That's a few hundred bytes.
3. **The server replays it.** `functions/sim/chickenRun.js` runs the identical simulation from the identical seed, applies the trace, and produces its own score. **The client's reported score is never used as the score** — it is only compared, and a mismatch is a flag.

**What makes it work:** the simulation must be bit-identical in C# and JS. So: **integers only.** Grid coordinates are `int`. Vehicle positions are integer sub-units (e.g. 1 lane = 1000 units, a car moves 37 units/tick). No `float`, no `Time.deltaTime`, no `Random`, no physics engine anywhere in `Sim/`. The renderer interpolates between tick states for smoothness; the simulation does not care.

**Day 4 is the cross-check test.** Generate 500 random seeds and random traces, run both implementations, assert identical scores. If that test is green, your score-trust story is genuinely strong rather than aspirational.

**Be honest about the holes** — the brief says explicitly that a candidate who ships one honest defence and a clear-eyed list of its holes scores better than one who claims the problem is solved:

| Attack | Caught? |
| --- | --- |
| Editing the score in memory / patching the score variable | **Yes** — the score is recomputed, not read |
| Replaying a previous winning submission | **Yes** — round_id is single-use and seed-bound |
| Submitting a fabricated high score | **Yes** — needs a valid trace, which means actually solving that world |
| Modified build that renders further ahead / shows incoming traffic early | **No** — the trace is legal, the player just had more information |
| A bot that plays the game perfectly | **No** — it's a legal trace. This is the real hole. |
| Slowing the client clock to think longer per hop | **Partly** — ticks are relative, so it's invisible in the trace. Mitigate with a wall-clock sanity band: reject if 3000 ticks (60s of sim) arrive within 6s of real time, and reject if the round took implausibly long relative to tick count. |
| Solving the world offline before playing (the seed is known to the client) | **No** — an optimal-path solver is the strongest attack against a seeded design. Mitigate by *streaming* the seed in chunks tied to heartbeats, so the client only knows the next ~15 rows. Note as future work; probably out of scope for 10 days. |

**"What I'd build next, in order"** (the brief asks for this explicitly):
1. Play Integrity API attestation on `blitzEnter` — kills the modified-build class outright.
2. Chunked seed delivery — kills offline solving.
3. Input-timing entropy analysis: humans have jitter, bots have periodicity. Score the trace's inter-input interval distribution.
4. Per-player anomaly scoring against their own profile — a player who jumps from a 14 median to a 42 gets held for review rather than paid.
5. Server-side shadow simulation of a *skill ceiling*: reject scores beyond what any human trace has achieved on that seed class.

---

## 8. The target engine

`blitz_configs.params` (JSONB — data, not code, retunable without a rebuild). Document every parameter, as the brief demands.

```json
{
  "cold_start": {
    "seed_target": 12,
    "bootstrap_rounds": 3,
    "bootstrap_cap_multiplier": 1.5,
    "bootstrap_max_stake_cents": 100
  },
  "ratchet": {
    "up_alpha":   0.45,      // fast up:  target += 0.45 * (score - target) when score > target
    "down_alpha": 0.08,      // slow down: target += 0.08 * (score - target) when score < target
    "max_up_step":   4,
    "max_down_step": 2
  },
  "curve": {
    "shape": [               // rel = score / target ; the curve is stake-invariant
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
    "max_target_vs_pb": 0.92,     // ← the answer to design question 1
    "idle_decay_per_day": 0.04
  },
  "quote_ttl_seconds": 180,
  "stake_tiers_cents": [100, 300, 500, 1000, 2000]
}
```

Two notes that matter for the review:

**The curve is defined in `rel` space (score ÷ target), so it is identical at every stake tier.** The player learns one shape. It also means the payout screen looks the same whether they bet $1 or $20, which is honest.

**`max_target_vs_pb: 0.92` is the whole answer to the ceiling problem.** The break-even score can never be set above 92% of the player's own rolling personal best over the last 20 rounds. A player literally cannot be pushed past their demonstrated maximum. Show the RTP cost of this in the harness — that's what makes it an argument rather than an assertion.

### The Cash Out wrinkle — do not miss this

The brief flags it and most candidates will skim past it: **your target engine is modelling a player who can bank at will.** Score is not a pure function of skill. It's `min(skill_reach, wherever_they_chose_to_stop)` — with a death-hazard that zeroes them if they push too far.

Consequences you should build for and write about:

- A player who cashes out early *every* round produces a low, low-variance score history. Ratchet on the mean and their target drifts down and they farm easy 1.0x. **Ratchet on a high percentile of the recent window (p70), not the mean.**
- The payout screen must therefore show the player the *decision*, not just the curve: the break-even score, their current score live during play, and the next multiplier step. That's the thing that makes Cash Out tense instead of arbitrary. It's also 10% of the grade.
- Your synthetic players in the harness need a **cash-out policy**, not just a skill number. Model at least three: `always_bank_at_breakeven`, `greedy_to_2x`, `push_until_death`.

---

## 9. Recommended stances for `DECISIONS.md`

Draft these as you go. My recommendations, with the reasoning that makes each defensible:

**Quote lifetime: 180 seconds.** Long enough to actually read a curve and decide; short enough that the profile snapshot behind it is still true. Also bounds the "open twenty quotes, come back and enter the friendliest one" attack — combined with single-use quotes and one open quote per (player, game).

**Interrupted round: settle at the last server-acknowledged heartbeat score.** Reason through the alternatives out loud:
- *Forfeit at zero* punishes the player for your network. In a cash app that's the fastest route to a chargeback and a bad review.
- *Refund the entry* is worse: it hands the player a **free option**. Play; if the run is going badly, kill the app; get your money back. That is a strictly dominant strategy and it breaks the mode.
- *Settle at the heartbeat* has no free option and no unfair loss. Kill the app on a bad run and you bank the bad score, which is what would have happened anyway. Deadline = start + 15 minutes; the sweeper resolves it.

**Stake tiers: $1 / $3 / $5 / $10 / $20** — matching the app's stated $1–$20 range, with $3 anchoring to the competitor screenshot. Curve shape is identical across tiers (see §8).

**Sub-break-even band: pay 0.2x below break-even, down to a floor.** The reference screenshot's curve visibly continues below the break-even line and its lowest axis tick is below it. Reasoning: a near-miss that pays literally nothing makes the mode feel punitive on the loss that matters most (the one where you *nearly* made it). A small consolation band costs a couple of RTP points and buys a lot of retention. **Flag this as an assumption on Telegram** since the brief doesn't state it.

**Target RTP: 88%.** Defend it with three harness runs — 82%, 88%, 94% — showing for each: RTP, win rate, and median rounds-to-bust from a $20 bankroll. The argument: at 82% the median player busts too fast to form a habit; at 94% the mode doesn't pay for the platform; 88% keeps a median player alive long enough to learn the game while leaving a defensible margin. **Put the actual table in DECISIONS.md.**

**Cold start:** first 3 rounds per (player, game) draw their target from a global baseline percentile for that game, capped at 1.5x and $1 stake. Anti-farm: the bootstrap allowance is a **lifetime** count on `(player_id, game_id)`, not a rolling window — it cannot be re-earned. It is consumed by rounds *entered*, not rounds won, so you can't farm it by abandoning. Multi-accounting is a KYC problem and KYC is explicitly out of scope; say so rather than pretending you solved it.

**Per-game targets, not shared.** A Chicken Run score of 40 and a Pop Shot score of 9 are not commensurable — pooling them produces a number that means nothing and mis-targets both games. The rotation exploit is real but *bounded* by the cold-start caps above: rotating to a fresh game buys you at most 3 rounds at ≤1.5x on ≤$1 stakes. That's a few dollars of edge, once, per game, per lifetime. Cheaper than the alternative.

**"The line."** Give them a number, not a sentiment: *"A mode is designed so the player cannot win when the break-even score sits above the player's own recent 75th percentile, because then a good session still loses. I built on the side where break-even sits near the recent p60 and is hard-capped at 92% of demonstrated personal best. The house edge comes from variance and from the cash-out decision being genuinely hard — not from an unreachable target. The ceiling guard exists specifically so the ratchet can never cross that line, and here is the harness output showing that a p95 player and a p20 player both stay above 70% RTP after 200 rounds."*

**Chicken Run idle threshold** (the brief asks you to state it and say why): *"The shadow starts 4 rows behind your furthest row, advances 1 row per 1.1s after a 2.5s grace, and snaps back whenever you advance. In practice you die after roughly 6 seconds of not moving forward. Why 6: it's long enough to wait out a train cycle or a gap in traffic — the two legitimate reasons to stand still — and short enough that you cannot idle safely on a grass lane while a Blitz shot clock… "* (and here's the good bit) *"…there is no shot clock, which is why the threshold has to be this tight: without it a Blitz player who has hit their 2.5x band would simply stand still forever rather than risk anything, and the mode would have no ending."* That last clause is the kind of observation that gets noticed.

**Buzzer-beater** (if you get to Pop Shot): *"The last shot is defined as the shot in flight when the clock crosses zero. Time-out is evaluated only when the ball is not airborne; if the clock hits zero mid-flight, the game enters slow-motion and defers the end. If it goes in: +5s, +2 score, celebration, play continues. If it misses: game over on landing. It can trigger repeatedly — each trigger is just another shot in flight at zero — but the added time shrinks by 1s each time (5, 4, 3…) to a floor of 1s, so it terminates."* That resolves the circularity the brief calls out, and it terminates provably.

**Shot control** (Pop Shot): single tap = fixed upward impulse, position irrelevant, ball carries constant forward velocity. Confirmed from the recording. Say what you tried and rejected: charge-and-release (kills the flow, and the reference clearly isn't doing it), and drag-to-aim (turns a one-thumb reflex game into a two-hand aiming game). The skill is *rhythm* — timing taps to shape the arc.

---

## 10. Questions to post in the Telegram group on Day 1

The brief says asking is a positive signal. These are the real ambiguities, not filler:

1. **The deliverables section says to answer "every *feature thoughts* prompt in your personal assignment document."** This document has no section by that name. Is there a separate personal assignment doc I should have, or does that map to §2.6 Design Questions and §3's two Pop Shot questions here?
2. **Below break-even — zero, or a partial multiplier?** The reference payout screen's curve visibly continues below the break-even line and its lowest axis tick is below break-even, which suggests a consolation band exists. I'm assuming ~0.2x unless told otherwise.
3. **Does Blitz stake in cash only, or gems too?** The intro mentions "money or gems"; the Blitz section is all cash.
4. **Should Blitz coexist with the free Practice Mode in the same build?** The screenshots show a practice mode with its own leaderboard; I'm assuming yes, and that Practice is what a player gets when `blitz_enabled = false`.
5. **Prize Wheel** — visible on the reference result screen. Assuming out of scope.
6. **Is a scores/leaderboard list expected on the Blitz result screen?** Solo mode has no opponent, but the practice screenshot shows high score + past scores.
7. **Deposits** — is a mock deposit flow in the UI required, or is a pre-seeded balance on the test account sufficient?

---

## 11. The 10-day plan

| Day | Work | Done when |
| --- | --- | --- |
| **1** | RN 0.86 + Unity 6 embed spike (§4). Supabase + Firebase setup. `001_init.sql` applied. `SELECT 1` through a deployed callable. Telegram questions posted. | Cube renders in RN, messages round-trip both ways, DB reachable from a function |
| **2** | Chicken Run `Sim/` — integer grid, fixed 50 Hz step, seeded lane generation, hop/blocked-hop, no art. Grey-box playable in the editor. | You can play a grey-box run and the score counts |
| **3** | Hazards: cars, trucks, trains + signals, river/logs/lily pads, death. Advancing-shadow idle system. Cash-out press-and-hold with the ring. First feel pass — hop timing, camera smoothing, input buffering. | It's *fun* in grey-box. If it isn't fun grey-boxed, art won't save it |
| **4** | ★ Port `Sim/` to `functions/sim/chickenRun.js`. Cross-check harness: 500 random seeds × random traces, assert C# and JS agree exactly. | The determinism test is green |
| **5** | Money layer end to end: ledger, quote / enter / heartbeat / submit / sweep. Tests for concurrent double-submit, submit-after-sweep, insufficient balance, expired quote. | You can force a double-submit and the second one returns the first result |
| **6** | Target engine + `blitz_configs` + the tuning harness. Run the 82/88/94 sweep. Commit the CSVs and the chart. Pick and seed the shipping config. | You can point at the number that made you choose 88% |
| **7** | RN UI: lobby, payout screen with the curve chart, entry confirmation, result screen. **Every state**: loading, error, insufficient balance, win, loss. Transitions. | It looks like a screen you'd hand money to |
| **8** | Art, audio, haptics, juice on Chicken Run. Squash-and-stretch on the hop, screen shake on death, coin burst on cash-out. Practice/Blitz toggle proven by flipping `blitz_enabled`. | The 25% category is earned |
| **9** | **Gate check.** If Days 1–8 are genuinely done: start Pop Shot. If anything above is shaky: fix it instead, and cut Pop Shot in writing. Either way, demo the edge cases on a real device — kill the app mid-round, submit twice, go offline. | The cut decision is made deliberately, not by running out of time |
| **10** | `README.md` (clean-checkout instructions, exact versions, platform, test account + password). Finish `DECISIONS.md`. Record the device screen capture showing every feature. Build the release APK. Final commit pass. | All six deliverables in §"What you deliver" exist |

**Commit discipline:** they said explicitly they read the history. Small commits, one concern each, conventional messages. Commit the harness output as you generate it, not in one dump at the end — the history should show you *deciding* the config, not announcing it.

---

## 12. Cut lines, in order

If time compresses, cut in exactly this order and write down each cut:

1. Pop Shot entirely (it's a bonus on a 10% category)
2. Buzzer-beater slow-mo (if Pop Shot happened at all)
3. Haptics beyond a basic hit/death pattern
4. Lily pads (keep logs — the river still reads)
5. Trains (keep cars — the road still reads)
6. The result-screen leaderboard

**Never cut, at any cost:** the ledger unique constraint, curve-copied-into-round, the sweeper, the determinism cross-check test, `DECISIONS.md`. Those five are the submission.

---

## 13. The one-line version

> Prove the Unity embed builds on Day 1. Build the Chicken Run simulation as pure integer logic so the server can replay it. Make the database, not your code, the thing that prevents double-payment. Write `DECISIONS.md` as you go. Pop Shot is a bonus you earn on Day 9, not a goal.
