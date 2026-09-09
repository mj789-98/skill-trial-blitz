using UnityEngine;
using SkillApp.PopShot.Simulation;

namespace SkillApp.PopShot
{
    /// <summary>
    /// Tap anywhere to lift the ball.
    ///
    /// One action, so there is no gesture to classify — which means, unlike
    /// Chicken Run, the input can be committed on PRESS rather than on release.
    /// That is worth doing: the whole skill in this game is when you tap, and
    /// waiting for the finger to lift adds a variable delay between deciding and
    /// acting. On Chicken Run a tap has to be distinguished from a swipe, so the
    /// same trick is not available there.
    /// </summary>
    public class PopShotInput : MonoBehaviour
    {
        [SerializeField] private PopShotGame game;

        /// <summary>Set by UI that has already consumed this press.</summary>
        public bool SuppressNextGesture { get; set; }

        private void Update()
        {
            if (game == null || !game.IsRunning) return;

            if (Input.touchCount > 0)
            {
                for (int i = 0; i < Input.touchCount; i++)
                {
                    if (Input.GetTouch(i).phase == TouchPhase.Began) Fire();
                }
                return;
            }

            // Editor and desktop, so the game is playable without a device.
            if (Input.GetMouseButtonDown(0)) Fire();
        }

        private void Fire()
        {
            if (SuppressNextGesture)
            {
                SuppressNextGesture = false;
                return;
            }
            game.Enqueue(Sim.ActTap);
        }
    }
}
