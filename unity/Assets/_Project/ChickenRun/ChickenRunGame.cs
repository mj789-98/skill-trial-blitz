using System;
using System.Collections.Generic;
using UnityEngine;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun
{
    /// <summary>
    /// Drives the simulation and owns the round.
    ///
    /// ── Why a fixed step ─────────────────────────────────────────────────────
    ///
    /// The simulation advances in whole 50Hz ticks and never reads frame time.
    /// That is not a stylistic choice: the server replays the same tick sequence,
    /// so if the client's tick rate varied with frame rate, a player on a slower
    /// phone would produce a trace that replays to a different score.
    ///
    /// So this class accumulates real time and spends it in whole ticks. A frame
    /// that takes 33ms runs two ticks; a frame that takes 8ms may run none. The
    /// renderer interpolates between the last two tick states, which is what makes
    /// 50Hz logic look smooth at 60fps or 120fps.
    ///
    /// ── Input timing ─────────────────────────────────────────────────────────
    ///
    /// Inputs are captured the instant they happen and queued against the NEXT
    /// tick, rather than being sampled at tick boundaries. Sampling would throw
    /// away up to 20ms of input and, worse, would quietly drop a second tap in the
    /// same tick — and the whole feel of this game is the rhythm of taps.
    /// </summary>
    public class ChickenRunGame : MonoBehaviour
    {
        /// <summary>Raised once per simulation tick, after it advances.</summary>
        public event Action<Sim.State> Ticked;

        /// <summary>Raised when the furthest row increases. Carries the new score.</summary>
        public event Action<int> ScoreChanged;

        /// <summary>Raised once, when the run ends. Carries the reason.</summary>
        public event Action<string> RunEnded;

        /// <summary>Raised when an input was accepted and the chicken moved.</summary>
        public event Action<byte> Hopped;

        /// <summary>Raised when an input was refused by terrain (a blocked hop).</summary>
        public event Action Blocked;

        public Sim.State State { get; private set; }
        public bool IsRunning => State != null && State.Reason == null;

        /// <summary>
        /// The previous tick's position, so the renderer can interpolate rather
        /// than snapping 50 times a second.
        /// </summary>
        public int PrevRow { get; private set; }
        public int PrevColSub { get; private set; }

        /// <summary>How far through the current tick we are, in [0,1). Render only.</summary>
        public float TickAlpha => Mathf.Clamp01((float)(_accumulator / TickSeconds));

        private const double TickSeconds = 1.0 / Sim.TickHz;

        /// <summary>
        /// Ceiling on ticks per frame. Without it, a long stall (a GC pause, the
        /// app resuming from background) would try to catch up hundreds of ticks
        /// in one frame, freezing the game and killing the player in fast-forward
        /// through hazards they never saw.
        /// </summary>
        private const int MaxTicksPerFrame = 5;

        private readonly List<byte> _pending = new List<byte>(4);
        private readonly List<Sim.InputEvent> _trace = new List<Sim.InputEvent>(256);
        private double _accumulator;
        private bool _paused;

        /// <summary>Every input issued this run, for the server to replay.</summary>
        public IReadOnlyList<Sim.InputEvent> Trace => _trace;

        public void StartRun(string seed)
        {
            State = Sim.CreateState(seed);
            PrevRow = State.Row;
            PrevColSub = State.ColSub;
            _trace.Clear();
            _pending.Clear();
            _accumulator = 0;
            _paused = false;
        }

        public void SetPaused(bool paused)
        {
            _paused = paused;
            // Drop accumulated time: on resume, catching up on the time spent in
            // the background would run the player through hazards while the screen
            // was off.
            if (!paused) _accumulator = 0;
        }

        /// <summary>
        /// Queue an input for the next tick.
        ///
        /// Recorded into the trace even when the simulation will refuse it. The
        /// server replays every input the client claims to have made and applies
        /// the same cooldown, so omitting refused inputs here would desynchronise
        /// the two.
        /// </summary>
        public void Enqueue(byte action)
        {
            if (!IsRunning) return;
            _pending.Add(action);
        }

        private void Update()
        {
            if (!IsRunning || _paused) return;

            _accumulator += Time.unscaledDeltaTime;

            int ticksThisFrame = 0;
            while (_accumulator >= TickSeconds && ticksThisFrame < MaxTicksPerFrame)
            {
                _accumulator -= TickSeconds;
                ticksThisFrame++;
                if (!AdvanceOneTick()) return; // run ended
            }

            if (ticksThisFrame >= MaxTicksPerFrame)
            {
                // We are behind and cannot catch up this frame. Drop the debt
                // rather than carrying it: accumulating it would make the next
                // frames worse and spiral.
                _accumulator = 0;
            }
        }

        /// <summary>Returns false if the run ended on this tick.</summary>
        private bool AdvanceOneTick()
        {
            PrevRow = State.Row;
            PrevColSub = State.ColSub;

            int tick = State.Tick;
            int rowBefore = State.Row;
            int colBefore = State.ColSub;
            int furthestBefore = State.FurthestRow;

            for (int i = 0; i < _pending.Count; i++)
            {
                _trace.Add(new Sim.InputEvent(tick, _pending[i]));
            }

            var reason = Sim.Step(State, _pending);
            byte firstAction = _pending.Count > 0 ? _pending[0] : (byte)0;
            _pending.Clear();

            if (State.FurthestRow > furthestBefore)
            {
                ScoreChanged?.Invoke(State.FurthestRow);
            }

            if (reason == null && firstAction != 0)
            {
                bool moved = State.Row != rowBefore || State.ColSub != colBefore;
                if (moved) Hopped?.Invoke(firstAction);
                else if (firstAction != Sim.ActCashOut) Blocked?.Invoke();
            }

            Ticked?.Invoke(State);

            if (reason != null)
            {
                RunEnded?.Invoke(reason);
                return false;
            }
            return true;
        }

        /// <summary>The trace to submit, base64-packed.</summary>
        public string EncodedTrace() => Sim.EncodeTrace(_trace);
    }
}
