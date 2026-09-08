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
| 0.6 | Write down what was cut and why | TODO |

## 1. Stack (mandatory)

| # | Requirement | Status |
|---|---|---|
| 1.1 | React Native — app UI | DONE |
| 1.2 | Unity — games | DONE |
| 1.3 | `azesmway/react-native-unity` to embed | DONE — 1.1.1, builds to APK |
| 1.4 | Supabase (PostgreSQL) | DONE — ap-south-1, PG 17.6, schema applied, all 24 integration tests pass against the transaction-mode pooler |
| 1.5 | Firebase Auth | TODO — emulator configured (port 9099), no sign-in flow yet |
| 1.6 | Firebase Functions — the API | DONE — runs on the emulator; Google Cloud project quota blocks a real project, and the brief does not require deployment |

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
| 2.1 | Match reference screenshots for layout, dimension, orientation | TODO |
| 2.2 | Tap to jump forward | DONE — verified in a running build |
| 2.3 | Swipe to jump left / right / back | DONE — untested on touch hardware |
| 2.4 | Hold **"Cash Out"** to quit and keep points | DONE — 700ms hold with ring |
| 2.5 | Score 0 if you die | DONE — in sim, tested |
| 2.6 | Don't fall in the water | DONE — in sim |
| 2.7 | Watch out for moving **cars** | DONE — in sim |
| 2.8 | Watch out for **trains** | DONE — in sim |
| 2.9 | Idle too long → game ends. **Decide threshold, state it, say why** | PARTIAL — 6.9s verified in a build; not yet in DECISIONS.md |
| 2.10 | No time limit; ends on cash out, death, or idle | DONE |
| 2.11 | Assets / prefabs | TODO |
| 2.12 | Sound effects | TODO |
| 2.13 | Haptics | TODO |
| 2.14 | **Playable** — smooth, responsive, fun | PARTIAL — renders and plays; no device test, no audio/haptics |

## 3. Blitz — REQUIRED

### 3A. The round loop

| # | Requirement | Status |
|---|---|---|
| 3A.1 | Pre-entry payout screen, per player per round | PARTIAL — quote endpoint done; no RN screen yet |
| 3A.2 | Entry fee taken, curve locked | DONE — enter debits and copies the curve onto the round |
| 3A.3 | Round played, score produced | PARTIAL — sim only |
| 3A.4 | Score validated | DONE — deterministic replay |
| 3A.5 | Payout resolved against the **locked** curve | PARTIAL — curve.js done; no endpoint |
| 3A.6 | Balance updated | PARTIAL — ledger done; settlement endpoint pending |
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
| 3D.1 | Simulate synthetic players of varying skill over N rounds | **TODO** |
| 3D.2 | Report **return-to-player** | **TODO** |
| 3D.3 | Report **win rate** | **TODO** |
| 3D.4 | Report **rounds until balance exhausted** | **TODO** |
| 3D.5 | Use it to pick the shipping config, show the working | **TODO** |
| 3D.6 | Pick an RTP number and **defend** it, incl. numbers either side | **TODO** |

### 3.4 Constraints

| # | Requirement | Status |
|---|---|---|
| 3.4.1 | Nothing touching money decided on the client | DONE by design |
| 3.4.2 | Every balance change through a ledger | DONE — ledger module, 10 integration tests |
| 3.4.3 | Interrupted round → exactly one outcome, once | PARTIAL — schema + sweeper designed |
| 3.4.4 | Handle disconnects, duplicate submits, app kills | PARTIAL — designed |
| 3.4.5 | Curve shown pre-entry is the curve paid on | DONE — copied into the round row |
| 3.4.6 | **UI is a requirement.** Real copy, real layout | **TODO** |
| 3.4.7 | States: loading, error, insufficient balance, win, loss | **TODO** |
| 3.4.8 | Transitions and feel | **TODO** |
| 3.4.9 | Blitz enableable per game, not hard-wired | DONE — `games.blitz_enabled` |

### 3.5 Decisions to state in DECISIONS.md

| # | Requirement | Decided? | Written? |
|---|---|---|---|
| 3.5.1 | How long a locked curve stays valid | yes — 180s | **no** |
| 3.5.2 | Outcome of an interrupted round | yes — settle at heartbeat | **no** |
| 3.5.3 | Entry fee tiers, and how they relate to the curve | yes — $1/3/5/10/20 | **no** |

### 3.6 Design questions — answer in writing

