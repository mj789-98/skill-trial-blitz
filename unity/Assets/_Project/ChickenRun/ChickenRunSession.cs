using System;
using UnityEngine;
using SkillApp.Bridge;
using SkillApp.ChickenRun.Audio;
using SkillApp.ChickenRun.Simulation;
using SkillApp.ChickenRun.View;

namespace SkillApp.ChickenRun
{
    /// <summary>
    /// Ties the React Native bridge to a run of Chicken Run.
    ///
    /// This is the only class that knows about both, and it is deliberately thin:
    /// it starts a run when told to, reports progress, and reports the end. It
    /// makes no decisions about money and never validates its own score — the
    /// server does that by replaying the trace.
    ///
    /// ── Editor autoplay ──────────────────────────────────────────────────────
    ///
    /// With no host attached, it starts a run on its own with a random seed. That
    /// is what makes the game playable by pressing Play in the editor, which is
    /// where the feel actually gets tuned. It never happens in a build with a
    /// host, because the host sends START_ROUND first.
    /// </summary>
    public class ChickenRunSession : MonoBehaviour, IGameSession
    {
        [SerializeField] private ChickenRunGame game;
        [SerializeField] private WorldView world;
        [SerializeField] private ChickenView chicken;
        [SerializeField] private CameraRig cameraRig;
        [SerializeField] private ChickenRunHud hud;
        [SerializeField] private CashOutButton cashOut;
        [SerializeField] private RunEndOverlay runEnd;
        [SerializeField] private GameFeedback feedback;

        /// <summary>
        /// Start a run automatically when nothing tells us to. Editor and
        /// standalone only — a hosted build waits for START_ROUND.
        /// </summary>
        [SerializeField] private bool autoplayWithoutHost = true;

        /// <summary>
        /// How often progress is reported upward, in seconds. Once a second is
        /// enough for the server to have a recent acknowledged score to settle an
        /// interrupted round at, without a message per tick.
        /// </summary>
        [SerializeField] private float heartbeatSeconds = 1f;

        private string _roundId;
        private float _lastHeartbeat;
        private int _lastReportedScore = -1;
        private bool _hostSpoke;

        private void OnEnable()
        {
            if (game != null)
            {
                game.RunEnded += OnRunEnded;
                game.ScoreChanged += OnScoreChanged;
            }
        }

        private void OnDisable()
        {
            if (game != null)
            {
                game.RunEnded -= OnRunEnded;
                game.ScoreChanged -= OnScoreChanged;
            }
        }

        private void Start()
        {
            // READY is sent by GameHost, which is the thing that is always awake.
            // A session can be switched off between rounds and must not be the
            // component responsible for the handshake.
            if (autoplayWithoutHost)
            {
                // Give the host a moment to speak first; only autoplay if it does
                // not. Starting immediately would race a real START_ROUND and the
                // player would briefly play the wrong world.
                Invoke(nameof(AutoplayIfSilent), 0.35f);
            }
        }

        private void AutoplayIfSilent()
        {
            if (_hostSpoke || (game != null && game.IsRunning)) return;

            // A random seed locally. In a real round this comes from the server,
            // so a player cannot roll for a favourable world.
            var seed = (uint)UnityEngine.Random.Range(1, int.MaxValue);
            Debug.Log($"[session] no host; autoplaying seed {seed}");
            BeginRun(seed.ToString(), roundId: null);
        }

        // ── IGameSession ─────────────────────────────────────────────────

        /// <summary>Start a round with a server-issued seed. Called by GameHost.</summary>
        public void BeginRound(string seed, string roundId)
        {
            // Being called at all means React Native is driving. The run-end
            // overlay uses this to decide whether to offer its own restart
            // button, which under a host would be a second, conflicting way to
            // start a round.
            _hostSpoke = true;
            BeginRun(seed, roundId);
        }

        /// <summary>
        /// The host is tearing the round down. Report where we got to so the
        /// round can be settled rather than left hanging with the player's stake
        /// already debited.
        /// </summary>
        public void AbortRound()
        {
            if (game != null && game.IsRunning) ReportEnd(Sim.EndAborted);
        }

        /// <summary>The player's sound and haptics preferences, from the host.</summary>
        public void ConfigureFeedback(bool sound, bool haptics)
        {
            feedback?.Configure(sound, haptics);
        }

        private void BeginRun(string seed, string roundId)
        {
            _roundId = roundId;
            _lastReportedScore = -1;
            _lastHeartbeat = Time.unscaledTime;

            chicken?.ResetView();
            cameraRig?.SnapToStart();
            // Clears the rising hop ladder. Without this a new run would open at
            // whatever pitch the last one ended on, which reads as the streak
            // having carried over when it has not.
            feedback?.ResetForRun();
            cashOut?.ResetButton();
            runEnd?.Hide();
            // Under a host, React Native drives what happens after a run; standalone,
            // the overlay offers its own restart.
            if (runEnd != null) runEnd.HasHost = _hostSpoke;
            // Practice until the host sends Blitz terms. A round must never show
            // money it has not been given by the server.
            hud?.ShowPractice();
            game.StartRun(seed);
        }

        private void OnScoreChanged(int score)
        {
            // Report immediately on the first point of a run: it confirms to the
            // server that the round genuinely started, which matters for deciding
            // what an interrupted round settles at.
            if (_lastReportedScore < 0) SendHeartbeat(score);
        }

        private void Update()
        {
            if (game == null || !game.IsRunning) return;

            if (Time.unscaledTime - _lastHeartbeat >= heartbeatSeconds)
            {
                SendHeartbeat(game.State.FurthestRow);
            }
        }

        private void SendHeartbeat(int score)
        {
            _lastHeartbeat = Time.unscaledTime;
            // Monotonic: never report a score lower than the last one sent. The
            // server also enforces this, but sending a regression would look like
            // a tampering attempt from an honest client.
            if (score <= _lastReportedScore) return;
            _lastReportedScore = score;
            RNBridge.SendScoreTick(score, game.State.Tick);
        }

        private void OnRunEnded(string reason) => ReportEnd(reason);

        private void ReportEnd(string reason)
        {
            var state = game.State;
            // The score the client believes it earned. Carried for comparison
            // only — the server recomputes it from the trace and pays on that.
            int score = reason == Sim.EndCashOut ? state.FurthestRow : 0;

            RNBridge.SendRoundEnd(reason, score, state.Tick, game.EncodedTrace());
            Debug.Log(
                $"[session] round {_roundId ?? "(local)"} ended: {reason}, " +
                $"score {score}, {state.Tick} ticks, {game.Trace.Count} inputs");
        }

        /// <summary>Bank the current run. Called by the Cash Out control.</summary>
        public void RequestCashOut()
        {
            if (game != null && game.IsRunning) game.Enqueue(Sim.ActCashOut);
        }
    }
}
