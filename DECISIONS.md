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

**What would change my mind.** A runtime "Unimplemented Component" at the spike gate. The
fallback stays a fork adding/repairing the codegen wiring, which the brief explicitly invites
("pick whatever version of it builds, and record what you used"). Pinning React Native down a
minor version is the last resort and would be a deviation from the one pinned table, so it
would be raised in the Telegram group before being done, not after.

---

