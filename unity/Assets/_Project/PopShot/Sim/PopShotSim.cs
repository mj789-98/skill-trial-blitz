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

        /// <summary>
        /// The two lanes the basket alternates between. See the JS twin.
        /// </summary>
        public const int LaneL = 2750;
        public const int LaneR = 6250;

        /// <summary>Centre of the band the rim's height is drawn from.</summary>
        public const int HoopY = 9500;
        public const int HoopYSpread = 1000;
        public const int HoopYMin = HoopY - HoopYSpread;
        public const int HoopYMax = HoopY + HoopYSpread;
        public const int RimHalf = 900;
        public const int PostR = 90;
        public const int BoardThick = 90;
        public const int BoardH = 2400;

        public const int FloorRestitution = 55;
        public const int RimRestitution = 70;
        // No BoardRestitution. The backboard does not bounce the ball -- it is
        // a sensor that disqualifies a swish. See CollideBoard.

        public const int FloorY = BallR;

        // ── Clock ───────────────────────────────────────────────────────────

        public const int StartClockTicks = 15 * TickHz;
        /// <summary>
        /// What a basket buys back on the clock. See the JS twin: at the old
        /// +3s/+1s scoring paid more clock than a cycle cost, so the round had
        /// no end, and a score with no ceiling is a payout with no ceiling.
        /// </summary>
        public const int BasketTimeTicks = 1 * TickHz;
        public const int SwishBonusTicks = TickHz / 2;
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

        /// <summary>
        /// Where the hoop stands for the nth placement of a round, n being the
        /// number of baskets already made.
        ///
        /// A pure function of (seed, n) rather than a generator advanced on
        /// each basket, so nothing has to be carried in State and nothing has
        /// to be kept in step across the two languages for the length of a
        /// round. See the JS twin for the full note.
        ///
        /// The arithmetic is written to match JS exactly. In JS the seed
        /// expression is computed on a Number and then truncated by mulberry32's
        /// `>>> 0`; here it is computed unchecked and cast. Both reduce mod
        /// 2^32, so the bits agree.
        /// </summary>
        public static void HoopPlacement(uint seed, int n, out int x, out int y)
        {
            uint mixed = unchecked((uint)((int)(seed ^ 0x9e3779b9u) + n * unchecked((int)0x85ebca6b)));
            var rng = new Rng(mixed);

            var startRng = new Rng(seed ^ 0x27d4eb2fu);
            bool startLeft = (startRng.Next() & 1u) == 0u;
            bool left = startLeft == (n % 2 == 0);

            x = left ? LaneL : LaneR;
            y = HoopYMin + (int)(rng.Next() % (uint)(HoopYMax - HoopYMin + 1));
        }

        /// <summary>
        /// Which way the ball drifts.
        ///
        /// Derived from where the basket is, not from the seed. The brief says
        /// an out-of-bounds ball "rolls back in from the side of the court
        /// OPPOSITE the basket", and a ball only ever leaves by the edge it is
        /// drifting towards — so it has to be sent out on the basket's own side.
        ///
        /// See the JS twin for the full note. Kept identical: this feeds the
        /// starting position, so a disagreement here is a divergent world.
        /// </summary>
        public static int DriftDir(int hoopXPos)
        {
            return hoopXPos * 2 >= CourtW ? 1 : -1;
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
            public int HoopYPos;
            public string Reason;
        }

        public static State CreateState(uint seed)
        {
            HoopPlacement(seed, 0, out int startX, out int startY);
            int dir = DriftDir(startX);
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
                HoopXPos = startX,
                HoopYPos = startY,
                Reason = null,
            };
        }

        public static State CreateState(string seed) => CreateState(ParseSeed(seed));

        /// <summary>
        /// The backboard's x: always OUTBOARD, so the rim opens into the court.
        /// Unconditionally +x was correct only while the hoop never left the
        /// right-hand half. See the JS twin.
        /// </summary>
        public static int BoardX(State s) =>
            s.HoopXPos * 2 >= CourtW
                ? s.HoopXPos + RimHalf + BoardThick
                : s.HoopXPos - RimHalf - BoardThick;

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
            CollideBoard(s);

            if (!wrapped && prevY > s.HoopYPos && s.Y <= s.HoopYPos)
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

            // The basket moves. One relocation per BASKET, not per point: a
            // clean shot is worth more but it is still one shot. Placed from
            // the already-incremented basket count. See the JS twin.
            HoopPlacement(s.Seed, s.Baskets, out int nx, out int ny);
            s.HoopXPos = nx;
            s.HoopYPos = ny;

            // Re-aim the drift at the new basket, or every basket is followed
            // by a full lap of the court and the brief's wrap rule stops
            // holding the moment the hoop changes sides.
            s.Vx = DriftVx * DriftDir(s.HoopXPos);
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

            bool live = s.Y > s.HoopYPos;
            if (!live) return EndTime;

            s.BuzzerTicks++;
            return s.BuzzerTicks >= BuzzerGraceTicks ? EndTime : null;
        }

        /// <summary>True while the round is in its buzzer window. The renderer slows time on this.</summary>
        public static bool InBuzzerWindow(State s) =>
            s.ClockRunning && s.ClockTicks == 0 && s.Reason == null;

        // ── Collisions ──────────────────────────────────────────────────────

        /// <summary>
        /// A rim post deflects the ball vertically. It does NOT touch Vx.
        ///
        /// This was a full 2D reflection, which is correct physics and the
        /// wrong game: horizontal travel is a conveyor, not momentum, and only
        /// the basket changing lanes may change its direction. See the JS twin
        /// for the full note.
        /// </summary>
        private static void CollideRim(State s)
        {
            int post0 = s.HoopXPos - RimHalf;
            int post1 = s.HoopXPos + RimHalf;

            for (int i = 0; i < 2; i++)
            {
                int post = i == 0 ? post0 : post1;

                int nx = s.X - post;
                int ny = s.Y - s.HoopYPos;
                int reach = BallR + PostR;
                int distSq = nx * nx + ny * ny;
                if (distSq >= reach * reach) continue;

                // Lift clear along y by exactly what clears a circle of radius
                // `reach` at this horizontal offset. No sideways shove, and no
                // special case for dist == 0: at dead centre nx is 0 and this
                // is simply the full reach, so the old divide-by-zero branch
                // has nothing left to guard.
                int clearY = Isqrt(reach * reach - nx * nx);

                if (ny >= 0)
                {
                    s.Y = s.HoopYPos + clearY;
                    if (s.Vy < 0) s.Vy = FloorDiv(-s.Vy * RimRestitution, 100);
                }
                else
                {
                    s.Y = s.HoopYPos - clearY;
                    if (s.Vy > 0) s.Vy = FloorDiv(-s.Vy * RimRestitution, 100);
                }

                s.TouchedRim = true;
            }
        }

        /// <summary>
        /// Graze the backboard: a sensor, not a wall.
        ///
        /// It marks the ball as having touched the board, which is what
        /// disqualifies a swish, and does nothing else. It used to reverse Vx.
        /// See the JS twin.
        /// </summary>
        private static void CollideBoard(State s)
        {
            int bx = BoardX(s);
            if (s.Y < s.HoopYPos || s.Y > s.HoopYPos + BoardH) return;

            bool near = s.X + BallR > bx - BoardThick && s.X - BallR < bx + BoardThick;
            if (!near) return;

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
