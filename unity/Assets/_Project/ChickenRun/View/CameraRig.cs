using UnityEngine;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// The isometric follow camera.
    ///
    /// ── Why orthographic ─────────────────────────────────────────────────────
    ///
    /// Matched to the reference recordings: an orthographic projection yawed off
    /// axis and pitched down, so lanes run as diagonals across a portrait screen.
    /// Orthographic is not just a look — with no perspective divide, a car twelve
    /// rows away is exactly as readable as one directly ahead, which is what lets
    /// a player plan several hops in advance. A perspective camera would compress
    /// the far field into mush and make the same deaths feel unfair.
    ///
    /// ── Why it never scrolls backward ────────────────────────────────────────
    ///
    /// The camera tracks the FURTHEST row reached, not the chicken's current row.
    /// Retreating to dodge a car is a legitimate and frequent move; if the camera
    /// followed it, the whole screen would lurch backwards every time the player
    /// dodged, which reads as the game losing its place. It also matches the score
    /// rule: score is furthest row reached, so the camera and the score agree
    /// about what "progress" means.
    ///
    /// ── Why the smoothing is asymmetric ──────────────────────────────────────
    ///
    /// Catching up to a player who is sprinting must be quick or they outrun the
    /// frame. Settling when they stop must be slow or the camera visibly snaps.
    /// One spring constant cannot do both, so there are two.
    /// </summary>
    public class CameraRig : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;
        [SerializeField] private new Camera camera;

        [Header("Framing")]
        /// Yaw and pitch taken from the reference recordings: lanes read as
        /// diagonals from lower-left to upper-right.
        [SerializeField] private float yaw = 35f;
        [SerializeField] private float pitch = 52f;

        /// <summary>
        /// How much wider than the board itself the view is, as a multiple.
        ///
        /// This replaces a hard-coded 11.5 world units, which was wrong in a way
        /// that only shows up next to the reference footage: the board is YAWED,
        /// so its nine columns occupy 9*cos(35 degrees) = 7.4 units of screen
        /// width, not 9. Framing for 11.5 therefore left 56% margin — the whole
        /// game was drawn at two thirds the size it should have been, and every
        /// object in it read as small and far away.
        ///
        /// Derived from the yaw below rather than restated, so changing the
        /// camera angle cannot silently un-frame the board again.
        /// </summary>
        [SerializeField] private float edgeMargin = 1.17f;

        /// <summary>
        /// How far ahead of the chicken the camera sits. Biased forward because
        /// the player needs to see what is coming far more than what they left.
        /// </summary>
        [SerializeField] private float lookAheadRows = 2.6f;

        [Header("Follow")]
        /// Time to close most of the gap when advancing. Short: the camera must
        /// not lag a sprinting player.
        [SerializeField] private float catchUpTime = 0.16f;

        /// Time to settle once the player stops. Longer, so the camera eases in
        /// rather than snapping to a halt.
        [SerializeField] private float settleTime = 0.42f;

        private float _followRow;
        private float _velocity;
        private bool _initialised;

        private void Reset()
        {
            game = FindFirstObjectByType<ChickenRunGame>();
            camera = GetComponent<Camera>();
        }

        private void Awake()
        {
            if (camera == null) camera = GetComponent<Camera>();
            ApplyProjection();
        }

        private void ApplyProjection()
        {
            if (camera == null) return;

            camera.orthographic = true;
            transform.rotation = Quaternion.Euler(pitch, yaw, 0f);

            // Portrait: width is the tight dimension, so size (which is half the
            // HEIGHT) has to be derived from the columns that must fit across.
            //
            // A yawed board is narrower on screen than it is wide in world
            // units, and that projection is the whole reason this is not just
            // Sim.Cols.
            float aspect = camera.aspect > 0.01f ? camera.aspect : 0.5f;
            float boardWidth = Sim.Cols * Mathf.Cos(yaw * Mathf.Deg2Rad);
            camera.orthographicSize = boardWidth * edgeMargin * 0.5f / aspect;
        }

        private void LateUpdate()
        {
            if (game == null || game.State == null || camera == null) return;

            // Re-derive on any resolution change: rotating the device or the
            // React Native view resizing must not crop columns out of play.
            ApplyProjection();

            // Track the furthest row, not the current one. See the class note.
            float target = game.State.FurthestRow + lookAheadRows;

            if (!_initialised)
            {
                _followRow = target;
                _initialised = true;
            }

            // Asymmetric: quick to catch up, slow to settle.
            float smoothing = target > _followRow ? catchUpTime : settleTime;
            _followRow = Mathf.SmoothDamp(
                _followRow, target, ref _velocity, smoothing, Mathf.Infinity,
                // unscaledDeltaTime so a slow-motion or paused effect later cannot
                // desynchronise the camera from the fixed-step simulation.
                Time.unscaledDeltaTime);

            // Monotonic by construction. FurthestRow never decreases, but clamping
            // here too means a smoothing overshoot can never walk the camera back.
            float focusRow = Mathf.Max(_followRow, target - lookAheadRows);

            var focus = new Vector3((Sim.Cols - 1) * 0.5f, 0f, focusRow);
            // Pull straight back along the camera's own forward axis, so yaw and
            // pitch can be retuned without recomputing an offset by hand.
            transform.position = focus - transform.forward * 40f;
        }

        /// <summary>
        /// Snap to the run's starting position with no easing.
        ///
        /// Called on StartRun: without it the camera would visibly fly in from
        /// wherever the previous run ended, which is the first thing a player sees
        /// after paying an entry fee.
        /// </summary>
        public void SnapToStart()
        {
            _initialised = false;
            _velocity = 0f;
        }
    }
}
