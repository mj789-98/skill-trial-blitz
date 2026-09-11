# Requirements inventory

Every requirement extracted from the assignment, with honest status. This is the
source of truth we work against — `PROJECT_KICKOFF.md` is a derived plan and
where the two disagree, **this document wins**.

Status key: **DONE** · **PARTIAL** · **TODO** · **N/A** (explicitly out of scope)

---

## 0. Framing

| # | Requirement | Status |
|---|---|---|
| 0.1 | Build a **solo** mode. Not async 1v1 matchmaking. | DONE (nothing built toward matchmaking) |
| 0.2 | Not realtime netcode | N/A — explicitly out of scope |
| 0.3 | Wager range $1–$20 per entry | DONE — tiers inside range |
| 0.4 | **The game comes first.** Cut depth of other features, not the game | DONE — Chicken Run is playable end to end before the backend was wired |
| 0.5 | Correctness beats apparent completeness | DONE — thin but tested |
| 0.6 | Write down what was cut and why | DONE — DECISIONS D-018 |

## 1. Stack (mandatory)

| # | Requirement | Status |
|---|---|---|
| 1.1 | React Native — app UI | DONE |
| 1.2 | Unity — games | DONE |
| 1.3 | `azesmway/react-native-unity` to embed | DONE — 1.1.1, builds to APK |
| 1.4 | Supabase (PostgreSQL) | DONE — ap-south-1, PG 17.6, schema applied, and carrying the shipping configs: `chicken_run:tuned-v1` and `pop_shot:popshot-v1` both active, Blitz on for both games. It had drifted — it was seeded before the tuning harness existed and still held `baseline-v0` — which is why `tools/db/applySeed.js` exists. There are now 42 DB-backed tests (of 124 total). 24 of them ran against the transaction-mode pooler; the 18 added since are verified against local PG 17 only, because they mutate the shared `games` and `blitz_configs` rows and a mid-run failure would leave the hosted database inconsistent. What the pooler run establishes is host compatibility — transaction mode, `SET LOCAL` guards, no cross-statement session state — and that has not changed since. |
| 1.5 | Firebase Auth | DONE — email/password against the Auth emulator; uid comes from the verified token, proven by the e2e script |
| 1.6 | Firebase Functions — the API | DONE — deployed to `mobileroomgame` in asia-south1, nine functions, and verified live end to end: sign-in, deposit through the ledger, quote, enter, a submit claiming 9999 paid on the replayed 0, and the balance moving by exactly the stake. Emulator for development. Runs on nodejs20, which the brief pins; Google stops accepting nodejs20 deploys on 2026-10-30, after which redeploying needs a newer runtime (D-031) |

### Pinned versions

| Component | Required | Actual | Status |
|---|---|---|---|
| Unity Editor | `6000.1.13f1` | `6000.1.13f1` (`418bd0acaa6b`) | DONE |
| React Native | `0.86.0` | `0.86.0` | DONE |
| React | `19.2.3` | `19.2.3` | DONE |
| TypeScript (app) | `^5.8.3` | `^5.8.3` | DONE |
| Node — RN tooling | `>= 22.11.0` | `22.15.1` | DONE |
| Node — Functions runtime | `20` | declared; emulator warns it uses host node 22 | PARTIAL |
| `firebase-functions` | `^5.0.0` | 5.1.1 installed | DONE |
| `firebase-admin` | `^12.0.0` | 12.7.0 installed | DONE |
| `pg` | `^8.20.0` | 8.23.0 installed | DONE |
| Unity embed pkg | *(unpinned; record it)* | `1.1.1`, recorded in README | DONE |

| # | Requirement | Status |
|---|---|---|
| 1.7 | RN app is **TypeScript** | DONE |
| 1.8 | Functions are **JavaScript, not TypeScript** | DONE |
| 1.9 | Pick ONE platform, state which | DONE — Android, stated in README |
| 1.10 | `db.js` saved beside functions, used as given | DONE — unmodified |

## 2. Chicken Run — REQUIRED

