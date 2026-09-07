# Draft — questions for the work trial group chat

Paste-ready. Ordered so the two that actually change what gets built come first.

---

Hi — starting on the trial today, targeting **Android** (no Mac here; the brief says that's
fine). A few clarifying questions, with the assumption I'm proceeding on in each case so
nothing is blocked while I wait:

**1. Below break-even — zero, or a partial multiplier?**
On the reference result screen the payout curve visibly continues *below* the break-even
line, and the lowest axis tick (6232) sits under break-even (6418) — which reads like there's
a consolation band rather than a hard cliff to zero. The brief doesn't state it either way.
*Assuming:* a small sub-break-even band (~0.2x) down to a floor, on the reasoning that a
near-miss paying literally nothing makes the mode feel punitive on exactly the loss that
stings most. Happy to make it a hard zero if that's the intent — it's a config value either
way, but it changes the RTP target I tune to.

**2. "Every *feature thoughts* prompt in your personal assignment document"**
The deliverables section refers to this, but the document I have has no section by that name.
Is there a separate personal assignment doc I should have been sent? *Assuming:* it maps to
§2.6 Design Questions and the two Pop Shot questions in §3, and I'm answering all of those.

**3. Cash only, or gems too?**
The intro mentions playing "for money or gems", but the Blitz section is entirely cash.
*Assuming:* Blitz is cash-only, and gems are out of scope.

**4. Practice mode alongside Blitz?**
The screenshots show a free Practice Mode with its own leaderboard. *Assuming:* yes, both
exist in the build, and Practice is what a player gets on a game where `blitz_enabled` is
false — which also gives me a clean way to demonstrate the per-game toggle.

**5. Prize Wheel** — visible on the reference result screen. *Assuming:* out of scope.

**6. Deposits** — is a mock deposit flow in the UI expected, or is a pre-seeded balance on the
test account enough? *Assuming:* a mock "add funds" button that goes through the same ledger
path as everything else, since it's cheap and proves the ledger rather than bypassing it.

**7. Result screen contents** — solo mode has no opponent, but the practice screenshots show a
high score and past scores. *Assuming:* the Blitz result screen shows the player's own score
against the locked curve, plus their recent history — no leaderboard.

Thanks — will flag anything else as I hit it.

---

## Notes to self (do not send)

- Q1 is the one with real economic consequence: a consolation band costs a couple of RTP
  points and has to be paid for elsewhere in the curve. Build it as a config value
  (`sub_breakeven_mult`) so switching to a hard zero is a data change, not a rebuild.
- Q2 is worth asking even if the answer is "that's the same thing" — it costs nothing and the
  brief explicitly says spotting its own ambiguities is part of the exercise.
- If there's no reply within a day or two, proceed on every assumption above and record each
  one in DECISIONS.md as an assumption rather than a decision, so the distinction is visible.
