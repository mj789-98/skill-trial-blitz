using UnityEngine;

namespace SkillApp.Bridge
{
    /// <summary>
    /// Throwaway scene logic for the integration spike.
    ///
    /// Its only job is to prove the four things the embed has to do before any
    /// game code is worth writing:
    ///
    ///   1. Unity renders inside a React Native screen at all.
    ///   2. Unity → RN messages arrive (READY on start, and a tap echo).
    ///   3. RN → Unity messages arrive (OnMessage, echoed straight back).
    ///   4. Returning from background does not leave a black view.
    ///
    /// Deleted once ChickenRun replaces it. It is committed rather than scratched
    /// because the spike is the thing the whole project's schedule depended on,
    /// and being able to re-run it after a dependency bump is worth the file.
    /// </summary>
    public class SpikeBehaviour : MonoBehaviour
    {
        [SerializeField] private Transform spinner;
        [SerializeField] private float degreesPerSecond = 90f;

        private int _frames;

        private void OnEnable() => RNBridge.MessageReceived += HandleMessage;
        private void OnDisable() => RNBridge.MessageReceived -= HandleMessage;

        private void Start()
        {
            // RN waits for this before sending START_ROUND, so a missing READY
            // presents as a game that never begins.
            RNBridge.SendReady();
        }

        private void Update()
        {
            if (spinner != null)
            {
                // Frame-rate independent so the spike also shows whether the view
                // is actually being driven rather than rendering one static frame.
                spinner.Rotate(Vector3.up, degreesPerSecond * Time.deltaTime, Space.Self);
            }

            _frames++;

            // A tap anywhere echoes out, proving input reaches Unity through the
            // RN-hosted view rather than being swallowed by the host.
            if (Input.GetMouseButtonDown(0) || Input.touchCount > 0)
            {
                RNBridge.SendScoreTick(_frames, _frames);
            }
        }

        private void HandleMessage(string json)
        {
            // Deliberately unparsed: the spike is testing transport, not the
            // protocol. Echoing the raw payload makes a truncation or encoding
            // problem visible on the RN side instead of hiding it behind a parse.
            Debug.Log($"[spike] received: {json}");
            RNBridge.Send($"{{\"type\":\"ERROR\",\"message\":\"echo ok, frames={_frames}\"}}");
        }
    }
}
