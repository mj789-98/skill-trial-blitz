using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using SkillApp.ChickenRun.Sim;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// Half of the C#/JS determinism cross-check.
    ///
    /// The server pays out on the score ITS simulation computes from the player's
    /// input trace. If the C# and JS implementations ever disagree, an honest
    /// player gets accused of cheating — so "they agree" cannot be an assumption,
    /// it has to be a test that runs.
    ///
    /// This side generates the cases AND records what C# produced for each. The
    /// cases travel in the same file as the results, so the JS side never has to
    /// reproduce the case generation itself — which would just be a second thing
    /// that could silently drift.
    ///
    ///   Unity.exe -quit -batchmode -nographics -projectPath &lt;unity&gt; \
    ///     -executeMethod SkillApp.EditorTools.ParityExport.ExportCases
    ///
    /// Then `node tools/parity/check.js` replays them through the JS.
    /// </summary>
    public static class ParityExport
    {
        private const string OutputPath = "../tools/parity/cases.json";
        private const int CaseCount = 500;

        [MenuItem("SkillApp/Export Parity Cases")]
        public static void ExportCases()
        {
            // Fixed generator seed: the case set must be identical run to run, or
            // a failure cannot be reproduced from the report.
            var gen = new Sim.Rng(0xC0FFEE);
            var sb = new StringBuilder();

            sb.Append("{\n  \"generatedBy\": \"unity/Assets/_Project/Editor/ParityExport.cs\",\n");
            sb.Append("  \"note\": \"Each case carries the trace AND the result C# computed. ");
            sb.Append("tools/parity/check.js replays the same trace through the JS sim and ");
            sb.Append("asserts every field matches.\",\n");
            sb.Append("  \"cases\": [\n");

            for (int i = 0; i < CaseCount; i++)
            {
                uint seed = gen.Next();
                var events = RandomTrace(ref gen);
                string trace = Sim.EncodeTrace(events);
                var result = Sim.Simulate(seed, Sim.DecodeTrace(trace));

                sb.Append("    {");
                sb.Append($"\"seed\": \"{seed.ToString(CultureInfo.InvariantCulture)}\", ");
                sb.Append($"\"trace\": \"{trace}\", ");
                sb.Append("\"expected\": {");
                sb.Append($"\"score\": {result.Score}, ");
                sb.Append($"\"reason\": \"{result.Reason}\", ");
                sb.Append($"\"ticks\": {result.Ticks}, ");
                sb.Append($"\"furthestRow\": {result.FurthestRow}, ");
                sb.Append($"\"inputs\": {result.Inputs}");
                sb.Append("}}");
                if (i < CaseCount - 1) sb.Append(',');
                sb.Append('\n');
            }

            sb.Append("  ]\n}\n");

            var absolute = Path.GetFullPath(Path.Combine(Application.dataPath, "..", OutputPath));
            Directory.CreateDirectory(Path.GetDirectoryName(absolute)!);
            File.WriteAllText(absolute, sb.ToString());

            Debug.Log($"[parity] wrote {CaseCount} cases to {absolute}");
        }

        /// <summary>
        /// Build a random but plausible trace.
        ///
        /// Deliberately not "march forward until dead": the interesting
        /// divergences live in the awkward cases — inputs refused by the hop
        /// cooldown, sideways shuffles, long idle gaps that arm the kill line, and
        /// runs that stop without cashing out. So the generator produces all of
        /// them, including inputs that will be rejected.
        /// </summary>
        private static List<Sim.InputEvent> RandomTrace(ref Sim.Rng gen)
        {
            var events = new List<Sim.InputEvent>();
            int count = 5 + gen.Below(60);
            int tick = 0;

            for (int i = 0; i < count; i++)
            {
                // Mostly legal spacing, sometimes faster than the cooldown so the
                // rate limiter is exercised, occasionally a long pause so the idle
                // line gets a chance to fire.
                int roll = gen.Below(100);
                if (roll < 15) tick += 1 + gen.Below(Sim.HopCooldownTicks - 1);
                else if (roll < 90) tick += Sim.HopCooldownTicks + gen.Below(20);
                else tick += 60 + gen.Below(240);

                // Weighted towards forward, which is what a real player does.
                int a = gen.Below(100);
                byte action;
                if (a < 55) action = Sim.ActForward;
                else if (a < 70) action = Sim.ActLeft;
                else if (a < 85) action = Sim.ActRight;
                else if (a < 95) action = Sim.ActBack;
                else action = Sim.ActCashOut;

                events.Add(new Sim.InputEvent(tick, action));
                if (action == Sim.ActCashOut) break;
            }

            return events;
        }
    }
}
