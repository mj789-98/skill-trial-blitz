using UnityEngine;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun
{
    /// <summary>
    /// Touch input: tap to hop forward, swipe to hop left, right or back.
    ///
    /// ── Why this reads raw touches every frame ───────────────────────────────
    ///
    /// Input is sampled in Update, not at tick boundaries, and handed to the game
    /// immediately. At 50Hz a tick is 20ms; sampling on the tick would discard up
    /// to a full tick of input and would silently merge two quick taps into one.
    /// This game is played in rhythm, so that would be felt directly.
    ///
    /// ── The tap/swipe split ──────────────────────────────────────────────────
    ///
    /// A gesture is classified on RELEASE, not on movement, so a slightly sloppy
    /// tap does not turn into a swipe halfway through and send the chicken
    /// sideways into traffic. The distance threshold is in inches rather than
    /// pixels, because a 15px slop is nothing on a 480dpi phone and enormous on a
    /// 160dpi tablet.
    /// </summary>
    public class ChickenRunInput : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;

        /// <summary>
        /// Minimum travel to count as a swipe, in inches of physical screen.
        /// Roughly a third of a fingertip: far enough that a tap will not trip it,
        /// close enough that a deliberate flick always does.
        /// </summary>
        [SerializeField] private float swipeInches = 0.12f;

        /// <summary>
        /// Above this, a gesture is a swipe regardless of how far it travelled —
        /// a fast flick that barely moves is still unambiguously a swipe.
        /// </summary>
        [SerializeField] private float flickInchesPerSecond = 1.2f;

        /// <summary>
        /// A held press this long is not a tap. Stops the Cash Out hold, which
        /// starts as a press somewhere on screen, from also firing a hop.
        /// </summary>
        [SerializeField] private float maxTapSeconds = 0.35f;

        private bool _tracking;
        private Vector2 _startPos;
        private float _startTime;
        private bool _consumed;

        /// <summary>
        /// Set while the player is holding Cash Out, so the same press does not
        /// also register as a hop when released.
        /// </summary>
        public bool SuppressNextGesture { get; set; }

        private float Dpi => Screen.dpi > 1f ? Screen.dpi : 160f;

        private void Reset() => game = GetComponent<ChickenRunGame>();

        private void Update()
        {
            if (game == null || !game.IsRunning) return;

            // Unity's touch API is used directly rather than the Input System
            // package: this is two gestures on one surface, and the extra
            // dependency would buy nothing.
            if (Input.touchCount > 0)
            {
                var touch = Input.GetTouch(0);
                switch (touch.phase)
                {
                    case TouchPhase.Began:
                        Begin(touch.position);
                        break;
                    case TouchPhase.Ended:
                    case TouchPhase.Canceled:
                        End(touch.position);
                        break;
                }
                return;
            }

            // Mouse fallback so the game is playable in the editor, which is where
            // the feel actually gets tuned.
            if (Input.GetMouseButtonDown(0)) Begin(Input.mousePosition);
            else if (Input.GetMouseButtonUp(0)) End(Input.mousePosition);
        }

        private void Begin(Vector2 position)
        {
            _tracking = true;
            _consumed = false;
            _startPos = position;
            _startTime = Time.unscaledTime;
        }

        private void End(Vector2 position)
        {
            if (!_tracking) return;
            _tracking = false;

            if (_consumed) return;

            if (SuppressNextGesture)
            {
                SuppressNextGesture = false;
                return;
            }

            var delta = position - _startPos;
            float seconds = Mathf.Max(Time.unscaledTime - _startTime, 0.0001f);
            float inches = delta.magnitude / Dpi;
            float inchesPerSecond = inches / seconds;

            bool isSwipe = inches >= swipeInches || inchesPerSecond >= flickInchesPerSecond;

            if (!isSwipe)
            {
                // A long press that never moved is not a tap. It is almost always
                // a player resting a thumb, and turning it into a hop is the kind
                // of input the player will swear they did not make.
                if (seconds <= maxTapSeconds) game.Enqueue(Sim.ActForward);
                return;
            }

            // Dominant axis wins, so a diagonal resolves to whichever direction
            // the player leaned into rather than being rejected.
            if (Mathf.Abs(delta.x) > Mathf.Abs(delta.y))
            {
                game.Enqueue(delta.x > 0 ? Sim.ActRight : Sim.ActLeft);
            }
            else
            {
                game.Enqueue(delta.y > 0 ? Sim.ActForward : Sim.ActBack);
            }
        }

        /// <summary>
        /// Cancel the gesture in progress, e.g. because the Cash Out hold took it.
        /// </summary>
        public void ConsumeCurrentGesture() => _consumed = true;
    }
}
