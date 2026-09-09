using System;
using UnityEngine;

namespace SkillApp.Bridge
{
    /// <summary>
    /// Routes React Native's messages to whichever mini-game they are about.
    ///
    /// This is one of exactly TWO files in the codebase that enumerate games —
    /// the other is functions/sim/index.js, the validator registry. Everything
    /// else takes a gameId and does not care which game it is, and in particular
    /// nothing on the money path knows that Pop Shot exists.
    ///
    /// ── Why one scene with two roots ─────────────────────────────────────────
    ///
    /// The obvious design is a scene per game, loaded on demand. This does not do
    /// that, and the reason is the embed rather than taste.
    ///
    /// The Unity player is a process-wide singleton whose surface is extremely
    /// sensitive to being re-attached — detaching and re-attaching the view is
    /// what produced "Graphics device is null" and a SIGTRAP on a real device
    /// (see DECISIONS D-021). Scene loading is a milder version of the same
    /// class of disruption: it tears down and rebuilds the render pipeline's
    /// state mid-session, in a player that is already embedded in someone else's
    /// view hierarchy.
    ///
    /// So both games are built into one scene and the inactive one is simply
    /// switched off. Switching is a SetActive call, which is boring, instant, and
    /// cannot fail. The cost is a slightly larger scene and both games' assets
    /// resident at once — for two games made of primitives, that is nothing.
    ///
    /// ── Why the sessions do not listen to the bridge themselves ──────────────
    ///
    /// A disabled GameObject receives no events, so a game that switched itself
    /// off could never hear the message telling it to switch back on. Routing has
    /// to live somewhere that is always awake, and that is here.
    /// </summary>
    public class GameHost : MonoBehaviour
    {
        /// <summary>
        /// A game that can be hosted: its root object, and the component that
        /// knows how to start a round in it.
        /// </summary>
        [Serializable]
        public class Entry
        {
            /// <summary>Matches games.game_id in Postgres and GameId in protocol.ts.</summary>
            public string gameId;

            /// <summary>Everything belonging to this game: camera, world, HUD.</summary>
            public GameObject root;

            /// <summary>The MonoBehaviour implementing IGameSession on that root.</summary>
            public MonoBehaviour session;
        }

        [SerializeField] private Entry[] games = Array.Empty<Entry>();

        /// <summary>
        /// Which game to show when there is no host — the editor, or a desktop
        /// build. Under React Native this is overwritten by the first START_ROUND.
        /// </summary>
        [SerializeField] private string defaultGameId = "chicken_run";

        private IGameSession _active;
        private bool _hostSpoke;

        [Serializable]
        private class InboundMessage
        {
            public string type;
            public string gameId;
            public string mode;
            public string seed;
            public string roundId;
            public bool sound;
            public bool music;
            public bool haptics;
        }

        private void OnEnable() => RNBridge.MessageReceived += OnMessage;
        private void OnDisable() => RNBridge.MessageReceived -= OnMessage;

        private void Start()
        {
            // Show something rather than an empty scene while waiting for a host.
            Activate(defaultGameId);

            // Tell the host we can accept a round. If there is no host this is a
            // log line and nothing more.
            RNBridge.SendReady();
        }

        private void OnMessage(string json)
        {
            InboundMessage msg;
            try
            {
                msg = JsonUtility.FromJson<InboundMessage>(json);
            }
            catch (Exception e)
            {
                RNBridge.SendError($"malformed message: {e.Message}");
                return;
            }
            if (msg == null || string.IsNullOrEmpty(msg.type)) return;

            _hostSpoke = true;

            switch (msg.type)
            {
                case "START_ROUND":
                    if (string.IsNullOrEmpty(msg.seed))
                    {
                        RNBridge.SendError("START_ROUND without a seed");
                        return;
                    }
                    // Default rather than refuse: an unknown gameId is a client
                    // and server that disagree about what exists, and dropping
                    // the round would leave a paid entry with nothing playing it.
                    // The score still has to survive the server's replay, so a
                    // wrong game here cannot become a wrong payout.
                    if (!Activate(string.IsNullOrEmpty(msg.gameId) ? defaultGameId : msg.gameId))
                    {
                        RNBridge.SendError($"unknown gameId '{msg.gameId}'");
                        return;
                    }
                    _active?.BeginRound(msg.seed, msg.roundId);
                    break;

                case "ABORT":
                    _active?.AbortRound();
                    break;

                case "SET_AUDIO":
                    // Every game, not just the active one: the player's
                    // preference is about the app, and a game switched on later
                    // should not start at the wrong settings.
                    foreach (var g in games)
                    {
                        (g.session as IGameSession)?.ConfigureFeedback(msg.sound, msg.haptics);
                    }
                    break;
            }
        }

        /// <summary>Switch to a game. Returns false if it is not one we host.</summary>
        private bool Activate(string gameId)
        {
            Entry target = null;
            foreach (var g in games)
            {
                if (g != null && g.gameId == gameId) { target = g; break; }
            }
            if (target == null) return false;

            foreach (var g in games)
            {
                if (g?.root == null) continue;
                bool on = ReferenceEquals(g, target);
                if (g.root.activeSelf != on) g.root.SetActive(on);
            }

            _active = target.session as IGameSession;
            if (_active == null)
            {
                Debug.LogError($"[host] '{gameId}' has no IGameSession on its session field");
                return false;
            }
            return true;
        }

        /// <summary>Whether React Native has ever spoken. Read by sessions for autoplay.</summary>
        public bool HostSpoke => _hostSpoke;
    }

    /// <summary>
    /// What a mini-game has to be able to do to be hosted.
    ///
    /// Deliberately tiny. A game is asked to start a round with a server-issued
    /// seed, to stop, and to honour the player's feedback settings — and nothing
    /// else. It is never told about money, a balance, a stake or a payout curve,
    /// which is what keeps the trust boundary in the file layout rather than only
    /// in a comment.
    /// </summary>
    public interface IGameSession
    {
        void BeginRound(string seed, string roundId);
        void AbortRound();
        void ConfigureFeedback(bool sound, bool haptics);
    }
}
