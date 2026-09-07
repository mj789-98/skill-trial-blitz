# DECISIONS

Written incrementally as the build progresses, not retrofitted at the end.

## Format

Each entry states the call, the alternatives considered, and what would change my mind.

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

_More entries follow as decisions are made._
