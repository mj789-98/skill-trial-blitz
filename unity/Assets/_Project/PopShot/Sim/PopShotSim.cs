using System;
using System.Collections.Generic;

namespace SkillApp.PopShot.Simulation
{
    /// <summary>
    /// Pop Shot — the client-side simulation.
    ///
    /// A line-for-line port of functions/sim/popShot.js. The two MUST agree
    /// exactly: the server replays the player's input trace through the JS
    /// version and pays out on the score IT computes, so any divergence means an
    /// honest player is accused of cheating. tools/parity asserts they agree
    /// across hundreds of random seeds and traces.
    ///
    /// Rules for touching this file:
    ///
    ///   * NO float or double. Anywhere. Not in a position, a speed, or a
    ///     comparison. That includes Math.Sqrt — this file carries its own
    ///     integer square root, because IEEE-754 sqrt is not guaranteed
    ///     bit-identical between IL2CPP on ARM64 and V8, and the rim bounce
    ///     depends on it.
    ///   * No UnityEngine types, no Time.deltaTime, no UnityEngine.Random, no
    ///     physics. This namespace is pure state and must stay testable headless.
    ///   * Any change here needs the same change in the JS file, and the parity
    ///     test re-run.
    ///
    /// The renderer (PopShot/View) may use all the floats it likes to interpolate
    /// between ticks. It must never feed a value back in.
    /// </summary>
    public static class Sim
    {
        // ── Fixed step and fixed point (must match the JS exactly) ──────────

        public const int TickHz = 50;
        public const int Sub = 1000;

        public const int CourtW = 9 * Sub;
        public const int CourtH = 16 * Sub;

        public const int BallR = 340;

        public const int Gravity = 22;
        public const int FlapVy = 420;
        public const int DriftVx = 60;
        public const int MaxFallVy = 620;

        public const int TapCooldownTicks = 5;

        // ── The hoop ────────────────────────────────────────────────────────

        public const int HoopY = 9500;
        public const int RimHalf = 900;
        public const int PostR = 90;
        public const int BoardThick = 90;
        public const int BoardH = 2400;

        public const int FloorRestitution = 55;
        public const int RimRestitution = 70;
        public const int BoardRestitution = 60;

        public const int FloorY = BallR;

        // ── Clock ───────────────────────────────────────────────────────────

        public const int StartClockTicks = 15 * TickHz;
        public const int BasketTimeTicks = 3 * TickHz;
        public const int SwishBonusTicks = 1 * TickHz;
        public const int MaxClockTicks = 30 * TickHz;
        public const int NoBasketLimitTicks = 60 * TickHz;
        public const int BuzzerGraceTicks = 3 * TickHz;

        public const int PointsBasket = 2;
        public const int PointsSwish = 3;

        public const byte ActTap = 1;

        public const string EndTime = "time";
        public const string EndAborted = "aborted";

        public const int MaxTicks = 60 * 60 * TickHz;

        // ── Deterministic pseudo-randomness ─────────────────────────────────

        /// <summary>mulberry32, identical to the JS. Integer ops only.</summary>
        public struct Rng
        {
            private uint _a;

            public Rng(uint seed) { _a = seed; }

            public uint Next()
            {
                unchecked
                {
                    _a = _a + 0x6d2b79f5u;
                    uint t = _a;
                    t = (uint)((int)(t ^ (t >> 15)) * (int)(1u | t));
                    t = (t + (uint)((int)(t ^ (t >> 7)) * (int)(61u | t))) ^ t;
                    return t ^ (t >> 14);
                }
            }
        }

        public static uint ParseSeed(string seed)
        {
            if (!uint.TryParse(seed, out uint value))
            {
                throw new ArgumentException($"seed is not a number: {seed}");
            }
            return value;
        }

        /// <summary>
        /// Integer square root. Exact, and identical to the JS implementation.
        ///
        /// Math.Sqrt would be the obvious choice and is exactly the thing this
        /// file exists to avoid: the rim bounce normal is derived from it, so a
        /// one-bit difference against V8 changes where the ball goes and, three
        /// seconds later, what the player is paid.
        /// </summary>
        public static int Isqrt(int n)
        {
            if (n <= 0) return 0;
            int x = n;
            int y = (x + 1) / 2;
            while (y < x)
            {
                x = y;
                y = (x + n / x) / 2;
            }
            return x;
        }

        /// <summary>
        /// Floor division. C# truncates toward zero, JS Math.floor rounds toward
        /// negative infinity, and the difference only shows up on negative
        /// numbers — which is exactly what a downward velocity is.
        /// </summary>
        public static int FloorDiv(int a, int b)
        {
            int q = a / b;
            if (a % b != 0 && ((a < 0) != (b < 0))) q--;
            return q;
        }

        // ── The world, derived from the seed ────────────────────────────────

        public static int HoopX(uint seed)
        {
            var rng = new Rng(seed ^ 0x9e3779b9u);
            return 4 * Sub + (int)(rng.Next() % (uint)(3 * Sub));
        }

