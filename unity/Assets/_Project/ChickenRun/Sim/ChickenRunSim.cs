using System;
using System.Collections.Generic;

namespace SkillApp.ChickenRun.Sim
{
    /// <summary>
    /// Chicken Run — the client-side simulation.
    ///
    /// This is a line-for-line port of functions/sim/chickenRun.js. The two MUST
    /// agree exactly: the server replays the player's input trace through the JS
    /// version and pays out on the score IT computes, so any divergence means an
    /// honest player is accused of cheating. tools/parity asserts they agree
    /// across hundreds of random seeds and traces.
    ///
    /// Rules for touching this file:
    ///
    ///   * NO float or double. Anywhere. Not in a position, a speed, or a
    ///     comparison. IEEE-754 rounding can differ between IL2CPP on ARM64 and
    ///     V8, and one wrong bit mid-run changes the outcome.
    ///   * No UnityEngine types, no Time.deltaTime, no UnityEngine.Random, no
    ///     physics. This namespace is pure state and must stay testable headless.
    ///   * Any change here needs the same change in the JS file, and the parity
    ///     test re-run.
    ///
    /// The renderer (ChickenRun/View) may use all the floats it likes to
    /// interpolate between ticks. It must never feed a value back in.
    /// </summary>
    public static class Sim
    {
        // ── Tuning constants (must match the JS exactly) ────────────────────

        public const int TickHz = 50;
        public const int Cols = 9;
        public const int Sub = 1000;
        public const int TrackSub = Cols * Sub;

        public const int HopCooldownTicks = 6;

        // 2.5s grace, then a row every 1.1s, starting 4 rows back.
        public const int IdleGraceTicks = 125;
        public const int IdleStepTicks = 55;
        public const int IdleLeadRows = 4;

        public const int MaxTicks = 60 * 60 * TickHz;

        public const int RowGrass = 0;
        public const int RowRoad = 1;
        public const int RowRail = 2;
        public const int RowRiver = 3;

        public const byte ActForward = 1;
        public const byte ActBack = 2;
        public const byte ActLeft = 3;
        public const byte ActRight = 4;
        public const byte ActCashOut = 5;

        public const string EndCashOut = "cash_out";
        public const string EndDeath = "death";
        public const string EndIdle = "idle";
        public const string EndAborted = "aborted";

        // ── Deterministic pseudo-randomness ─────────────────────────────────

        /// <summary>
        /// mulberry32.
        ///
        /// C# uint arithmetic wraps mod 2^32, which is bit-identical to what
        /// JavaScript's Math.imul(...) &gt;&gt;&gt; 0 produces. That equivalence is the
        /// whole reason this generator was chosen over anything float-based.
        /// </summary>
        public struct Rng
        {
            private uint _a;

            public Rng(uint seed) { _a = seed; }

            public uint Next()
            {
                unchecked
                {
                    _a += 0x6d2b79f5u;
                    uint t = _a;
                    t = (t ^ (t >> 15)) * (t | 1u);
                    t ^= t + (t ^ (t >> 7)) * (t | 61u);
                    return t ^ (t >> 14);
                }
            }

            /// <summary>Uniform in [0, n). Modulo bias is irrelevant at these n.</summary>
            public int Below(int n) => (int)(Next() % (uint)n);
        }

        /// <summary>Mix a seed with a row index so rows are independent.</summary>
        public static uint RowSeed(uint seed, int row)
        {
            unchecked
            {
                uint h = seed ^ ((uint)(row + 1) * 0x9e3779b1u);
                h = (h ^ (h >> 16)) * 0x85ebca6bu;
                h = (h ^ (h >> 13)) * 0xc2b2ae35u;
                return h ^ (h >> 16);
            }
        }

