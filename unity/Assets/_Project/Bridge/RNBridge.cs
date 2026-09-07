using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace SkillApp.Bridge
{
    /// <summary>
    /// The Unity end of the React Native bridge, and the ONLY place Unity talks
    /// to the outside world.
    ///
    /// React Native reaches this object through the Fabric command
    ///
    ///     Commands.postMessage(ref, "RNBridge", "OnMessage", json)
    ///
    /// which the native side turns into UnitySendMessage(gameObject, method,
    /// message) — so the GameObject must be named exactly
    /// <see cref="GameObjectName"/> and the handler must stay public. Both names
    /// are declared on the JS side in app/src/unity/protocol.ts; that file and
    /// this one are two halves of one contract.
    ///
    /// ── The trust boundary ───────────────────────────────────────────────────
    ///
    /// Unity holds no auth token, no API base URL, and makes no network call. It
    /// receives a server-issued seed and returns an input trace. Everything that
    /// touches a balance goes Unity → RN → Cloud Function → Postgres, and the
    /// trace is re-simulated server-side rather than trusted.
    ///
    /// So the worst a tampered Unity build can do is send a dishonest ROUND_END,
    /// and the server does not believe that message — it replays the inputs
    /// against the seed it issued and computes the score itself.
    /// </summary>
    public class RNBridge : MonoBehaviour
    {
        /// <summary>Must match UNITY_BRIDGE_OBJECT in protocol.ts.</summary>
        public const string GameObjectName = "RNBridge";

        /// <summary>
        /// Raised on the main thread for each message from React Native. The game
        /// subscribes; the bridge itself never interprets a payload.
        /// </summary>
        public static event Action<string> MessageReceived;

        private static RNBridge _instance;

        /// <summary>
        /// Created on demand rather than relying on a scene being authored
        /// correctly. A missing bridge object would otherwise fail silently and
        /// present as a hung game.
        /// </summary>
        public static RNBridge Instance
        {
            get
            {
                if (_instance != null) return _instance;

                var host = GameObject.Find(GameObjectName) ?? new GameObject(GameObjectName);
                _instance = host.GetComponent<RNBridge>() ?? host.AddComponent<RNBridge>();
                DontDestroyOnLoad(host);
                return _instance;
            }
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }

            _instance = this;
            // The bridge must outlive any scene load, or a message that arrives
            // during a transition is dropped.
            DontDestroyOnLoad(gameObject);
        }

        // ── RN → Unity ───────────────────────────────────────────────────────

        /// <summary>
        /// Entry point invoked by UnitySendMessage. The name is part of the
        /// contract (UNITY_BRIDGE_METHOD in protocol.ts) — do not rename it.
        /// </summary>
        public void OnMessage(string json)
        {
            if (string.IsNullOrEmpty(json)) return;

            try
            {
                MessageReceived?.Invoke(json);
            }
            catch (Exception e)
            {
                // A subscriber throwing must not kill the bridge: if it did, the
                // round would hang with the player's stake already debited and
                // nothing able to report an outcome. Tell the host instead, so RN
                // can abort the round and let settlement resolve it properly.
                Debug.LogException(e);
                SendError($"handler failed: {e.Message}");
            }
        }

        // ── Unity → RN ───────────────────────────────────────────────────────

#if UNITY_ANDROID && !UNITY_EDITOR
        private static void SendToHost(string message)
        {
            // Verified against the package's own Java: the static entry point is
            // ReactNativeUnityViewManager.sendMessageToMobileApp, which emits the
            // onUnityMessage event RN listens for.
            using (var cls = new AndroidJavaClass("com.azesmwayreactnativeunity.ReactNativeUnityViewManager"))
            {
                cls.CallStatic("sendMessageToMobileApp", message);
            }
        }
#elif UNITY_IOS && !UNITY_EDITOR
        [DllImport("__Internal")]
        private static extern void sendMessageToMobileApp(string message);

        private static void SendToHost(string message) => sendMessageToMobileApp(message);
#else
        /// <summary>
        /// Editor and standalone: there is no host, so log. This is what lets the
        /// game run in the editor without React Native at all, which matters
        /// because the simulation is most easily iterated on there.
        /// </summary>
        private static void SendToHost(string message)
        {
            Debug.Log($"[unity → rn] {message}");
        }
#endif

        /// <summary>Send a raw JSON payload to React Native.</summary>
        public static void Send(string json)
        {
            if (string.IsNullOrEmpty(json)) return;

            try
            {
                SendToHost(json);
            }
            catch (Exception e)
            {
                // Never let a failed send propagate into the game loop.
                Debug.LogWarning($"[unity → rn] send failed: {e.Message}");
            }
        }

        /// <summary>Report that the scene is loaded and can accept START_ROUND.</summary>
        public static void SendReady() => Send("{\"type\":\"READY\"}");

        /// <summary>
        /// Throttled progress ping. RN forwards this to the heartbeat endpoint,
        /// which is what gives an interrupted round a server-acknowledged score to
        /// settle at instead of a guess.
        /// </summary>
        public static void SendScoreTick(int score, int tick) =>
            Send($"{{\"type\":\"SCORE_TICK\",\"score\":{score},\"tick\":{tick}}}");

        /// <summary>
        /// Report the end of a run. `trace` is the base64 input trace; the score
        /// is carried for comparison only and is not what the player is paid on.
        /// </summary>
        public static void SendRoundEnd(string reason, int score, int tick, string trace) =>
            Send(
                $"{{\"type\":\"ROUND_END\",\"reason\":\"{Escape(reason)}\",\"score\":{score}," +
                $"\"tick\":{tick},\"trace\":\"{Escape(trace)}\"}}");

        public static void SendError(string message) =>
            Send($"{{\"type\":\"ERROR\",\"message\":\"{Escape(message)}\"}}");

        /// <summary>
        /// Minimal JSON string escaping.
        ///
        /// Hand-rolled because these payloads are a fixed handful of fields and
        /// pulling in a serialiser for them is not worth the dependency — but an
        /// unescaped quote or backslash in an error message would produce JSON
        /// that parseFromUnity rejects, silently losing the message that was
        /// meant to explain a failure.
        /// </summary>
        private static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;

            var sb = new System.Text.StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