        public static int DriftDir(uint seed)
        {
            var rng = new Rng(seed ^ 0x85ebca6bu);
            rng.Next();
            return (rng.Next() & 1u) == 0u ? 1 : -1;
        }

        // ── State ───────────────────────────────────────────────────────────

        /// <summary>
        /// A class rather than a struct so the renderer can hold a reference and
        /// read it as it changes, instead of copying it every frame.
        /// </summary>
        public class State
        {
            public uint Seed;
            public int Tick;
            public int X;
            public int Y;
            public int Vx;
            public int Vy;
            public int Points;
            public int Baskets;
            public int Swishes;
            public int ClockTicks;
            public bool ClockRunning;
            public int BuzzerTicks;
            public bool TouchedRim;
            public bool TouchedBoard;
            public int LastTapTick;
            public int HoopXPos;
            public string Reason;
        }

        public static State CreateState(uint seed)
        {
            int dir = DriftDir(seed);
            return new State
            {
                Seed = seed,
                Tick = 0,
                X = dir > 0 ? Sub : CourtW - Sub,
                Y = FloorY,
                Vx = DriftVx * dir,
                Vy = 0,
                Points = 0,
                Baskets = 0,
                Swishes = 0,
                ClockTicks = StartClockTicks,
                ClockRunning = false,
                BuzzerTicks = 0,
                TouchedRim = false,
                TouchedBoard = false,
                LastTapTick = -TapCooldownTicks,
                HoopXPos = HoopX(seed),
                Reason = null,
            };
        }

        public static State CreateState(string seed) => CreateState(ParseSeed(seed));

        public static int BoardX(State s) => s.HoopXPos + RimHalf + BoardThick;

        // ── One tick ────────────────────────────────────────────────────────

        public static string Step(State s, IList<byte> actions)
        {
            if (s.Reason != null) return s.Reason;

            // ── 1. Input ────────────────────────────────────────────────────
            if (actions != null)
            {
                for (int i = 0; i < actions.Count; i++)
                {
                    if (actions[i] != ActTap) continue;
                    if (s.Tick - s.LastTapTick < TapCooldownTicks) continue;
                    // SET, not add. See the JS header on the control curve.
                    s.Vy = FlapVy;
                    s.LastTapTick = s.Tick;
                }
            }

            // ── 2. Integrate ────────────────────────────────────────────────
            int prevY = s.Y;
            int prevX = s.X;

            s.Vy -= Gravity;
            if (s.Vy < -MaxFallVy) s.Vy = -MaxFallVy;

            s.X += s.Vx;
            s.Y += s.Vy;

            // ── 3. Out of bounds: roll back in from the opposite side ───────
            bool wrapped = false;
            if (s.X > CourtW)
            {
                s.X -= CourtW;
                wrapped = true;
            }
            else if (s.X < 0)
            {
                s.X += CourtW;
                wrapped = true;
            }

            // ── 4. Floor and ceiling ────────────────────────────────────────
            if (s.Y <= FloorY)
            {
                s.Y = FloorY;
                if (s.Vy < 0) s.Vy = FloorDiv(-s.Vy * FloorRestitution, 100);
                s.TouchedRim = false;
                s.TouchedBoard = false;
            }
            int ceiling = CourtH - BallR;
            if (s.Y >= ceiling)
            {
                s.Y = ceiling;
                if (s.Vy > 0) s.Vy = FloorDiv(-s.Vy, 2);
            }

            // ── 5. The hoop ─────────────────────────────────────────────────
            CollideRim(s);
            CollideBoard(s, prevX);

            if (!wrapped && prevY > HoopY && s.Y <= HoopY)
            {
                int dx = s.X - s.HoopXPos;
                int clearance = RimHalf - BallR;
                if (dx >= -clearance && dx <= clearance)
                {
                    Score(s);
                }
            }

            // ── 6. Clock ────────────────────────────────────────────────────
            if (s.ClockRunning && s.ClockTicks > 0) s.ClockTicks--;

            s.Tick++;

            // ── 7. Endings ──────────────────────────────────────────────────
            string ended = CheckEnd(s);
            if (ended != null) s.Reason = ended;
            return s.Reason;
        }

        private static void Score(State s)
        {
            bool clean = !s.TouchedRim && !s.TouchedBoard;

            s.Baskets++;
            if (clean)
            {
                s.Swishes++;
                s.Points += PointsSwish;
            }
            else
            {
                s.Points += PointsBasket;
            }

            int add = BasketTimeTicks + (clean ? SwishBonusTicks : 0);
            s.ClockTicks += add;
            if (s.ClockTicks > MaxClockTicks) s.ClockTicks = MaxClockTicks;

            s.ClockRunning = true;
            s.BuzzerTicks = 0;
        }

        /// <summary>
        /// When the round ends. See the JS header for the buzzer-beater rule and
        /// why the clock is not what ends the round.
        /// </summary>
        private static string CheckEnd(State s)
        {
            if (s.Tick >= MaxTicks) return EndTime;

            if (!s.ClockRunning)
            {
                return s.Tick >= NoBasketLimitTicks ? EndTime : null;
            }

            if (s.ClockTicks > 0) return null;

            bool live = s.Y > HoopY;
            if (!live) return EndTime;

            s.BuzzerTicks++;
            return s.BuzzerTicks >= BuzzerGraceTicks ? EndTime : null;
        }