| # | Requirement | Status |
|---|---|---|
| 2.1 | Match reference screenshots for layout, dimension, orientation | DONE — both games checked frame by frame against the reference recordings; camera framing, prop proportions, traffic pacing and the Pop Shot camera pitch all corrected against it. See D-028 |
| 2.2 | Tap to jump forward | DONE — verified in a running build |
| 2.3 | Swipe to jump left / right / back | DONE — untested on touch hardware |
| 2.4 | Hold **"Cash Out"** to quit and keep points | DONE — 700ms hold with ring |
| 2.5 | Score 0 if you die | DONE — in sim, tested |
| 2.6 | Don't fall in the water | DONE — in sim |
| 2.7 | Watch out for moving **cars** | DONE — in sim |
| 2.8 | Watch out for **trains** | DONE — in sim |
| 2.9 | Idle too long → game ends. **Decide threshold, state it, say why** | DONE — 6.9s, DECISIONS D-004 |
| 2.10 | No time limit; ends on cash out, death, or idle | DONE |
| 2.11 | Assets / prefabs | N/A by choice — every prop is generated in code from two meshes (Props.cs, PopShotView.cs). No imported art, no asset pipeline. Stated rather than hidden: see D-026 and D-028 |
| 2.12 | Sound effects | DONE — 8 clips, synthesised in code; measured by an editor check that fails the build on silence or clipping |
| 2.13 | Haptics | DONE — Android VibrationEffect via JNI, per-event duration and amplitude; untested on hardware |
| 2.14 | **Playable** — smooth, responsive, fun | DONE — played on a real device across many rounds; sound, haptics, lit shading, real props. The device passes found bugs no test could (D-026) |

## 3. Blitz — REQUIRED

### 3A. The round loop

| # | Requirement | Status |
|---|---|---|
| 3A.1 | Pre-entry payout screen, per player per round | DONE — endpoint + RN screen with the curve, a visible countdown and self re-quote |
| 3A.2 | Entry fee taken, curve locked | DONE — enter debits and copies the curve onto the round |
| 3A.3 | Round played, score produced | DONE — played in Unity, submitted through the app |
| 3A.4 | Score validated | DONE — deterministic replay |
| 3A.5 | Payout resolved against the **locked** curve | DONE — submit reads only `blitz_rounds.curve`; tested by wrecking the live config mid-round |
| 3A.6 | Balance updated | DONE — through the ledger, idempotent under concurrency |
| 3A.7 | Profile updated for next round | DONE — `advanceProfile` |

### 3B. Target engine

| # | Requirement | Status |
|---|---|---|
| 3B.1 | Turns history into a payout curve | DONE |
| 3B.2 | Config in **data**, not code | DONE — `blitz_configs.params` JSONB |
| 3B.3 | Retunable without a rebuild | DONE |
| 3B.4 | Document what each parameter does | DONE — `describeParams()` |

### 3C. Server authority

| # | Requirement | Status |
|---|---|---|
| 3C.1 | Stop a player reporting a score they did not earn | DONE — server replays the trace |
| 3C.2 | Draw the trust boundary in the right place | DONE — Unity has no token, no URL, no network |

### 3D. Tuning harness

| # | Requirement | Status |
|---|---|---|
| 3D.1 | Simulate synthetic players of varying skill over N rounds | DONE — 7 archetypes, each a hand AND a temperament, seeded |
| 3D.2 | Report **return-to-player** | DONE — weighted by the population mix, not pooled |
| 3D.3 | Report **win rate** | DONE — and "any payout", which is a different question |
| 3D.4 | Report **rounds until balance exhausted** | DONE — bust rate, median and p10 rounds survived |
| 3D.5 | Use it to pick the shipping config, show the working | DONE — it found two real defects; shipped as tuned-v1 |
| 3D.6 | Pick an RTP number and **defend** it, incl. numbers either side | DONE — 86.4%, defended in D-012 |

### 3.4 Constraints