        /// <summary>
        /// Parse the server-issued seed. It travels as a decimal string because a
        /// 32-bit unsigned value does not survive a JS number cleanly, and the
        /// client and server disagreeing about the seed would be catastrophic.
        /// </summary>
        public static uint ParseSeed(string seed)
        {
            if (string.IsNullOrEmpty(seed)) throw new ArgumentException("seed is empty");
            if (!uint.TryParse(seed, out var value))
            {
                // Values above uint.MaxValue wrap, matching JS `Number(x) >>> 0`.
                if (!ulong.TryParse(seed, out var wide))
                    throw new ArgumentException($"seed is not a decimal string: {seed}");
                value = unchecked((uint)wide);
            }
            return value;
        }

        /// <summary>
        /// Integer division matching JavaScript's Math.floor for negative
        /// numerators. C#'s / truncates toward zero, so -1/1000 is 0 here but -1
        /// in JS.
        ///
        /// Every caller currently divides a value already proved to be in
        /// [0, TrackSub), so the two agree regardless — but relying on that
        /// silently is exactly how a port drifts, so the difference is handled
        /// rather than assumed away.
        /// </summary>
        public static int FloorDiv(int a, int b)
        {
            int q = a / b;
            if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
            return q;
        }

        /// <summary>Non-negative modulo, matching the JS `((x % m) + m) % m`.</summary>
        public static int Mod(int a, int m)
        {
            int r = a % m;
            return r < 0 ? r + m : r;
        }

        // ── The world: pure functions of (seed, row) ────────────────────────

        public static int RowTypeAt(uint seed, int row)
        {
            if (row <= 2) return RowGrass;

            var rng = new Rng(RowSeed(seed, row));
            int roll = rng.Below(100);

            int depth = Math.Min(row, 120);
            int grassPct = 34 - (depth * 14) / 120;
            int roadPct = 34 - (depth * 6) / 120;
            int railPct = 12 + (depth * 8) / 120;

            if (roll < grassPct) return RowGrass;
            if (roll < grassPct + roadPct) return RowRoad;
            if (roll < grassPct + roadPct + railPct) return RowRail;
            return RowRiver;
        }

        /// <summary>
        /// Static obstacles on a grass row, as a bitmask over columns. A hop into
        /// one is refused, never fatal.
        /// </summary>
        public static int GrassObstacleMask(uint seed, int row)
        {
            if (row == 0) return 0;
            var rng = new Rng(RowSeed(seed, row) ^ 0x5bf03635u);
            int count = rng.Below(Math.Min(Cols - 2, 4) + 1);
            int mask = 0;
            for (int i = 0; i < count; i++) mask |= 1 << rng.Below(Cols);
            return mask;
        }

        public struct Lane
        {
            public int Dir;
            public int Count;
            public int Speed;
            public int Gap;
            public int Offset;
            public int LengthSub;
        }

        public static Lane LaneTraffic(uint seed, int row, int kind)
        {
            var rng = new Rng(RowSeed(seed, row) ^ (kind == RowRoad ? 0x1b873593u : 0xcc9e2d51u));

            var lane = new Lane { Dir = rng.Below(2) == 0 ? 1 : -1 };

            if (kind == RowRoad)
            {
                lane.Count = 2 + rng.Below(3);
                lane.Speed = 40 + rng.Below(71);
                lane.Gap = TrackSub / lane.Count;
                lane.Offset = rng.Below(TrackSub);
                lane.LengthSub = (1 + rng.Below(2)) * Sub;
                return lane;
            }

            lane.Count = 2 + rng.Below(2);
            lane.Speed = 20 + rng.Below(41);
            lane.Gap = TrackSub / lane.Count;
            lane.Offset = rng.Below(TrackSub);
            lane.LengthSub = (2 + rng.Below(2)) * Sub;
            return lane;
        }

        /// <summary>Closed-form position of body i at a tick. Nothing accumulates.</summary>
        public static int BodyPos(Lane lane, int i, int tick)
        {
            int raw = lane.Offset + i * lane.Gap + lane.Dir * lane.Speed * tick;
            return Mod(raw, TrackSub);
        }

        public static bool SpanCovers(int pos, int lengthSub, int p)
        {
            int end = pos + lengthSub;
            if (end <= TrackSub) return p >= pos && p < end;
            return p >= pos || p < end - TrackSub;
        }

