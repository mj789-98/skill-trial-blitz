using System;
using UnityEngine;
using SkillApp.Bridge;
using SkillApp.PopShot.Simulation;
using SkillApp.PopShot.View;

namespace SkillApp.PopShot
{
    /// <summary>
    /// The Pop Shot half of the bridge contract.
    ///
    /// Mirrors ChickenRunSession: it turns GameHost's calls into a round, reports
    /// progress upward on a heartbeat, and reports exactly one ROUND_END. It does
    /// not know that money exists, and it never will — the round it is handed
    /// carries a seed and an opaque round id, and nothing else.
    ///
    /// ── Why the heartbeat matters more here ──────────────────────────────────
    ///
    /// Chicken Run's score is the furthest row and only counts if you cash out,
    /// so an interrupted round is usually worth nothing anyway. Pop Shot banks
    /// points as they are scored, so an interrupted round genuinely has value —
    /// which makes the acknowledged heartbeat the number the sweeper settles on,
    /// and makes reporting it promptly a matter of the player's money rather than
    /// of tidiness. It is therefore sent on every score, not only on the timer.
    /// </summary>
    public class PopShotSession : MonoBehaviour, IGameSession
    {
        [SerializeField] private PopShotGame game;
        [SerializeField] private PopShotHud hud;
        [SerializeField] private PopShotFeedback feedback;

        /// <summary>Play a round on load when there is no host, so the editor works.</summary>
        [SerializeField] private bool autoplayWithoutHost = true;

        /// <summary>How often progress is reported upward, in seconds.</summary>
        [SerializeField] private float heartbeatSeconds = 1f;

        private string _roundId;
        private float _lastHeartbeat;
        private int _lastReportedScore = -1;
        private bool _hostSpoke;
        private bool _ended;

        private void OnEnable()
        {
            if (game == null) return;
            game.RunEnded += OnRunEnded;
            game.Scored += OnScored;
        }

        private void OnDisable()
        {
            if (game == null) return;
            game.RunEnded -= OnRunEnded;
            game.Scored -= OnScored;
        }

        private void Start()
        {
            if (autoplayWithoutHost)
            {
                Invoke(nameof(AutoplayIfSilent), 0.35f);
            }
        }

        private void AutoplayIfSilent()
        {
            if (_hostSpoke || (game != null && game.IsRunning)) return;
            var seed = (uint)UnityEngine.Random.Range(1, int.MaxValue);
            Debug.Log($"[popshot] no host; autoplaying seed {seed}");
            Begin(seed.ToString(), null);
        }

        // ── IGameSession ─────────────────────────────────────────────────────

        public void BeginRound(string seed, string roundId)
        {
            _hostSpoke = true;
            Begin(seed, roundId);
        }

        public void AbortRound()
        {
            if (game != null && game.IsRunning) ReportEnd(Sim.EndAborted);
        }

        public void ConfigureFeedback(bool sound, bool haptics)
        {
            feedback?.Configure(sound, haptics);
        }

        // ── Round lifecycle ──────────────────────────────────────────────────

        private void Begin(string seed, string roundId)
        {
            _roundId = roundId;
            _lastReportedScore = -1;
            _lastHeartbeat = Time.unscaledTime;
            _ended = false;

            feedback?.ResetForRun();
            hud?.ResetHud();
            game.StartRun(seed);
        }

        private void OnScored(bool swish)
        {
            // Immediately, not on the next timer tick. These points are banked,
            // so the server should know about them as soon as possible — that is
            // what an interrupted round would be settled at.
            Heartbeat(force: true);
        }

        private void Update()
        {
            if (game == null || !game.IsRunning) return;
            if (Time.unscaledTime - _lastHeartbeat < heartbeatSeconds) return;
            Heartbeat(force: false);
        }

        private void Heartbeat(bool force)
        {
            if (game == null || game.State == null) return;

            int score = Sim.ScoreFor(game.State);
            if (!force && score == _lastReportedScore) return;

            _lastHeartbeat = Time.unscaledTime;
            _lastReportedScore = score;
            RNBridge.SendScoreTick(score, game.State.Tick);
        }

        private void OnRunEnded(string reason) => ReportEnd(reason);

        private void ReportEnd(string reason)
        {
            // Exactly one terminal message per round. A duplicate here becomes a
            // duplicate submit upstream.
            if (_ended) return;
            _ended = true;

            var state = game.State;
            int score = state != null ? Sim.ScoreFor(state) : 0;
            int tick = state != null ? state.Tick : 0;
            string trace = Sim.EncodeTrace(ToArray(game.Trace));

            hud?.ShowFinal(score, reason);
            RNBridge.SendRoundEnd(reason, score, tick, trace);
        }

        private static System.Collections.Generic.List<Sim.InputEvent> ToArray(
            System.Collections.Generic.IReadOnlyList<Sim.InputEvent> src)
        {
            var list = new System.Collections.Generic.List<Sim.InputEvent>(src.Count);
            for (int i = 0; i < src.Count; i++) list.Add(src[i]);
            return list;
        }
    }
}