| # | Requirement | Status |
|---|---|---|
| 3.4.1 | Nothing touching money decided on the client | DONE by design |
| 3.4.2 | Every balance change through a ledger | DONE — ledger module, 10 integration tests |
| 3.4.3 | Interrupted round → exactly one outcome, once | DONE — sweeper; a submit racing it produces exactly one payout |
| 3.4.4 | Handle disconnects, duplicate submits, app kills | DONE — all three tested |
| 3.4.5 | Curve shown pre-entry is the curve paid on | DONE — copied into the round row |
| 3.4.6 | **UI is a requirement.** Real copy, real layout | DONE — four screens, real copy; not yet seen on a device |
| 3.4.7 | States: loading, error, insufficient balance, win, loss | DONE — domain error codes mapped to player-readable text |
| 3.4.8 | Transitions and feel | PARTIAL - Unity stays mounted so entering a round is instant; no screen transition animations, see D-016 |
| 3.4.9 | Blitz enableable per game, not hard-wired | DONE — `games.blitz_enabled` |

### 3.5 Decisions to state in DECISIONS.md

| # | Requirement | Decided? | Written? |
|---|---|---|---|
| 3.5.1 | How long a locked curve stays valid | yes — 180s | D-007 |
| 3.5.2 | Outcome of an interrupted round | yes — settle at heartbeat | D-008 |
| 3.5.3 | Entry fee tiers, and how they relate to the curve | yes — $1/3/5/10/20 | D-009 |

### 3.6 Design questions — answer in writing

| # | Question | Addressed in code? | Written? |
|---|---|---|---|
| 3.6.1 | The ceiling problem (+ harness must back the claim) | yes — PB bracket | D-010, and the harness backs it |
| 3.6.2 | Cold start; what stops first-N-rounds being farmable | yes — lifetime bootstrap | D-011 |
| 3.6.3 | Multiple games: per-game vs shared targets | yes — per-game | D-013 |
| 3.6.4 | The line between hard and unwinnable | yes, including the failure the harness found | D-014 |

## 4. Pop Shot — BONUS, optional

Gated on Chicken Run **and** Blitz being finished and polished. Built at the
reviewer's direction; the recommendation against it, and what it bought instead,
are in DECISIONS D-018 and D-025.

| # | Requirement | Status |
|---|---|---|
| 4.1 | 2D basketball | DONE — verified on device: a paid round played, settled and reconciled |
| 4.2 | Portrait or landscape — your call, say why | DONE — portrait, DECISIONS D-022 |
| 4.3 | Clock does not start until the first basket | DONE — clockRunning stays false until the first basket; tested |
| 4.4 | Tap anywhere to lift the ball and shoot | DONE — tap anywhere, committed on press |
| 4.5 | Each basket adds time to the shot clock | DONE — +1s per basket, +0.5s extra for a swish, capped at 30s. Was +3s/+1s, which paid more clock than a basket cost to score, so a competent player never ran out and the round had no ending. See D-030 |
| 4.6 | Swish (no rim, no backboard) = extra points | DONE — swish is 3 points vs 2, tracked per flight since the last floor contact |
| 4.7 | Out of bounds → rolls back in from the opposite side | DONE — toroidal wrap; the renderer draws the ball twice so it reads as continuous |
| 4.8 | Buzzer-beater: slow-mo, animation, extra seconds | DONE — buzzer window, slow-motion, tested both halves |
| 4.9 | DECISIONS: the shot control curve — what you tried | DONE — DECISIONS D-023, with the three rejected alternatives |
| 4.10 | DECISIONS: define the buzzer-beater trigger precisely (it is circular as written) | DONE — DECISIONS D-024 |

## 5. Backend requirements

