using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using ChickenSim = SkillApp.ChickenRun.Simulation.Sim;
using PopSim = SkillApp.PopShot.Simulation.Sim;

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
        private const int PopCaseCount = 500;

        [MenuItem("SkillApp/Export Parity Cases")]
        public static void ExportCases()
        {
            // Fixed generator seed: the case set must be identical run to run, or
            // a failure cannot be reproduced from the report.
            var gen = new ChickenSim.Rng(0xC0FFEE);
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
                string trace = ChickenSim.EncodeTrace(events);
                var result = ChickenSim.Simulate(seed, ChickenSim.DecodeTrace(trace));

                sb.Append("    {");
                sb.Append("\"game\": \"chicken_run\", ");
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


            // ── Pop Shot ────────────────────────────────────────────────────
            // Same file, same run. One cases.json means one command to
            // regenerate and no chance of checking a stale half.
            sb.Append(",\n");
            var popGen = new PopSim.Rng(0xBADCAFE);

            for (int i = 0; i < PopCaseCount; i++)
            {
                uint seed = popGen.Next();
                var events = RandomPopTrace(ref popGen);
                string trace = PopSim.EncodeTrace(events);
                var result = PopSim.Simulate(seed, PopSim.DecodeTrace(trace));

                sb.Append("    {");
                sb.Append("\"game\": \"pop_shot\", ");
                sb.Append($"\"seed\": \"{seed.ToString(CultureInfo.InvariantCulture)}\", ");
                sb.Append($"\"trace\": \"{trace}\", ");
                sb.Append("\"expected\": {");
                sb.Append($"\"score\": {result.Score}, ");
                sb.Append($"\"reason\": \"{result.Reason}\", ");
                sb.Append($"\"ticks\": {result.Ticks}, ");
                sb.Append($"\"baskets\": {result.Baskets}, ");
                sb.Append($"\"swishes\": {result.Swishes}, ");
                sb.Append($"\"inputs\": {result.Inputs}");
                sb.Append("}}");
                if (i < PopCaseCount - 1) sb.Append(',');
                sb.Append('\n');
            }

            sb.Append("  ]\n}\n");

            var absolute = Path.GetFullPath(Path.Combine(Application.dataPath, "..", OutputPath));
            Directory.CreateDirectory(Path.GetDirectoryName(absolute)!);
            File.WriteAllText(absolute, sb.ToString());

            Debug.Log($"[parity] wrote {CaseCount + PopCaseCount} cases to {absolute}");
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
        private static List<ChickenSim.InputEvent> RandomTrace(ref ChickenSim.Rng gen)
        {
            var events = new List<ChickenSim.InputEvent>();
            int count = 5 + gen.Below(60);
            int tick = 0;

            for (int i = 0; i < count; i++)
            {
                // Mostly legal spacing, sometimes faster than the cooldown so the
                // rate limiter is exercised, occasionally a long pause so the idle
                // line gets a chance to fire.
                int roll = gen.Below(100);
                if (roll < 15) tick += 1 + gen.Below(ChickenSim.HopCooldownTicks - 1);
                else if (roll < 90) tick += ChickenSim.HopCooldownTicks + gen.Below(20);
                else tick += 60 + gen.Below(240);

                // Weighted towards forward, which is what a real player does.
                int a = gen.Below(100);
                byte action;
                if (a < 55) action = ChickenSim.ActForward;
                else if (a < 70) action = ChickenSim.ActLeft;
                else if (a < 85) action = ChickenSim.ActRight;
                else if (a < 95) action = ChickenSim.ActBack;
                else action = ChickenSim.ActCashOut;

                events.Add(new ChickenSim.InputEvent(tick, action));
                if (action == ChickenSim.ActCashOut) break;
            }

            return events;
        }
        /// <summary>
        /// Build a random but plausible Pop Shot trace.
        ///
        /// Pop Shot has one action, so the interesting variation is entirely in
        /// TIMING. The generator covers the three regimes that matter: taps
        /// refused by the cooldown, ordinary play, and long silences where the
        /// ball falls, bounces, wraps, and the clock does or does not expire. A
        /// generator that only produced well-spaced taps would exercise none of
        /// the rim bounces, which is where the integer sqrt lives.
        /// </summary>
        private static List<PopSim.InputEvent> RandomPopTrace(ref PopSim.Rng gen)
        {
            var events = new List<PopSim.InputEvent>();
            int count = 5 + (int)(gen.Next() % 90u);
            int tick = 0;

            for (int i = 0; i < count; i++)
            {
                int roll = (int)(gen.Next() % 100u);
                if (roll < 15) tick += 1 + (int)(gen.Next() % (uint)(PopSim.TapCooldownTicks - 1));
                else if (roll < 88) tick += PopSim.TapCooldownTicks + (int)(gen.Next() % 25u);
                else tick += 40 + (int)(gen.Next() % 200u);

                events.Add(new PopSim.InputEvent(tick, PopSim.ActTap));
            }

            return events;
        }
    }
}