        public struct Rail
        {
            public int PeriodTicks;
            public int PhaseTicks;
            public int OccupyTicks;
            public int WarnTicks;
        }

        public static Rail RailSchedule(uint seed, int row)
        {
            var rng = new Rng(RowSeed(seed, row) ^ 0x27d4eb2fu);
            return new Rail
            {
                PeriodTicks = 200 + rng.Below(176),
                PhaseTicks = rng.Below(200),
                OccupyTicks = 25,
                WarnTicks = 70,
            };
        }

        public static bool TrainPresent(Rail s, int tick) =>
            Mod(tick + s.PhaseTicks, s.PeriodTicks) < s.OccupyTicks;

        /// <summary>
        /// Whether the crossing signal is flashing. Exposed so the renderer and
        /// the simulation cannot disagree about when a hazard is announced —
        /// dying to a train the signal never warned about would be unfair.
        /// </summary>
        public static bool TrainWarning(Rail s, int tick)
        {
            int t = Mod(tick + s.PhaseTicks, s.PeriodTicks);
            return t >= s.PeriodTicks - s.WarnTicks || t < s.OccupyTicks;
        }

        // ── Trace encoding ──────────────────────────────────────────────────

        public struct InputEvent
        {
            public int Tick;
            public byte Action;
            public InputEvent(int tick, byte action) { Tick = tick; Action = action; }
        }

        /// <summary>
        /// Pack inputs as uint16 tick-delta + action byte, then base64. A full run
        /// is a few hundred bytes.
        /// </summary>
        public static string EncodeTrace(IReadOnlyList<InputEvent> events)
        {
            var buf = new byte[events.Count * 3];
            int prev = 0, o = 0;
            foreach (var e in events)
            {
                int delta = e.Tick - prev;
                if (delta < 0) throw new ArgumentException("trace events must be ordered by tick");
                if (delta > 0xffff) throw new ArgumentException("gap between inputs exceeds uint16");
                buf[o] = (byte)(delta & 0xff);
                buf[o + 1] = (byte)((delta >> 8) & 0xff);
                buf[o + 2] = e.Action;
                prev = e.Tick;
                o += 3;
            }
            return Convert.ToBase64String(buf);
        }

        public static List<InputEvent> DecodeTrace(string b64)
        {
            var buf = Convert.FromBase64String(b64);
            if (buf.Length % 3 != 0) throw new ArgumentException("trace length is not a multiple of 3");

            var events = new List<InputEvent>(buf.Length / 3);
            int tick = 0;
            for (int o = 0; o < buf.Length; o += 3)
            {
                tick += buf[o] | (buf[o + 1] << 8);
                byte action = buf[o + 2];
                if (action < ActForward || action > ActCashOut)
                    throw new ArgumentException($"trace contains unknown action {action}");
                if (tick > MaxTicks) throw new ArgumentException("trace exceeds the maximum round length");
                events.Add(new InputEvent(tick, action));
            }
            return events;
        }

        // ── The simulation ──────────────────────────────────────────────────

        public struct Result
        {
            public int Score;
            public string Reason;
            public int Ticks;
            public int FurthestRow;
            public int Inputs;
        }

        public static Result Simulate(string seed, string traceB64) =>
            Simulate(ParseSeed(seed), DecodeTrace(traceB64));