| # | Requirement | Status |
|---|---|---|
| 5.1 | No matchmaking, no rating | N/A |
| 5.2 | An entry must never silently disappear with the money | DONE — sweeper, tested |
| 5.3 | Raw **parameterised** SQL via `pg` | DONE — every query parameterised, no concatenation |
| 5.4 | Use `query` / `transaction` from `db.js` | DONE — unmodified |
| 5.5 | **No ORM, no query builder, no Supabase client lib** | DONE — none installed |
| 5.6 | Never build a query by string concatenation | DONE so far |
| 5.7 | Money as **integer cents**, no floats | DONE — enforced in schema + curve |
| 5.8 | Server is the only thing that moves a balance | DONE by design |
| 5.9 | Debit the stake at **entry**, not settlement | DONE — enter.js, tested |
| 5.10 | Submission + settlement **idempotent** | DONE — entry, submit and sweep, all under real concurrency |
| 5.11 | Settlement **atomic** | DONE |
| 5.12 | Append-only ledger of every movement | DONE — schema |
| 5.13 | Threat model, written, concrete | DONE — DECISIONS D-015, including six things it does NOT catch |
| 5.14 | Implement ≥1 real server-side defence + what it does/doesn't catch | DONE — deterministic replay; the gaps are named in D-015 |
| 5.15 | What you'd build next, roughly in order | DONE — DECISIONS D-019 |
| 5.16 | Mock payment functions only | DONE — ledger.deposit / withdraw |

## 6. Deliverables

| # | Requirement | Status |
|---|---|---|
| 6.1 | **Public GitHub repo**, link sent | DONE — https://github.com/mj789-98/skill-trial-blitz |
| 6.2 | Commit incrementally (they read the history) | DONE — pushed as work proceeds, not in one lump |
| 6.3 | README: run from clean checkout | DONE |
| 6.4 | README: versions used | DONE |
| 6.5 | README: platform targeted | DONE |
| 6.6 | README: **a test account we can log in with** | DONE — seeded, and signed in automatically on first launch |
| 6.7 | DECISIONS: judgement calls where the brief was vague | DONE — 28 entries |
| 6.8 | DECISIONS: scope cut and why | DONE — D-018 |
| 6.9 | DECISIONS: answers to every design prompt | DONE — D-004, D-007..D-011, D-013, D-014 |
| 6.10 | DECISIONS: score-trust threat model | DONE — D-015 |
| 6.11 | DECISIONS: **where you leaned on AI, and where you deliberately did not** | DONE — D-020 |
| 6.12 | **Screen recording on a real device**, showing each feature | TODO |
| 6.13 | Runnable build — an **APK** | PARTIAL — the release APK talks to the deployed backend and is verified on a real phone with no cable and no emulators: signs in, loads the lobby from the live server in about three seconds. What is still missing is somewhere to download it from — it is 169 MB and gitignored, so it needs a GitHub Release asset |
| 6.14 | Tuning harness + shipped config + the numbers behind it, committed | DONE — tools/sim, tuned-v1, docs/tuning-report.md |

## 7. Scoring weights

| Weight | Dimension | Where we stand |
|---|---|---|
| 30% | Correctness & server authority | strong — full loop, 122 backend tests + 21 e2e checks + 1000 C#/JS parity cases, threat model written |
| 25% | **Game feel** | strong — two games, audio + haptics, lit shading and code-generated props, both proportioned against the reference footage and verified on a device |
| 20% | Code quality & architecture | strong |
| 15% | Product judgement & written reasoning | strong — 28 DECISIONS entries, with harness numbers behind the claims |
| 10% | Polish & completeness | partial — art pass done and verified on device; the screen recording (6.12) and a downloadable APK (6.13) are the two things still open |

## 8. Explicitly out of scope

Real payments / cards / KYC · CI/CD, IaC, store submission · realtime netcode ·
localisation, accessibility audits, analytics · supporting both platforms.

## 9. Open questions for the group chat

Drafted in `docs/telegram-questions.md`, **not yet sent**:

1. Sub-break-even band — partial multiplier or hard zero?
2. ~~Personal assignment document~~ — **RESOLVED.** The document is titled
   "Unity Work Trial - Manas", so it IS the personal assignment document. The
   "feature thoughts" prompts are §2.5 (three decisions), §2.6 (four design
   questions) and §3 (two Pop Shot questions). No longer a blocker.
3. Cash only, or gems too?
4. Practice mode alongside Blitz?
5. Prize Wheel — in scope?
6. Mock deposit flow required, or is a seeded balance enough?
7. Result screen — leaderboard or just own history?
