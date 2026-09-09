using System;
using System.Collections.Generic;
using UnityEngine;
using SkillApp.PopShot.Simulation;

namespace SkillApp.PopShot
{
    /// <summary>
    /// Drives the Pop Shot simulation and owns the round.
    ///
    /// Same fixed-step contract as ChickenRunGame: the simulation advances in
    /// whole 50Hz ticks and never reads frame time, because the server replays
    /// the same tick sequence and a client whose tick rate varied with frame rate
    /// would produce a trace that replays to a different score.
    ///
    /// ── Slow-motion is free ──────────────────────────────────────────────────
    ///
    /// The brief asks for a slow-motion buzzer-beater. That would normally be a
    /// problem for a replayed game — but it is not, because the simulation is
    /// indexed by TICK, not by time. The client may feed ticks at any rate it
    /// likes; the server replays the same ticks and gets the same answer, and has
    /// no idea how fast they were played.
    ///
    /// So slow-motion here is literally one line: during the buzzer window, spend
    /// accumulated real time more slowly. Nothing about the physics changes,
    /// nothing about determinism changes, and the trace is unaffected.
    ///
    /// (It also cannot be abused. Playing slowly makes a round take longer in
    /// wall-clock terms, and the server's heartbeat clamp bounds score by elapsed
    /// time — so stretching time can only ever make a claim MORE plausible, never
    /// less.)
    /// </summary>
    public class PopShotGame : MonoBehaviour
    {
        /// <summary>Raised once per simulation tick, after it advances.</summary>
        public event Action<Sim.State> Ticked;

        /// <summary>Raised when a basket is scored. True when it was a swish.</summary>
        public event Action<bool> Scored;

        /// <summary>Raised when the ball hits the rim or the backboard.</summary>
        public event Action Clanged;

        /// <summary>Raised when an input was accepted and the ball was lifted.</summary>
        public event Action Flapped;

        /// <summary>Raised once, when the round ends. Carries the reason.</summary>
        public event Action<string> RunEnded;

        public Sim.State State { get; private set; }
        public bool IsRunning => State != null && State.Reason == null;

        /// <summary>Previous tick's position, so the renderer can interpolate.</summary>
        public int PrevX { get; private set; }
        public int PrevY { get; private set; }

        /// <summary>How far through the current tick we are, in [0,1). Render only.</summary>
        public float TickAlpha => Mathf.Clamp01((float)(_accumulator / TickSeconds));

        /// <summary>True while the buzzer window is open. The view slows and tints on this.</summary>
        public bool InBuzzer => State != null && Sim.InBuzzerWindow(State);

        private const double TickSeconds = 1.0 / Sim.TickHz;

        /// <summary>Ceiling on ticks per frame; see ChickenRunGame for why.</summary>
        private const int MaxTicksPerFrame = 5;

        /// <summary>How much slower the buzzer window runs. Render pacing only.</summary>
        [SerializeField] private float buzzerSlowdown = 0.35f;

        private readonly List<byte> _pending = new List<byte>(4);
        private readonly List<Sim.InputEvent> _trace = new List<Sim.InputEvent>(256);
        private double _accumulator;
        private bool _paused;

        /// <summary>Every input issued this run, for the server to replay.</summary>
        public IReadOnlyList<Sim.InputEvent> Trace => _trace;

        public void StartRun(string seed)
        {
            State = Sim.CreateState(seed);
            PrevX = State.X;
            PrevY = State.Y;
            _trace.Clear();
            _pending.Clear();
            _accumulator = 0;
            _paused = false;
        }

        public void SetPaused(bool paused)
        {
            _paused = paused;
            if (!paused) _accumulator = 0;
        }

        /// <summary>
        /// Queue an input for the next tick.
        ///
        /// Recorded into the trace even when the simulation will refuse it — the
        /// server replays every input the client claims to have made and applies
        /// the same cooldown, so omitting refused inputs would desynchronise the
        /// two.
        /// </summary>
        public void Enqueue(byte action)
        {
            if (!IsRunning) return;
            _pending.Add(action);
        }

        private void Update()
        {
            if (!IsRunning || _paused) return;

            // The ONLY thing slow-motion changes. Ticks still advance the
            // simulation identically; they simply arrive less often.
            float rate = InBuzzer ? buzzerSlowdown : 1f;
            _accumulator += Time.unscaledDeltaTime * rate;

            int ticksThisFrame = 0;
            while (_accumulator >= TickSeconds && ticksThisFrame < MaxTicksPerFrame)
            {
                _accumulator -= TickSeconds;
                ticksThisFrame++;
                if (!AdvanceOneTick()) return;
            }

            if (ticksThisFrame >= MaxTicksPerFrame) _accumulator = 0;
        }

        /// <summary>Returns false if the run ended on this tick.</summary>
        private bool AdvanceOneTick()
        {
            PrevX = State.X;
            PrevY = State.Y;

            int tick = State.Tick;
            int pointsBefore = State.Points;
            int swishesBefore = State.Swishes;
            bool rimBefore = State.TouchedRim;
            bool boardBefore = State.TouchedBoard;
            int lastTapBefore = State.LastTapTick;

            for (int i = 0; i < _pending.Count; i++)
            {
                _trace.Add(new Sim.InputEvent(tick, _pending[i]));
            }

            var reason = Sim.Step(State, _pending);
            _pending.Clear();

            if (State.LastTapTick != lastTapBefore) Flapped?.Invoke();

            if (State.Points > pointsBefore)
            {
                Scored?.Invoke(State.Swishes > swishesBefore);
            }
            else if ((State.TouchedRim && !rimBefore) || (State.TouchedBoard && !boardBefore))
            {
                // Only when it did NOT go in. A rattling make should sound like a
                // make, not like a miss with a clang on top.
                Clanged?.Invoke();
            }

            Ticked?.Invoke(State);

            if (reason != null)
            {
                RunEnded?.Invoke(reason);
                return false;
            }
            return true;
        }
    }
}
