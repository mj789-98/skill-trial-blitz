# DECISIONS

Written incrementally as the build progressed, not retrofitted at the end. Where
an entry says a thing was measured, the measurement is in
[`docs/tuning-report.md`](docs/tuning-report.md) or in a test.

Each entry states the call, the alternatives, and what would change my mind.
Entries are numbered in the order the decisions were made, which is not always
the order they are best read in — the index is the better way in.

**Index**

| | |
| --- | --- |
| [D-001](#d-001--target-platform-android) | Target platform: Android |
| [D-002](#d-002--unity-editor-version-install-the-pinned-6000113f1) | Unity editor version |
| [D-003](#d-003--unity-embed-package-azesmwayreact-native-unity111-unforked) | Unity embed package |
| [D-004](#d-004--idle-threshold-69-seconds-as-an-advancing-line-not-a-timer) | **Idle threshold — 6.9s** (§2.9) |
| [D-005](#d-005--server-authority-by-deterministic-replay) | Server authority by deterministic replay |
| [D-006](#d-006--the-simulation-uses-no-floating-point-at-all) | No floating point in the simulation |
| [D-007](#d-007--a-quoted-curve-stays-valid-for-180-seconds) | **Curve validity — 180s** (§2.5.1) |
| [D-008](#d-008--an-interrupted-round-settles-at-the-acknowledged-score) | **Interrupted rounds** (§2.5.2) |
| [D-009](#d-009--entry-fees-are-tiers-and-the-curve-is-scale-free) | **Entry fee tiers** (§2.5.3) |
| [D-010](#d-010--the-ceiling-problem) | **The ceiling problem** (§2.6.1) |
| [D-011](#d-011--cold-start-and-why-the-first-rounds-are-not-farmable) | **Cold start** (§2.6.2) |
| [D-012](#d-012--rtp-864-and-why-not-88) | RTP 86.4%, and why not 88% |
| [D-013](#d-013--targets-are-per-game-not-shared) | **Multiple games** (§2.6.3) |
| [D-014](#d-014--the-line-between-hard-and-unwinnable) | **Hard vs unwinnable** (§2.6.4) |
| [D-015](#d-015--threat-model-what-the-defence-catches-and-what-it-does-not) | Threat model |
| [D-016](#d-016--a-state-machine-instead-of-a-navigation-stack) | State machine, not a navigator |
| [D-017](#d-017--firebase-js-sdk-against-a-demo-project) | Firebase JS SDK, demo project |
| [D-018](#d-018--what-was-cut) | What was cut |
| [D-019](#d-019--what-id-build-next-in-order) | What I'd build next |
| [D-020](#d-020--where-i-leaned-on-ai-and-where-i-deliberately-did-not) | **Where I leaned on AI** |
| [D-021](#d-021--what-running-it-on-a-phone-found) | **What running it on a phone found** |
| [D-022](#d-022--pop-shot-portrait-and-one-ball-that-never-leaves) | **Pop Shot: portrait** (4.2) |
| [D-023](#d-023--the-shot-control-curve-and-what-i-tried) | **The shot control curve** (4.9) |
| [D-024](#d-024--the-buzzer-beater-defined-precisely) | **The buzzer-beater, defined** (4.10) |
| [D-025](#d-025--what-the-second-game-taught-the-target-engine) | What the second game taught the engine |

---

## D-001 — Target platform: Android

**Call.** Android only.

**Why.** The brief prefers iOS but states plainly that "Android is completely fine and
nothing is penalised for choosing it", and that supporting both is explicitly out of scope.
Development is on a Windows machine with no macOS host, so iOS was never actually available.

**What it costs.** Nothing against the rubric. The deliverable is an APK rather than an
Xcode project.

---

## D-002 — Unity editor version: install the pinned 6000.1.13f1

**Call.** Installed `6000.1.13f1` (changeset `418bd0acaa6b`) rather than reusing the
`6000.4.0f1` already on the machine.

**Why.** The versions table is the one thing the brief explicitly says to pin. The only cost
of complying is download time, which overlapped with backend work that does not need Unity.
`6000.4.0f1` would have worked, but "I deviated from the single pinned table to save myself
an afternoon" is not an answer worth giving in a review.

---

## D-003 — Unity embed package: `@azesmway/react-native-unity@1.1.1`, unforked

**Call.** Use the published `1.1.1` as-is. No fork.

**Why.** The brief deliberately leaves this one unpinned because it is the piece most likely
to break against React Native 0.86, and 0.86 is New-Architecture-only — the legacy bridge was
removed in 0.85. The package's issue tracker still carries "Unimplemented Component:
`<ReactNativeUnityView>`" reports, which is the classic symptom of a view never registered as
a Fabric component, so the plan budgeted for forking it to add a codegen spec.

Inspecting `1.1.1` rather than the `1.0.7` the plan assumed, that work is already done:

- `package.json` declares `codegenConfig` with `"type": "components"`.
- `src/specs/UnityViewNativeComponent.ts` is a real Fabric spec — `codegenNativeComponent`
  plus `codegenNativeCommands` exposing `postMessage`, `unloadUnity`, `pauseUnity`,
  `resumeUnity` and `windowFocusChanged`.
- `android/src/newarch/` carries a `ReactNativeUnityViewManagerSpec` extending the generated
  `RNUnityViewManagerInterface`, selected by an `isNewArchitectureEnabled()` branch in
  `android/build.gradle`, which also declares a `namespace` (required by AGP 8).
- The spec registers the component as `RNUnityView`, which is exactly the name the generated
  `RNUnityViewManagerInterface`/`Delegate` that the Java refers to would be derived from. The
  two halves agree, so this is not a spec that was added and left unwired.

`windowFocusChanged` being exposed as a command also matters: it is the documented fix for
the black-screen-on-resume failure, so that mitigation is available without patching.

**What it did cost.** One `patch-package` patch: the module's Gradle file still lists
`jcenter()`, which Gradle 9 removed outright, so the build fails at configuration time.
The patch deletes that one line — `mavenCentral()` is already there beside it — rather
than forking the package, because a one-line repository removal is not worth owning a
fork for.

---

## D-004 — Idle threshold: 6.9 seconds, as an advancing line rather than a timer

*The brief asks for this decision explicitly: "if you idle too long the game ends —
you decide the threshold, state it, and say why."*

**Call.** **6.9 seconds** of no forward progress ends the round. It is not implemented
as a countdown. A kill line sits 4 rows behind the chicken and, after a 2.5-second
grace period, advances one row every 1.1 seconds. If it reaches you, the round ends
as a death and the score is zero.

```
grace 2.5s  +  4 rows × 1.1s  =  6.9s worst case
```

Constants: `IDLE_GRACE_TICKS = 125`, `IDLE_STEP_TICKS = 55`, `IDLE_LEAD_ROWS = 4`,
at `TICK_HZ = 50` (`functions/sim/chickenRun.js`).

**Why 6.9 and not 3 or 15.** The threshold has to do two jobs at once, and they pull
against each other:

- **Stop stalling being a strategy.** Without it, the optimal play in a traffic row is
  to stand on a safe tile and wait for a gap that is guaranteed to arrive, forever. That
  turns a reaction game into a patience game and makes every target trivially reachable.
- **Not punish reading the board.** Crossy-Road-style play has a real rhythm: hop, hop,
  hop, *stop and look at the train*, hop. Three seconds kills that. Fifteen is long
  enough that stalling is still the best move.

The number is anchored to the traffic rather than picked round. Lane speeds are
40–110 sub-units/tick over a 9-cell track, so a lane's pattern repeats every
**1.6s to 4.5s**. 6.9 seconds is therefore between roughly 1.5 and 4 full
repetitions — enough to watch a pattern come round at least once and *read* it,
and not enough to stand still and *wait one out*.

**Why a line and not a timer.** Three reasons, in order of how much they mattered:

1. **It is visible.** A timer is a number in a corner that a player does not look at
   while concentrating. A shadow creeping up behind you is legible without reading
   anything, and it tells you not just *that* you are running out of time but *how
   much* — the gap is the countdown.
2. **It is directional.** Idling is about not making *forward* progress. A line that
   chases the furthest row you have reached encodes that exactly: shuffling sideways
   to line up a gap does not reset it, but it does not accelerate it either.
3. **It creates pressure rather than a cliff.** A timer ends the round at an instant
   the player did not feel coming. A line makes the last two seconds *tense*, which is
   the thing the mode is actually selling.

**What it costs.** It is more state than a timer, and it has to be identical on both
sides of the bridge — the line's position is part of the replay, so a C#/JS divergence
here would be a divergence in the score. It is covered by the parity test (D-005).

**What would change my mind.** Watching real players. If the recording shows people
being killed by the line while genuinely reading the board, the grace period is the
dial to turn, not the step rate — lengthening the grace forgives hesitation without
making stalling viable again.

---

## D-005 — Server authority by deterministic replay

**Call.** The server issues a seed. The client generates its entire world from that
seed, plays, and returns the **list of inputs it made**, indexed by fixed-step tick.
The server re-simulates those inputs against the same seed and computes the score
itself. The client's own score is carried for comparison only.

**Why this rather than the alternatives.**

- *Trust the client's score.* Rejected: it is the thing the brief exists to test.
- *Run the game on the server.* Correct, and wrong for this shape of product — it
  needs realtime netcode, which the brief puts out of scope, and it makes every hop
  a round trip.
- *Statistical anomaly detection.* Catches populations, not individuals, and only
  after they have been paid. Useful as a second layer, not a first one.
- **Deterministic replay** costs one simulation per settlement (~1ms), needs no
  realtime connection, and gives an exact answer rather than a probable one.

**The consequences that make it work.**

- The world is a **pure function of `(seed, row, tick)`**. Traffic, trains and logs
  are computed from that triple, not accumulated. Nothing drifts, and the server can
  evaluate the state at tick 900 without simulating ticks 1–899 of scenery.
- The seed is **server-issued**, so a player cannot re-roll for a favourable world.
- The trace is **bound to the round**, so a good trace cannot be replayed into a
  second round: the seed differs, and the same inputs produce a different outcome.
- A trace is a few hundred bytes (three bytes per input: a uint16 tick delta and an
  action byte), which is small enough to store on every round for later audit.

**What it does not solve.** See D-015.

---

## D-006 — The simulation uses no floating point at all

**Call.** Positions are integers in 1/1000ths of a cell. No `float`, no `double`,
anywhere in `Sim/`.

**Why.** The simulation runs twice — once in C# (IL2CPP, ARM64, on a phone) and once
in JavaScript (V8, on a server) — and the two have to agree **exactly**, because the
difference between agreeing and nearly agreeing is the difference between a payout and
a dispute. IEEE-754 does not guarantee that: compilers are allowed to contract `a*b+c`
into a fused multiply-add, `Math.Sin` is not bit-specified across runtimes, and x86 and
ARM disagree about intermediate precision. Integers have none of those freedoms.

The one place the languages genuinely differ is integer division of negatives — C#
truncates toward zero, JS `Math.floor` rounds toward negative infinity — so the C# port
carries an explicit `FloorDiv` rather than relying on `/`.

**How it is verified.** `tools/` exports 500 traces from the JS simulation and replays
them in Unity, comparing score, end reason, tick count and furthest row. All 500 match,
covering all four end reasons. This is checked by regeneration rather than by reading
the two files side by side — the one refactor that renamed a namespace was proved
behaviour-neutral by the export coming back byte-identical.

---

## D-007 — A quoted curve stays valid for 180 seconds

*Explicitly asked for by the brief: "how long a locked curve stays valid."*

**Call.** **180 seconds** (`quote_ttl_seconds`, in config, per game).

**Why not longer.** The curve is generated from the player's profile at the moment it
is shown. A player who opens the payout screen, puts the phone down, plays six rounds
tomorrow and then taps *Play* is holding an offer priced against a person who no longer
exists. Worse, it is exploitable in one direction only: hold a generous quote from a low
target, go and deliberately tank a few rounds, and the stale quote is now strictly better
than what the engine would offer. An expiry closes that without needing to detect it.

**Why not shorter.** 30 seconds is long enough to read the curve but not long enough to
be interrupted. Being interrupted for a minute is completely normal on a phone, and
coming back to *"that offer expired"* on a screen you did not do anything wrong on is a
bad experience for a real problem that almost never happens.

180s is roughly "you got distracted" but not "you went away".

**Two things that make the expiry honest.**

- It is evaluated by the **database clock**, not the server's. Two Function instances can
  disagree about the time; Postgres cannot disagree with itself, and it is what wrote
  `expires_at`.
- The payout screen **shows the countdown** and, when it lapses, re-quotes itself rather
  than failing at the moment of payment. An expiry the player can see is a rule; an
  expiry they discover by being refused is a bug.

**Related: one open quote per (player, game).** A new quote supersedes the old one.
Without that, a player could open the screen repeatedly, collect several live quotes,
and enter on whichever was most generous — turning a targeting system into a slot machine
they get to re-roll.

---

## D-008 — An interrupted round settles at the acknowledged score

*Explicitly asked for: "what happens to a round that is interrupted."*

**Call.** A round has a deadline (`round_deadline_seconds`, 900s). A sweeper runs every
minute and settles any round past its deadline **at the last score the server
acknowledged via a heartbeat**, using the same code path and the same idempotency key as
a normal submit. It does not refund, and it does not forfeit.

**Why not refund.** Refunding hands the player a free option: start a round, see it going
badly, kill the app, get the money back. That is a *strictly dominant strategy* — a
rational player would never finish a bad run again — and it destroys the mode.

**Why not forfeit at zero.** That punishes someone for a dropped connection or a phone
call. In a cash app, that is how you earn a chargeback, and it is unfair in the ordinary
sense as well.

**Why the acknowledged score works.** Killing the app on a bad run banks the bad run,
which is exactly what would have happened anyway. There is no upside to quitting and no
penalty for being interrupted. The incentive is neutral, which is the property you want.

**The problem this creates, and the fix.** It makes *"report an enormous score, then never
submit"* the cheapest attack in the system, because a heartbeat is an unverified claim.
The heartbeat is therefore **bounded by physics**: the simulation refuses inputs faster
than one per 120ms (`HOP_COOLDOWN_TICKS = 6` at 50Hz), so a round cannot legitimately
have gained more than **8.33 rows per second**. The server measures elapsed time on the
**database clock** and clamps any claim to `elapsed × 8.33 × 1.5`, with the 1.5 as slack
for clock skew and network delay. The bound is re-applied at settlement as well as at
write time, so a heartbeat written by an older build still cannot pay above what is
physically possible.

A round abandoned before scoring anything settles at zero and leaves **both** a stake row
and a payout row. The money is accounted for, not vanished.

**Tested.** A submit racing the sweeper produces exactly one payout — the two are
independent processes, both entitled to settle, and the loser collides on
`UNIQUE (idempotency_key)` rather than paying twice.

---

## D-009 — Entry fees are tiers, and the curve is scale-free

*Explicitly asked for: "the entry fee tiers, and how they relate to the curve."*

**Call.** Five tiers: **$1, $3, $5, $10, $20** (`stake_tiers_cents`, in config). The
curve is defined in **relative space** — score as a fraction of the target, multiplier as
a multiple of the stake — so **one shape serves every tier**.

**Why tiers rather than a free amount.** An arbitrary stake is a stake the economics were
never tuned for. Tiers also make the harness meaningful: measuring five points is a
finding, measuring a continuum is a chart nobody reads. And the brief's range is $1–$20,
which five tiers cover with the spacing people actually recognise.

**How the tiers relate to the curve: they don't, and that is the point.** The shape is
`{rel, mult}` pairs — `rel` is score ÷ target, `mult` is payout ÷ stake. Materialising it
for a round multiplies `rel` by the player's target and `mult` by their stake. So:

- The *shape* of the offer is identical at $1 and $20. A player learning the game at $1
  is learning the same curve they will play at $20.
- Retuning the economics is one config edit, not five.
- The stake never influences the target. Paying more does not buy an easier round, which
  it would if the two were coupled — and that coupling is how a skill mode quietly turns
  into a pay-to-win one.

**Multipliers are integer basis points** in the money path (10000bp = 1.00x). The
displayed `2.50x` is derived from the basis points by the *server*, so the client never
has to compute one from the other and get a different answer.

**The cap is a ceiling, not a dial.** `cap_multiplier` clamps the shape rather than
scaling it, so a cap set above the shape's own top point does nothing — sweeping it
2.5 / 3.0 / 3.5 gives 84.4% / 86.4% / 86.4% RTP. That is deliberate and worth stating
plainly, because it looks like a bug in the sweep: a cap that *stretched* the curve would
silently make every payout bigger the moment someone raised a safety limit. The dial for
the top end is the shape's last point.

---

## D-010 — The ceiling problem

*The brief's question: "a player who is good at the game will keep hitting their target,
and their target keeps rising. At some point it stops being reachable. How do you stop
the mode from quietly becoming unwinnable for your best players — and back the claim with
the harness."*

**Call.** Three bounds, applied in a fixed order of precedence, and the ceiling wins.

1. **A hard floor.** `min_target = 5`. A target cannot become trivial.
2. **A demonstrated-ability floor.** The target may not fall below `0.45 ×` the **90th
   percentile** of the recent window. This is the anti-farm bound (D-011).
3. **A ceiling, applied last.** The target may never exceed **0.92 × the rolling personal
   best** over the last 20 rounds. This is the answer to the question.

The ceiling being applied *last* is the whole design. The floor protects revenue; the
ceiling stops the mode selling an unwinnable round. Those are not comparable stakes, so
when they conflict the ceiling wins — even when that means the target drops below what
the anti-farm rule wanted.

**Why 0.92 rather than 1.0.** The target must be *reachable*, not *matchable*. Setting it
at 100% of a personal best means clearing it requires equalling your best-ever run, which
happens rarely by definition. 0.92 means a good run clears it.

**Why the ratchet is asymmetric.** `up_alpha = 0.45`, `down_alpha = 0.08`, with per-round
step caps of +4 and −2. Targets chase good play quickly and forgive bad play grudgingly.
A single lucky run cannot spike a player out of reach, because the step cap bounds the
rise regardless of how large the gap is.

**There is also a decay.** `idle_decay_per_day = 0.04`. Skill fades; a player returning
after a month should not be met with a target set at their peak.

**What the harness says.** Across 2,100 synthetic players and 60 rounds each, no cohort
is priced out: `expert-greedy` (mean reach 41) plays 60 of 60 rounds with a 0% bust rate,
and the strongest disciplined cohort clears its target **61.8%** of the time. If the
ceiling were failing, those clear rates would fall toward zero over a career. They do not.

**What the harness also says, which is less flattering.** See D-014 — the *opposite*
failure is the one that actually shows up.

---

## D-011 — Cold start, and why the first rounds are not farmable

*The brief's question: "a brand new player has no history. What do you show them, and
what stops the first N rounds being the most farmable thing in the product?"*

**What they see.** A global baseline target (`seed_target = 12`, the game's own average
rather than anything personal), a **capped multiplier** of 1.5x instead of 3.0x, and a
**capped stake** of $1. The payout screen says so in plain language: *"Entries are capped
while we work out how you play."*

**What stops it being farmed.** The obvious attack is: play the friendly unmodelled
rounds, then abandon or reset to get more of them. Three things close that.

1. **The allowance is consumed at ENTRY, not at settlement.** A player cannot spend the
   starter rounds, abandon the ones going badly, and still have the allowance left. This
   is the load-bearing one, and it is a one-line ordering decision inside the same
   transaction that debits the stake.
2. **The allowance is lifetime**, per `(player, game)`, and never resets. There is no
   "inactive long enough to be a new player again" path.
3. **The window is worth almost nothing.** 3 rounds × $1 × 1.5x caps the total extractable
   value of a perfectly-played cold start at **$4.50 gross, $1.50 net**. Even a perfect
   exploit is not worth the effort, which is a better defence than a clever rule.

**What it does not stop.** Creating new *accounts*. That is a Firebase Auth and
device-attestation problem, not a target-engine problem, and it is out of scope here —
noted in D-015 rather than pretended away.

---

## D-012 — RTP 86.4%, and why not 88%

**Call.** The shipped config `tuned-v1` returns **86.4%** to the population, with a
**40.6%** win rate and a **13.2%** bust rate over 60 rounds.

**How it was picked.** By measurement, not assertion. The harness runs 2,100 synthetic
players against the *shipping* engine code and reports RTP, win rate and rounds-to-bust
per archetype. The full table and the variants either side are in
[`docs/tuning-report.md`](docs/tuning-report.md).

**Two defects the harness found in the config I would otherwise have shipped.**

- **The target *was* break-even.** The original shape had `rel 1.00 → mult 1.0`, so a
  player who did exactly what the payout screen asked for got their entry back and
  nothing else. Measured win rate for both disciplined cohorts: **0.0%**. Break-even now
  sits at 55% of the target and reaching the target pays **1.62x**. This is the single
  biggest change, and I would not have found it by reading the config.
- **The cap never bound.** Sweeping `cap_multiplier` 2.5 / 3.0 / 3.5 on the old config
  gave 59.5% / 61.1% / **61.1%** — identical above 3.0, because the shape's own top point
  was 3.0. See D-009.

**Why 86.4% and not the 88% I was aiming at.** The frontier is sharp:

The only thing that moves the headline much is the multiplier paid at the target.
Measured at 300 players per archetype, same seed, same population:

| `mult(target)` | population RTP | strong-disciplined cohort |
| --- | --- | --- |
| 1.55 | 84.5% | 97.2% |
| **1.62 — shipped** | **86.4%** | **100.3%** |
| 1.68 | 88.0% | 104.7% |
| 1.72 | 89.0% | 107.7% |

88% is available, at 1.68. It puts the strong-disciplined cohort at **104.7%** — the mode
paying its best players to play. 1.62 is the last point before that cohort goes
net-positive, and 86.4% is what it returns. Given a choice between a rounder headline
number and a config where every cohort's economics hold, the second is the one I can
defend in a room.

(An earlier draft of this table quoted 88.0% at `mult(target) = 1.64`. That came from a
smaller sample on a slightly different shape, and re-measuring at a consistent sample size
moved it. The numbers above are the consistent run — which is the point of having a
harness rather than a memory.)

**What I would want before shipping this for real.** These are synthetic players. The
population mix is my estimate, and the RTP is only as good as that estimate. The first
thing real data should do is replace `POPULATION` in `tools/sim/player.js` with measured
archetype weights and re-run.

---

## D-013 — Targets are per game, not shared

*The brief's question: "if you added a second mini-game, does a player's target come with
them, or do they start again?"*

**Call.** Per game. `blitz_profiles` is keyed on `(player_id, game_id)`. A player who has
played 200 rounds of Chicken Run arrives at Pop Shot with no history and gets the cold
start (D-011).

**Why.** The target engine models *"how far does this person get at this game"*. That
number does not transfer, because the skills do not: Chicken Run is pattern reading and
timing under a moving threat; Pop Shot is an analogue aim-and-power gesture. Someone
excellent at one has demonstrated nothing about the other.

Carrying a target across would fail in both directions, and both failures are bad:

- A strong Chicken Run player would be handed a Pop Shot target they cannot reach, and
  the mode would look rigged on their very first paid round of a new game.
- A weak Chicken Run player would be handed a soft Pop Shot target, and if they happen to
  be good at basketball, that is a farm.

**What it costs, and the mitigation.** Every new game costs the player another cold start.
That is real friction, and the answer is not to share targets — it is that the cold start
is *cheap and honest*: capped stake, capped multiplier, three rounds, and a screen that
says why.

**What IS shared, deliberately.** Money. One balance, one ledger, across all games. The
money path never touches game-specific code — only two files in the whole system enumerate
games (`functions/sim/index.js`, the validator registry, and Unity's `GameHost`), and
neither is on the settlement path. Adding a game is registering a validator; it is not
touching the ledger.

**Where I would revisit this.** A *cross-game* signal — "this account is generally
trustworthy / generally skilled" — is useful for cold start, but as a prior on the
starting target, not as the target itself. That is a real feature and it is not built.

---

## D-014 — The line between hard and unwinnable

*The brief's question: "where is the line between a hard target and an unwinnable one,
and how do you keep the mode on the right side of it?"*

**The line I use.** A target is *hard* if a good run clears it and a mediocre run does
not. It is *unwinnable* if clearing it requires a run better than the player has ever
produced. That is exactly what `max_target_vs_pb = 0.92` encodes: never ask for more than
92% of a demonstrated best.

But "unwinnable" is not the only way to be on the wrong side of the line, and the harness
made me change my answer here.

**The failure that actually showed up is the opposite one.** Measured, on the shipped
config:

| cohort | mean reach | mean target | clears it |
| --- | --- | --- | --- |
| strong-disciplined | **19.9** | **9.4** | 61.8% |

A player who can reach 20 is being asked for 9. That is not unwinnable — it is *too easy*,
and it is why that cohort sits at 100.3% RTP.

**Why the engine cannot see it.** Cashing out **censors** the observation. When a player
banks at 10, all the server learns is "they could reach at least 10" — not that they could
have reached 25. So a disciplined player's scores *are* their target, the 70th percentile
of those scores is their target, the gap the ratchet chases is zero, and **the target is a
fixed point of its own update**. The engine is stable and wrong.

**What I tried, and reverted.** The information that survives censoring is not *how far*
they got but *how often* they cleared it. I implemented a clear-rate term: if a player
clears their target more than 55% of recent rounds, push the target up regardless of what
the percentile says. It does not work as written, because the recent scores were played
against *different* targets — comparing them to the current one makes the target oscillate
between 11 and 12 rather than climb. I reverted it rather than ship a mechanism that looks
principled and does nothing. The commit is in the history on purpose.

**The actual fix, which is not built.** A death is the only *uncensored* observation of
ability: the simulation knows exactly how far the run reached before it ended, and we
currently throw that away by recording a score of 0. Recording **reach separately from
score** — score stays 0 for money, reach feeds the ratchet — gives the engine an unbiased
signal without touching the payout rule. That is a schema, simulation and settlement
change rather than a tuning one, so it is D-019 item 1, not a change made under time
pressure to a money path.

**In the meantime it is priced, not ignored.** The curve was tuned knowing this cohort is
mispriced, which is why the shipped RTP is 86.4% rather than 88% (D-012).

---

## D-015 — Threat model: what the defence catches, and what it does not

The brief asks for at least one real server-side defence and an honest account of what it
does and does not catch. The defence is deterministic replay (D-005).

### The trust boundary

Unity is a renderer and an input recorder. It holds **no auth token, no API base URL, and
makes no network call of its own**. Everything that touches a balance goes
Unity → React Native → Cloud Function → Postgres. The surface an attacker reaches by
tampering with the Unity runtime is exactly one thing: the contents of a `ROUND_END`
message. Nothing under `app/src/unity/` has any reason to import the API client, and it
does not.

Identity comes from `request.auth.uid` — the verified token — never from the request body.
A `playerId` field in a payload is just something the client typed. Verified end to end:
an unauthenticated call is refused *even with a valid playerId in the body*.

### Caught

| Attack | Why it fails |
| --- | --- |
| Report a score you did not earn | The server recomputes it from the trace. Tested with a claim of 9999 against a real score of 2. |
| Hand-craft a trace that "wins" | It has to survive the *server's* simulation of the *server's* world. A trace that dies, dies. |
| Re-roll for an easy world | The seed is server-issued and stored before play. |
| Replay a good trace into a new round | The trace is bound to a round whose seed differs; the same inputs produce a different outcome. |
| Inhumanly fast input | The simulation itself refuses inputs closer than 120ms apart, so a superhuman trace is not a valid trace. |
| Submit twice for two payouts | `UNIQUE (idempotency_key)` on `payout:<roundId>`, with `ON CONFLICT DO NOTHING`. Proven under 6-way concurrency. |
| Submit while the sweeper settles | Same key. Proven with a genuine `Promise.all` race: exactly one payout row. |
| Enter twice on one quote | Idempotent on the quote; the second call returns the first round. |
| Retry a deposit | Idempotent on a client-supplied key namespaced by uid. |
| Kill the app on a bad run to get a refund | There are no refunds; it settles at the acknowledged score (D-008). |
| Farm the cold start | Allowance consumed at entry, lifetime, and worth $1.50 net (D-011). |
| Walk your target down by banking early | The demonstrated-ability floor (D-010). Found by writing the test that reproduced it. |
| Change the config after someone enters | The curve is **copied onto the round row**; settlement reads only that copy. Tested by wrecking the live config mid-round. |
| Read or write balances over the REST API | Supabase's Data API is switched **off**, so `players` and `ledger_entries` are not reachable except through Functions. |

### Not caught

Listed because pretending otherwise is worse than the gaps.

1. **An inflated heartbeat on a round that is never submitted.** Bounded, not eliminated.
   A heartbeat is an unverified claim; the physical clamp (D-008) caps it at 8.33 rows/sec
   × 1.5 slack, so a patient attacker can still claim *up to* the maximum physically
   possible score by waiting and then killing the app. They cannot claim more. Closing it
   properly means requiring a partial trace with each heartbeat, which is more bandwidth
   and more server work for an attack that is bounded and detectable.
2. **A perfect bot.** A program that plays legitimately, with human-plausible timing,
   produces a genuinely valid trace. Replay cannot distinguish it from a very good player,
   and it never will — this is the one attack the whole approach is structurally blind to.
   The answer is behavioural: input-timing distributions, device attestation
   (Play Integrity), and flagging accounts whose score distribution has no human variance.
   None of that is built.
3. **Multi-accounting.** Nothing stops one person creating many accounts and farming the
   cold start of each. Bounded at $1.50 net per account, so it is uneconomic rather than
   prevented. Real answers are device fingerprinting and KYC, both out of scope.
4. **No rate limiting.** Nothing stops a client hammering `blitzQuote`. Quote generation
   is cheap and moves no money, so the exposure is cost rather than fairness — but it
   should exist.
5. **Timing side channels.** The server does not check that the wall-clock time a round
   took is consistent with the tick count in the trace. A player could play slowly and
   submit a trace claiming they played fast. It gains them nothing today, but it is the
   kind of gap that becomes exploitable when a time-based feature is added.
6. **Trace size.** A trace is length-validated but not bounded to a sane maximum before
   simulation, so an enormous trace is a cheap way to burn server CPU.

---

## D-016 — A state machine instead of a navigation stack

**Call.** No React Navigation. The four screens are a `useReducer` over a discriminated
union in `app/src/flow/roundFlow.ts`.

**Why, in order of how much it mattered.**

1. **The Unity player must stay mounted.** The embed uses `androidKeepPlayerMounted` so
   that going from the payout screen into a round is instant rather than a multi-second
   reload. A stack navigator unmounts the screen it navigates away from, which tears down
   the GL surface every time — the exact cost the embed was set up to avoid.
2. **The illegal transitions are the interesting part.** You cannot reach a round without
   a funded entry. You cannot settle without a round. A back gesture out of a *paid* round
   is not a thing that can happen, because there is no stack to pop — and allowing it
   would be a refund button wearing a back arrow. These are unreachable by construction
   rather than by remembering not to push the wrong screen. Most of the 11 reducer tests
   assert that something *cannot* happen.
3. **Two fewer native modules** (`react-native-screens`, `react-native-gesture-handler`)
   in a build that already required seven distinct fixes to get through Gradle 9.

**What it costs.** No transition animations, no deep links, and no free hardware back
button. For four screens, one of which is a fullscreen game, that is a good trade. A
fifth screen would not change it; a tab bar would.

**Correction, after running it on a phone.** That last item was not a missing nicety. With
nothing handling `hardwareBackPress`, the back gesture from the payout screen *closed the
app* — which on a screen about to take a player's money is not a trade-off, it is a bug. I
had written the cost down and still not felt it, which is the argument for the device pass
in one line.

It is now handled explicitly, using the reducer's own rules: back leaves a screen, refuses
to leave a **paid** round, and from the lobby is allowed to background the app, because
that genuinely is the top of this app's stack.

**Related: exactly one file can spend money.** `App.tsx` makes every API call; screens are
given data and callbacks and render. `enter` and `submit` are the calls that move money,
and having one file able to issue them makes *"can this charge twice?"* a question you
answer by reading one screen of code rather than auditing four.

---

## D-017 — Firebase JS SDK against a demo project

**Call.** The `firebase` JS SDK, not `@react-native-firebase`. Project ID
`demo-skill-trial`, which the Firebase emulators treat as fully offline.

**Why.** Creating a real Firebase project failed on a Google Cloud **per-account project
quota**. `@react-native-firebase` requires a `google-services.json` that only a real
project can issue, so it was not available. The JS SDK takes a plain config object and an
explicit emulator host, so the app runs from a clean clone with no cloud project, no
service account, and no native rebuild. The brief does not require a deployed backend.

**What it costs, stated plainly.** Auth persistence goes through `AsyncStorage` rather
than the native keychain, and there is no native crash reporting. For a trial that has to
be checked out and run by someone else on a machine I do not control, "it works from a
clean clone" wins.

**One thing worth knowing.** `getReactNativePersistence` exists at runtime but is
invisible to TypeScript, because `@firebase/auth`'s exports map lists a top-level
`"types"` key *before* the `"react-native"` condition, so type resolution stops before it
reaches the RN typings. `app/src/types/firebase-auth-rn.d.ts` augments the module with the
one missing declaration and explains why, rather than `as any` at the call site — which
would have hidden the same gap without explaining it. Without that persistence the app
falls back to *memory*, which in a cash app means the player's balance appears to vanish
on every cold start.

---

## D-018 — What was cut

The brief asks for this explicitly, and asks that the *game* not be what gets cut.

**Cut deliberately.**

- ~~**Pop Shot (Section 3).**~~ **Built after all**, at the reviewer's direction. My
  recommendation was against it: the gate says "after 1 and 2 are done *and polished*",
  and polish is where the remaining gaps are. Recorded rather than quietly rewritten,
  because the argument against it still stands — a second game less finished than the
  first costs points in game feel, judgement and polish at once. What it bought instead
  is real, and is in D-025: the second game exposed an engine defect one game could not.
- **A deployed backend.** Blocked by the Cloud project quota (D-017), and not required.
- **Rate limiting, device attestation, bot detection.** Named in D-015 rather than
  half-built. A token defence that catches nothing is worse than a documented gap.
- **Cross-game skill priors.** Discussed in D-013, not built.
- **Withdrawals as a user-facing flow.** The ledger supports `withdraw`; there is no
  screen. Deposits demonstrate the money path; withdrawal adds a screen and no new
  property.
- **Transition animations and deep links.** Consequence of D-016.

**Not finished, which is different from cut.**

- Sound effects and haptics in Chicken Run. This is the one that most affects *game
  feel*, which is 25% of the score. It is a genuine gap, not a decision.
- Art assets and prefabs — the game renders with primitives and materials.
- Device testing of touch input, frame pacing and the release APK.

---

## D-019 — What I'd build next, in order

1. **Record reach separately from score.** The uncensored skill signal from D-014.
   Schema, simulation, settlement, engine, tests. It is the difference between a target
   engine that adapts and one that has a stable wrong answer.
2. **Audio and haptics in Chicken Run.** Highest ratio of perceived quality to effort in
   the whole project, and it is 25% of the score.
3. **A partial trace with each heartbeat.** Closes threat 1 in D-015 and makes the
   abandoned-round path verifiable rather than merely bounded.
4. **Rate limiting on quote and enter.** Cheap, and its absence is embarrassing rather
   than dangerous.
5. **Real archetype weights.** Replace the estimated population in the harness with
   measured behaviour and re-tune. Everything in D-012 is conditional on that estimate.
6. **Pop Shot**, once 1–4 are done — mostly because a second game is the strongest
   possible test of the claim in D-013 that adding one does not touch the money path.

---

## D-020 — Where I leaned on AI, and where I deliberately did not

The brief asks this directly, so here is the honest version rather than the flattering
one.

**This was built with heavy AI assistance throughout** — Claude, used as a pair, for
essentially the whole build. Pretending otherwise would be both dishonest and easy to
disprove from the commit cadence.

**Where it did the most good.**

- **Toolchain archaeology.** Gradle 9 removed `jcenter()` and `Project.exec()`, changed
  closure scoping inside `android { }`, and the Unity Android export interacts with all
  three. Seven distinct failures, several with error messages that name the wrong cause —
  `[CXX1100]` was actually an `ndkVersion`/`ndkPath` desync caused by a "fix" of mine.
  This is exactly the work where fast hypothesis generation pays.
- **The C# port of the simulation.** A line-for-line port of ~600 lines of integer logic
  between two languages is mechanical, tedious and unforgiving — the ideal shape for it.
- **Boilerplate and prose.** Schema scaffolding, screen layout, this document.

**Where I deliberately did not trust it, and what I did instead.**

- **The money invariants.** Every one of them is proven by an executing test against a
  real Postgres 17, not by reading the code and agreeing with it. Idempotency is proven
  under genuine concurrency (`Promise.all`, six racing submits, a submit racing the
  sweeper), because a code review cannot see a race and an AI reading its own output
  least of all.
- **The exploit hunt.** Three real exploits were found by *writing the test that
  reproduced them*, not by inspection — a target below 1 making break-even round to 0;
  the percentile ratchet being farmable by banking early 75% of the time; and my own first
  fix for that being worse, because it used the window maximum, so one fluke run of 400
  spiked the floor to 180. Each of those looked correct on the page.
- **The determinism claim.** "The C# and JS simulations agree" is not something to assert
  from having written both. It is verified by exporting 500 traces from JS and replaying
  them in Unity, comparing score, end reason, tick count and furthest row — and the one
  refactor that touched it was proved behaviour-neutral by the export coming back
  byte-identical.
- **The economics.** The RTP number was **measured, not chosen**. The harness calls the
  shipping engine rather than a model of it, precisely so that the numbers cannot be
  flattered by a second implementation that agrees with the first because the same author
  wrote both. It immediately contradicted a config that looked entirely reasonable on the
  page — the target *was* break-even and no disciplined player could ever profit — and
  the clear-rate fix that read as principled turned out to oscillate rather than converge,
  and was reverted.

**The pattern.** AI was trusted for things that fail loudly — a build that does not
compile, a port that does not match. It was not trusted for things that fail silently:
concurrency, money, and any number I would have to defend. Those all have an executing
check behind them, and in three cases the check disagreed with the code.

---

## D-021 — What running it on a phone found

Five defects, none of which any test could have caught, all found in the first twenty
minutes on a Realme RMX3085 (Android 13, arm64). Listed because the pattern is the point:
every one of them passed on desktop, passed in tests, and passed against the Android
emulator.

**1. The app could not reach its own backend.** `resolveHost()` read
`NativeModules.SourceCode.scriptURL` — the answer every tutorial gives, and `undefined` on
React Native 0.86, which is bridgeless-only and no longer exposes SourceCode through the
legacy proxy. It did not throw. It returned nothing and fell through to the `10.0.2.2`
fallback — *which is exactly the address an Android emulator uses to reach the host*, so
every simulator run passed. On hardware: `auth/network-request-failed` and a splash screen
that never left. Now uses `getDevServer()`.

**2. Haptics could never have worked.** No `VIBRATE` permission in the manifest. It is a
*normal* permission, granted automatically at install, so there is no runtime prompt to
notice missing — the game simply never vibrates and nothing in the log says why. I had
written, tested and committed an entire haptics layer that was incapable of producing a
single buzz.

**3. Every quote rendered as already expired.** The Firebase callable encoder does not call
`Date.prototype.toJSON`, so `expiresAt` arrived at the client as `{}`. `Date.parse({})` is
`NaN`, and `secondsUntil`'s fail-closed default returned 0 — so a 180-second offer showed
"Get a new offer" the instant the screen opened.

The interesting part is that **my own defensive default hid it**. Failing closed was the
right call and I would make it again, but a safe default that stays silent lets a defect
look like a feature. That branch now warns in development, and the server sends an ISO
string so the wire format is stated rather than left to an encoder's handling of a native
type.

**4. The bootstrap stake cap did nothing.** `listGames` read
`params->'bootstrap_max_stake_cents'` at the top level; it lives under `cold_start`. It came
through as null, the cap check was skipped, and the lobby cheerfully offered $3, $5 and $10
entries that the server would have refused at quote time. The server was never wrong — the
screen was.

**5. Unity never finished loading the world.**

    Can't add component because class 'BoxCollider' doesn't exist!
    UnityEngine.GameObject:CreatePrimitive(PrimitiveType)

`CreatePrimitive` attaches a collider, and because nothing in this game uses physics — the
simulation *is* the physics — managed stripping removes the Physics module from the player
build. The editor has it, so this is invisible until a player build runs. The world never
finished building, Unity never sent `READY`, and the app sat on "Loading the course" with
the stake already debited.

The previous code destroyed the collider immediately after creating the primitive, which is
the right intent in the wrong order: the failure happens *inside* `CreatePrimitive`. Fixed
by building the cube mesh in code, which is better than restoring the Physics module — it
takes an entire engine module out of the APK for a game that will never raycast anything,
and a future stripping-level change cannot re-break it.

**The pattern.** Four of the five are cases where something returned a plausible value
instead of failing: a missing native module returning `undefined`, a permission that is
absent without a prompt, a `Date` encoding to `{}`, a JSON path that resolves to null. None
of them threw. The one that did throw, threw only in a player build. That is the category
of bug a device pass exists to find, and it is why "it compiles and the tests pass" is not
the same claim as "it works".

---

## D-022 — Pop Shot: portrait, and one ball that never leaves

*The brief: "portrait or landscape, your call, say why."*

**Call.** Portrait.

**Why.** Three reasons, and the third is the one that actually decided it.

The hoop is above and the ball is below, so the interesting axis is vertical —
which is the axis a portrait screen has more of. Landscape would spend its extra
width on court the player never uses.

It also matches Chicken Run and the React Native chrome, so nothing about the app
ever rotates.

And that is the real argument. Switching orientation resizes the Unity surface,
and this build has already demonstrated, on a real device, that surface changes
are the one thing it cannot survive — re-attaching the view produced *"Graphics
device is null"* and a SIGTRAP (D-021). A design that requires a rotation
mid-session is a design betting on the exact behaviour that has already broken
once.

**One ball, permanently in play.** The brief says an out-of-bounds ball "rolls back
in from the opposite side". A ball that re-enters is a ball that is never lost, so
Pop Shot is not a sequence of discrete shots — it is one ball that wraps at the
court edges and that the player keeps aloft and steers through the hoop again and
again. Every other decision follows from reading that requirement literally.

The renderer draws the ball twice near an edge, one leaving and one already
arriving, so the wrap reads as continuous motion rather than a teleport.

---

## D-023 — The shot control curve, and what I tried

*The brief asks explicitly what was tried here.*

**Call.** A tap SETS the ball's vertical velocity to a fixed value. It does not add
to it, and there is no charge, no aim and no power meter.

**What I tried and rejected.**

**Additive impulses** — each tap adds upward velocity. This is the obvious physical
model and it is unlearnable: the same gesture produces a different result depending
on how fast the ball was already moving, which is hidden state. It is a power meter
with no display. A player cannot tell whether a bad outcome was a bad decision or a
bad starting condition, so they cannot improve.

**Hold to charge, release to shoot** — the classic arcade shot. Rejected because it
contradicts the out-of-bounds rule: charging implies a discrete shot, and a discrete
shot implies a ball that is spent afterwards. It would also put a variable delay
between deciding and acting, in a game where timing is the only skill.

**Drag to aim** — rejected on the same grounds and one more: the brief says "tap
anywhere on the screen", and anywhere is not a target.

**Why setting works.** One tap always produces exactly the same arc from wherever the
ball happens to be. So the only variable the player controls is *when*, which is a
thing they can see themselves getting better at. There is a test asserting this
property directly, because it is the design and not an implementation detail.

**What it costs.** A skill ceiling lower than a charge mechanic's. There is no
"perfect shot" to master, only good timing. For a mode that has to be readable in one
round, on a phone, with money on it, that is the right trade — but a long-lived game
would want a second dimension eventually.

**Related: input commits on PRESS, not release.** Chicken Run has to tell a tap from a
swipe, so it must wait for the finger to lift. Pop Shot has one action, so it does
not, and firing on the press removes a variable delay from the one thing the game is
about.

---

## D-024 — The buzzer-beater, defined precisely

*The brief points out that its own description of this is circular, and asks for a
precise definition.*

**The circularity.** A buzzer-beater is a shot made as the clock expires. But a made
basket adds time to the clock. So a successful buzzer-beater is a shot made when the
clock has expired, after which the clock has not expired — and "when does the round
end?" has no answer.

**The resolution: the clock does not end the round. The ball does.**

> The clock reaching zero opens a **resolution window**. The round ends at the first
> tick where the clock is at zero **and the ball is at or below rim height**. A basket
> scored during that window is a buzzer-beater: it scores, it adds its time, and play
> continues.

"Expired" therefore means "expired *and* the ball has come down", which is a condition
that can only become true once, and the circularity disappears. It also matches what
the phrase means in the sport: the shot counts if it left your hands before the horn,
and everyone waits to see whether it drops.

**The cap, and why it is needed.** The control scheme makes it trivial to keep the ball
above rim height forever — that is exactly what tapping does. Without a bound, "never
let it fall" would be an unbeatable strategy for an endless round. So the window is
capped at **three seconds** regardless of where the ball is. Both halves are tested:
that the round does not end while the ball is up, and that it ends anyway after three
seconds.

**Slow-motion was free.** The brief asks for it, and it cost one line, because the
simulation is indexed by **tick** rather than by time. The client may feed ticks at any
rate; the server replays the same ticks and reaches the same answer, and has no idea
how fast they were played.

It also cannot be abused. Playing slowly makes a round take longer in wall-clock terms,
and the server's heartbeat clamp bounds score by *elapsed time* — so stretching time can
only ever make a claim more plausible, never less.

---

## D-025 — What the second game taught the target engine

Adding Pop Shot was meant to prove an architectural claim: that a new game costs one line
in the validator registry and one entry in the Unity host, and never touches the money
path. It did prove that. It also found a defect in the target engine that a single game
could not have exposed.

**Pop Shot's score distribution is right-skewed and Chicken Run's is not.** Scoring buys
clock, which buys more scoring, so a hot streak produces an outlier far above a player's
typical round. Chicken Run has no such feedback: a good run is longer, not
self-reinforcing.

Measured with Chicken Run's settings, the p90 personal-best floor chased that outlier:

| cohort | mean score | mean target | RTP |
| --- | --- | --- | --- |
| novice | 7.7 | 11.3 | **106%** |
| expert | 16.1 | 30.6 | **75%** |

Backwards for a skill game — beginners profited and good players were priced out. And it
is the **mirror image** of D-014, where the same engine *under*-targeted disciplined
Chicken Run players. One engine, two games, two opposite failures, and neither visible
without the other game.

**The fix is a config value, not code:** `floor_percentile` from 0.9 to 0.6, so the floor
tracks typical rather than peak play. The band closes from 75–106% to **84–91%**, tighter
than Chicken Run's own. That is the per-game config from D-013 earning its keep — one
engine, tuned differently, because the two games produce differently shaped data.

**Pop Shot ships at 90.1% RTP** rather than Chicken Run's 86.4%, on purpose: it has no
cash-out, so there is no moment where a player chooses to risk everything and no round
that pays nothing for a mistake at the end. In a game you cannot bank, a thinner return
reads as the game simply taking from you.

**Measured honestly.** The first numbers I got were noise — 40 synthetic players per
archetype gave 6-point swings between runs. Five seeds at 150 players give a standard
deviation of 0.9pp, and only those numbers were used. The small-sample runs happened and
were discarded.

**The harness plays this game rather than modelling it.** Chicken Run's synthetic players
are a model, because the thing being modelled is where a human chooses to stop and that
has no algorithm. Pop Shot has no such choice, so its players run the real simulation —
which means its tuning numbers cannot drift away from the game when the game changes.

---

## D-026 — The art pass, and the four bugs only a phone could show me

*Design prompt, from the reviewer: "before that make the games better they look
like placeholders."*

**The call.** Spend a pass on how the games look, before recording, rather than
after. Polish is 10% of the rubric and the smallest line item — but a reviewer
watches the recording before reading a line of code, and a board of untextured
cubes says "unfinished" louder than anything a README can say back.

**What it cost.** Nothing structural: no new dependency, no asset pipeline, no
imported model. Every prop is still cubes and spheres from `PrimitiveMesh`,
assembled in `Props.cs`, tinted with property blocks. The material moved from
URP Unlit to URP Lit, which is the one change with a runtime cost, and it is
what makes a cube read as a solid rather than as a flat coloured shape — unlit,
every face of a cube renders identically and the whole world looks like paper.

**What made it worth more than the 10%.** The art pass was, unintentionally, a
test pass. Making the world legible meant looking at it closely on a real
device for the first time, and that found four defects that had been shipping
invisibly:

- **The idle warning had been invisible for the entire project.** It is the only
  signal that the round is about to end for standing still — the mechanic I
  chose and defended in D-004 — and an earlier fix had flattened it from a slab
  to a sheet at y=0.015, which put it *under* a board whose surface is y=0.5.
  A gameplay-critical affordance, absent, and nothing failed.
- **The chicken had no colour.** `Props` tints with `MaterialPropertyBlock`s,
  which do not survive being saved into a scene, and the chicken was the one
  object assembled at edit time. Comb, beak, wattle, legs and eyes all drew the
  shared material's white. It did not look broken — it looked like a white bird.
- **The chicken was about twice its intended size** and standing below the
  ground, because both numbers had been set against Unity's capsule primitive
  and never re-measured after the capsule was replaced.
- **Wrapping traffic hung off the edge of the world.** The board is exactly as
  wide as the simulation, so the second copy of a body straddling the wrap point
  was drawn over open sky.

None of these were reachable from a unit test. They are not logic — they are the
gap between what the simulation says and what a person sees, and the only
instrument for that is a screenshot from the device.

**Where I leaned on AI and where I did not.** The assembly code for the props —
a car from a chassis, cabin, glass and four wheels; a chicken from a sphere and
ten cubes — is mechanical, and I let the model write it and then read it. Every
one of the four defects above was found by looking at a captured frame, cropping
it, and comparing what was drawn against what the code says should be drawn. The
model was useful for *why is this white* once the question was posed; it had
nothing to say about the fact that it was white, because it cannot see.

**What I did not do.** No textures, no shadows, no particle effects, no imported
art. The world is still made of the same two meshes it was made of before, and a
reviewer can still read every shape in the frame back to a line in `Props.cs`.

---

## D-027 — Making the game easier moved the tuning numbers by exactly zero

The traffic rework (clearance invariant, speeds cut from 2–5.5 cells/s to
1.2–2.8) makes Chicken Run substantially easier. I re-ran the harness expecting
to have to retune, and got the shipped report back **line for line** — same mean
reach per archetype, same RTP, same 86.4% headline.

That is not a bug in the harness. It is D-025's tradeoff arriving in person.

**Chicken Run's synthetic players model reach; they do not play the game.** Where
a human chooses to stop is the thing being modelled, and that has no algorithm —
so the population draws a reach from a skill distribution and a cash-out policy
from an archetype, and never touches `simulate()`. Pop Shot's players, which
have no such choice to model, run the real simulation. So a difficulty change is
visible to the Pop Shot harness and invisible to the Chicken Run one, **by
construction**.

**Why I did not "fix" it.** Two reasons, and the second is the one that decides
it.

Making the Chicken Run population play the real sim would mean writing a bot
that decides *when to cash out* — which is the human judgement the whole mode is
built on, and a bot's answer to it would be a fiction I invented, dressed up as
a measurement. The current model is honest about being a model.

More importantly, **the economics do not depend on absolute difficulty.** The
target is a percentile of each player's own history, and the curve is relative
to that target. Make the game twice as easy and every player's reach doubles,
their target doubles behind it, and the RTP is unchanged. That property is the
reason the engine was built per-player in the first place (D-013), and this is
the first evidence I have that it actually holds — an easier game did not become
a more generous one.

**What it does mean.** Two things a reviewer should hold me to:

- The Chicken Run harness measures the *engine*, not the *game*. It cannot catch
  a difficulty regression, and I should not claim it can.
- A difficulty change still needs a human to play it. Every defect in this pass —
  the moving wall of traffic, the stale world, the trees over the roads — was
  found by playing on a phone and looking, and the harness would have reported
  86.4% throughout.