        /// <summary>
        /// Replay a run. Mirrors simulate() in the JS, step for step.
        /// </summary>
        public static Result Simulate(uint seed, List<InputEvent> events)
        {
            int row = 0;
            int colSub = (Cols / 2) * Sub;
            int furthestRow = 0;
            int lastAdvanceTick = 0;
            int lastInputTick = -HopCooldownTicks;

            string reason = null;
            int tick = 0;

            int lastEventTick = events.Count > 0 ? events[events.Count - 1].Tick : 0;
            // Run slightly past the last input so a hop into traffic still
            // resolves: otherwise a player could escape a car by going silent.
            int endTick = Math.Min(lastEventTick + HopCooldownTicks, MaxTicks);

            int ei = 0;

            for (tick = 0; tick <= endTick; tick++)
            {
                // 1. Inputs for this tick.
                while (ei < events.Count && events[ei].Tick == tick)
                {
                    byte action = events[ei].Action;
                    ei++;

                    if (tick - lastInputTick < HopCooldownTicks) continue;
                    lastInputTick = tick;

                    if (action == ActCashOut) { reason = EndCashOut; break; }

                    int col = FloorDiv(colSub, Sub);
                    int nextRow = row;
                    int nextCol = col;

                    if (action == ActForward) nextRow = row + 1;
                    else if (action == ActBack) nextRow = row - 1;
                    else if (action == ActLeft) nextCol = col - 1;
                    else if (action == ActRight) nextCol = col + 1;

                    if (nextCol < 0 || nextCol >= Cols || nextRow < 0) continue;

                    if (RowTypeAt(seed, nextRow) == RowGrass &&
                        (GrassObstacleMask(seed, nextRow) & (1 << nextCol)) != 0)
                    {
                        continue;
                    }

                    row = nextRow;
                    colSub = nextCol * Sub;

                    // Score is the furthest row REACHED, so retreating to dodge
                    // costs nothing. Only forward progress resets the idle line.
                    if (row > furthestRow)
                    {
                        furthestRow = row;
                        lastAdvanceTick = tick;
                    }
                }
                if (reason != null) break;

                // 2. Carried by a log.
                int kind = RowTypeAt(seed, row);
                if (kind == RowRiver)
                {
                    var lane = LaneTraffic(seed, row, RowRiver);
                    if (LogUnder(lane, colSub, tick) < 0) { reason = EndDeath; break; }

                    colSub += lane.Dir * lane.Speed;
                    if (colSub < 0 || colSub >= TrackSub) { reason = EndDeath; break; }
                }

                // 3. Hazards.
                if (kind == RowRoad)
                {
                    if (VehicleUnder(LaneTraffic(seed, row, RowRoad), colSub, tick))
                    {
                        reason = EndDeath;
                        break;
                    }
                }
                else if (kind == RowRail)
                {
                    if (TrainPresent(RailSchedule(seed, row), tick)) { reason = EndDeath; break; }
                }

                // 4. The idle line.
                if (tick - lastAdvanceTick > IdleGraceTicks)
                {
                    int advanced = (tick - lastAdvanceTick - IdleGraceTicks) / IdleStepTicks;
                    int lineRow = furthestRow - IdleLeadRows + advanced;
                    if (row <= lineRow) { reason = EndIdle; break; }
                }
            }

            // A trace that simply stops is an abandoned run, NOT a cash-out.
            // Banking has to be deliberate: if silence banked a score, killing the
            // app would be a risk-free exit.
            if (reason == null) reason = EndAborted;

            return new Result
            {
                Score = reason == EndCashOut ? furthestRow : 0,
                Reason = reason,
                Ticks = tick,
                FurthestRow = furthestRow,
                Inputs = events.Count,
            };
        }

        public static int LogUnder(Lane lane, int colSub, int tick)
        {
            int p = Mod(colSub, TrackSub);
            for (int i = 0; i < lane.Count; i++)
            {
                if (SpanCovers(BodyPos(lane, i, tick), lane.LengthSub, p)) return i;
            }
            return -1;
        }

        public static bool VehicleUnder(Lane lane, int colSub, int tick)
        {
            // The chicken is a point at the centre of its cell. Using the centre
            // rather than the whole cell makes a near-miss read as a near-miss
            // instead of a death.
            int p = (FloorDiv(colSub, Sub) * Sub + Sub / 2) % TrackSub;
            for (int i = 0; i < lane.Count; i++)
            {
                if (SpanCovers(BodyPos(lane, i, tick), lane.LengthSub, p)) return true;
            }
            return false;
        }
    }
}
