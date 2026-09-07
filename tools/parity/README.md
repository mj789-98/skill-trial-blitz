# C# ↔ JS determinism cross-check

The server replays a player's input trace through `functions/sim/chickenRun.js`
and pays out on the score **it** computes. The client runs the C# port in
`unity/Assets/_Project/ChickenRun/Sim/ChickenRunSim.cs`.

If those two ever disagree, the server silently accuses an honest player of
cheating — and it would surface as a rare, unreproducible complaint rather than
as a crash. So the agreement is a test, not an assumption.

## Running it

```bash
# 1. Generate cases and record what C# produced for each.
"C:/Program Files/Unity/Hub/Editor/6000.1.13f1/Editor/Unity.exe" \
  -quit -batchmode -nographics -projectPath unity \
  -executeMethod SkillApp.EditorTools.ParityExport.ExportCases \
  -logFile parity.log

# 2. Replay the identical traces through the JS simulation.
node tools/parity/check.js
```

Exit code 0 means every field of every case matched.

## Why the cases carry their own expected results

`cases.json` holds the trace **and** the result C# computed. The JS side only
replays; it never regenerates the case set. Two generators would be a second
thing that could drift, and a drift there would produce a green check while
comparing different inputs.

## What the case generator deliberately covers

Not "march forward until dead". The interesting divergences live in the awkward
cases, so the generator emits inputs refused by the hop cooldown, sideways
shuffles, long idle gaps that arm the kill line, and runs that stop without ever
cashing out. `check.js` reports the outcome mix and warns if fewer than three
distinct outcomes were exercised — a run where everything died the same way
would pass while testing almost nothing.