| # | Question | Addressed in code? | Written? |
|---|---|---|---|
| 3.6.1 | The ceiling problem (+ harness must back the claim) | yes — PB bracket | **no** |
| 3.6.2 | Cold start; what stops first-N-rounds being farmable | yes — lifetime bootstrap | **no** |
| 3.6.3 | Multiple games: per-game vs shared targets | yes — per-game | **no** |
| 3.6.4 | The line between hard and unwinnable | partly | **no** |

## 4. Pop Shot — BONUS, optional

Only after Chicken Run **and** Blitz are finished and polished.

| # | Requirement | Status |
|---|---|---|
| 4.1 | 2D basketball | TODO |
| 4.2 | Portrait or landscape — your call, say why | TODO |
| 4.3 | Clock does not start until the first basket | TODO |
| 4.4 | Tap anywhere to lift the ball and shoot | TODO |
| 4.5 | Each basket adds time to the shot clock | TODO |
| 4.6 | Swish (no rim, no backboard) = extra points | TODO |
| 4.7 | Out of bounds → rolls back in from the opposite side | TODO |
| 4.8 | Buzzer-beater: slow-mo, animation, extra seconds | TODO |
| 4.9 | DECISIONS: the shot control curve — what you tried | TODO |
| 4.10 | DECISIONS: define the buzzer-beater trigger precisely (it is circular as written) | TODO |

## 5. Backend requirements

| # | Requirement | Status |
|---|---|---|
| 5.1 | No matchmaking, no rating | N/A |
| 5.2 | An entry must never silently disappear with the money | PARTIAL — designed |
| 5.3 | Raw **parameterised** SQL via `pg` | DONE — every query parameterised, no concatenation |
| 5.4 | Use `query` / `transaction` from `db.js` | DONE — unmodified |
| 5.5 | **No ORM, no query builder, no Supabase client lib** | DONE — none installed |
| 5.6 | Never build a query by string concatenation | DONE so far |
| 5.7 | Money as **integer cents**, no floats | DONE — enforced in schema + curve |
| 5.8 | Server is the only thing that moves a balance | DONE by design |
| 5.9 | Debit the stake at **entry**, not settlement | DONE — enter.js, tested |
| 5.10 | Submission + settlement **idempotent** | PARTIAL — entry proven idempotent under concurrency; submit pending |
| 5.11 | Settlement **atomic** | PARTIAL — rollback proven; settle pending |
| 5.12 | Append-only ledger of every movement | DONE — schema |
| 5.13 | Threat model, written, concrete | PARTIAL — in code comments, not DECISIONS |
| 5.14 | Implement ≥1 real server-side defence + what it does/doesn't catch | DONE — replay; holes listed in kickoff, not DECISIONS |
| 5.15 | What you'd build next, roughly in order | PARTIAL — in kickoff, not DECISIONS |
| 5.16 | Mock payment functions only | DONE — ledger.deposit / withdraw |

## 6. Deliverables

| # | Requirement | Status |
|---|---|---|
| 6.1 | **Public GitHub repo**, link sent | DONE — https://github.com/mj789-98/skill-trial-blitz |
| 6.2 | Commit incrementally (they read the history) | DONE — pushed as work proceeds, not in one lump |
| 6.3 | README: run from clean checkout | TODO |
| 6.4 | README: versions used | DONE |
| 6.5 | README: platform targeted | DONE |
| 6.6 | README: **a test account we can log in with** | TODO |
| 6.7 | DECISIONS: judgement calls where the brief was vague | PARTIAL — 3 of ~15 |
| 6.8 | DECISIONS: scope cut and why | TODO |
| 6.9 | DECISIONS: answers to every design prompt | TODO |
| 6.10 | DECISIONS: score-trust threat model | TODO |
| 6.11 | DECISIONS: **where you leaned on AI, and where you deliberately did not** | TODO |
| 6.12 | **Screen recording on a real device**, showing each feature | TODO |
| 6.13 | Runnable build — an **APK** | PARTIAL — debug APK of the spike only |
| 6.14 | Tuning harness + shipped config + the numbers behind it, committed | **TODO** |

## 7. Scoring weights

| Weight | Dimension | Where we stand |
|---|---|---|
| 30% | Correctness & server authority | strong foundation, endpoints missing |
| 25% | **Game feel** | **nothing playable yet** |
| 20% | Code quality & architecture | strong |
| 15% | Product judgement & written reasoning | **weak — almost nothing written** |
| 10% | Polish & completeness | not started |

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