        /// <summary>True while the round is in its buzzer window. The renderer slows time on this.</summary>
        public static bool InBuzzerWindow(State s) =>
            s.ClockRunning && s.ClockTicks == 0 && s.Reason == null;

        // ── Collisions ──────────────────────────────────────────────────────

        private static void CollideRim(State s)
        {
            int post0 = s.HoopXPos - RimHalf;
            int post1 = s.HoopXPos + RimHalf;

            for (int i = 0; i < 2; i++)
            {
                int post = i == 0 ? post0 : post1;

                int nx = s.X - post;
                int ny = s.Y - HoopY;
                int reach = BallR + PostR;
                int distSq = nx * nx + ny * ny;
                if (distSq >= reach * reach) continue;

                int dist = Isqrt(distSq);
                if (dist == 0)
                {
                    s.Y = HoopY + reach;
                    s.Vy = s.Vy < 0 ? -s.Vy : s.Vy;
                    s.TouchedRim = true;
                    continue;
                }

                int ux = FloorDiv(nx * Sub, dist);
                int uy = FloorDiv(ny * Sub, dist);

                int dot = FloorDiv(s.Vx * ux + s.Vy * uy, Sub);
                s.Vx = s.Vx - FloorDiv(2 * dot * ux, Sub);
                s.Vy = s.Vy - FloorDiv(2 * dot * uy, Sub);

                s.Vx = FloorDiv(s.Vx * RimRestitution, 100);
                s.Vy = FloorDiv(s.Vy * RimRestitution, 100);

                s.X = post + FloorDiv(ux * reach, Sub);
                s.Y = HoopY + FloorDiv(uy * reach, Sub);

                s.TouchedRim = true;
            }
        }

        private static void CollideBoard(State s, int prevX)
        {
            int bx = BoardX(s);
            if (s.Y < HoopY || s.Y > HoopY + BoardH) return;

            bool near = s.X + BallR > bx - BoardThick && s.X - BallR < bx + BoardThick;
            if (!near) return;

            if (prevX <= bx)
            {
                s.X = bx - BoardThick - BallR;
                if (s.Vx > 0) s.Vx = FloorDiv(-s.Vx * BoardRestitution, 100);
            }
            else
            {
                s.X = bx + BoardThick + BallR;
                if (s.Vx < 0) s.Vx = FloorDiv(-s.Vx * BoardRestitution, 100);
            }

            s.TouchedBoard = true;
        }

        // ── Score ───────────────────────────────────────────────────────────

        /// <summary>
        /// Unlike Chicken Run there is no cash-out and no zeroing: points bank as
        /// they are scored, so an aborted round is worth what was already made.
        /// </summary>
        public static int ScoreFor(State s) => s.Points;

        // ── Trace encoding ──────────────────────────────────────────────────

        public struct InputEvent
        {
            public int Tick;
            public byte Action;
            public InputEvent(int tick, byte action) { Tick = tick; Action = action; }
        }

        public static string EncodeTrace(IList<InputEvent> events)
        {
            var buf = new byte[events.Count * 3];
            int prev = 0;
            int o = 0;
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
            if (b64 == null) throw new ArgumentException("trace must be a string");
            byte[] buf = Convert.FromBase64String(b64);
            if (buf.Length % 3 != 0) throw new ArgumentException("trace length is not a multiple of 3");

            var events = new List<InputEvent>(buf.Length / 3);
            int tick = 0;
            for (int o = 0; o < buf.Length; o += 3)
            {
                tick += buf[o] | (buf[o + 1] << 8);
                byte action = buf[o + 2];
                if (action != ActTap) throw new ArgumentException($"unknown action byte {action}");
                if (tick > MaxTicks) throw new ArgumentException("trace extends beyond the tick limit");
                events.Add(new InputEvent(tick, action));
            }
            return events;
        }

        // ── Replay ──────────────────────────────────────────────────────────

        public struct Result
        {
            public int Score;
            public string Reason;
            public int Ticks;
            public int Baskets;
            public int Swishes;
            public int Inputs;
        }

        public static Result Simulate(uint seed, IList<InputEvent> events)
        {
            var s = CreateState(seed);
            int next = 0;
            var pending = new List<byte>(4);

            while (s.Reason == null && s.Tick < MaxTicks)
            {
                pending.Clear();
                while (next < events.Count && events[next].Tick == s.Tick)
                {
                    pending.Add(events[next].Action);
                    next++;
                }
                Step(s, pending);
            }

            string reason = s.Reason ?? EndAborted;
            return new Result
            {
                Score = ScoreFor(s),
                Reason = reason,
                Ticks = s.Tick,
                Baskets = s.Baskets,
                Swishes = s.Swishes,
                Inputs = events.Count,
            };
        }
    }
}
