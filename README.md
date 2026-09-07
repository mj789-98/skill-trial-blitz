# Skill-Gaming Work Trial — Chicken Run + Blitz

> **Status: in progress.** This README is filled in as the build lands. See
> [`PROJECT_KICKOFF.md`](PROJECT_KICKOFF.md) for the full plan and
> [`DECISIONS.md`](DECISIONS.md) for the judgement calls.

## Platform

**Android.** The brief states Android is completely fine and nothing is penalised for
choosing it; this was developed on a Windows machine with no access to macOS/Xcode.

## Versions

| Component | Pinned | Used |
| --- | --- | --- |
| Unity Editor | `6000.1.13f1` | `6000.1.13f1` (changeset `418bd0acaa6b`) |
| React Native | `0.86.0` | _tbd_ |
| React | `19.2.3` | _tbd_ |
| TypeScript (app) | `^5.8.3` | _tbd_ |
| Node — RN tooling | `>= 22.11.0` | `22.15.1` |
| Node — Functions runtime | `20` | _tbd_ |
| `firebase-functions` | `^5.0.0` | _tbd_ |
| `firebase-admin` | `^12.0.0` | _tbd_ |
| `pg` | `^8.20.0` | _tbd_ |
| Unity-as-a-Library embed | _(deliberately unpinned by the brief)_ | `@azesmway/react-native-unity@1.1.1` |

Supporting toolchain: JDK 17 (Android Studio JBR 17.0.6), Android SDK platform 36 +
build-tools 36.0.0, NDK from Unity's bundled Android module.

## Repository layout

```
app/         React Native 0.86 (TypeScript) — the only thing that talks to the backend
unity/       Unity 6000.1.13f1 — games. Sim/ is pure integer logic; View/ renders it
functions/   Firebase Functions (JavaScript) — money, target engine, score validation
sql/         Schema and seed, applied to Supabase Postgres
tools/       Tuning harness + the C#↔JS determinism cross-check
docs/        Harness output, charts, notes
```

## Running it from a clean checkout

_tbd — filled in once the pieces exist._

## Test account

_tbd_
