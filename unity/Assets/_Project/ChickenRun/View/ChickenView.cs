using UnityEngine;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Renders the chicken.
    ///
    /// The simulation moves it in whole cells, 50 times a second, with no notion
    /// of an arc or an animation. Everything that makes a hop feel like a hop
    /// happens here, on top of that, and none of it is ever read back.
    ///
    /// ── The hop ──────────────────────────────────────────────────────────────
    ///
    /// Three separate curves, because they peak at different moments and that
    /// mismatch is most of the character:
    ///
    ///   * Horizontal position eases out — fast off the mark, settling into the
    ///     landing. A linear slide reads as gliding, not jumping.
    ///   * Height is a parabola, peaking at the halfway point.
    ///   * Squash and stretch peaks EARLY, on the launch, and recovers before the
    ///     landing. Peaking with the height would look like a balloon inflating.
    ///
    /// ── Why it interpolates instead of snapping ──────────────────────────────
    ///
    /// At 50Hz a hop lands instantly and would look like teleporting on a 120Hz
    /// screen. The renderer reads the previous and current tick positions and
    /// draws between them using the driver's sub-tick alpha, so 50Hz logic reads
    /// as continuous motion. The hop animation is deliberately allowed to run
    /// slightly longer than one tick — a real hop arcs over several frames — which
    /// is safe precisely because nothing here feeds back into the simulation.
    /// </summary>
    public class ChickenView : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;
        [SerializeField] private Transform body;

        [Header("Hop")]
        /// <summary>
        /// Duration of the visual arc. Longer than a single tick (20ms) on
        /// purpose: this is animation time, not simulation time.
        /// </summary>
        [SerializeField] private float hopSeconds = 0.14f;
        [SerializeField] private float hopHeight = 0.42f;

        [Header("Squash and stretch")]
        [SerializeField] private float launchStretch = 0.28f;
        [SerializeField] private float landSquash = 0.22f;

        [Header("Facing")]
        /// Time to turn towards the direction of travel. Fast, but not instant —
        /// an instant snap loses the sense of a body with weight.
        [SerializeField] private float turnTime = 0.07f;

        private float _hopStartedAt = -999f;
        private float _facingYaw;
        private float _facingVelocity;
        private float _deathTimer = -1f;

        private void Reset()
        {
            game = FindFirstObjectByType<ChickenRunGame>();
            body = transform;
        }

        private void OnEnable()
        {
            if (game == null) return;
            game.Hopped += OnHopped;
            game.Blocked += OnBlocked;
            game.RunEnded += OnRunEnded;
        }

        private void OnDisable()
        {
            if (game == null) return;
            game.Hopped -= OnHopped;
            game.Blocked -= OnBlocked;
            game.RunEnded -= OnRunEnded;
        }

        private void OnHopped(byte action)
        {
            _hopStartedAt = Time.unscaledTime;

            switch (action)
            {
                case Sim.ActForward: _facingYaw = 0f; break;
                case Sim.ActBack: _facingYaw = 180f; break;
                case Sim.ActLeft: _facingYaw = -90f; break;
                case Sim.ActRight: _facingYaw = 90f; break;
            }
        }

        /// <summary>
        /// A refused hop still gets a nudge.
        ///
        /// Without it, tapping into a tree produces nothing at all and reads as
        /// dropped input — the player blames the game rather than the tree. A
        /// small bump makes the refusal legible as a refusal.
        /// </summary>
        private void OnBlocked()
        {
            _hopStartedAt = Time.unscaledTime - hopSeconds * 0.55f;
        }

        private void OnRunEnded(string reason) => _deathTimer = 0f;

        private void LateUpdate()
        {
            if (game == null || game.State == null || body == null) return;

            var state = game.State;

            // Interpolate between the last two tick positions. This is the whole
            // reason 50Hz logic can look smooth at any refresh rate.
            float alpha = game.TickAlpha;
            float prevX = game.PrevColSub / (float)Sim.Sub;
            float currX = state.ColSub / (float)Sim.Sub;
            float prevZ = game.PrevRow;
            float currZ = state.Row;

            float t = Mathf.Clamp01((Time.unscaledTime - _hopStartedAt) / hopSeconds);
            bool hopping = t < 1f;

            // Position eases out; a linear slide reads as gliding rather than
            // jumping. Between ticks with no hop in flight, fall back to the
            // driver's alpha so a log carrying the chicken still moves smoothly.
            float ease = hopping ? 1f - Mathf.Pow(1f - t, 3f) : alpha;
            float x = Mathf.Lerp(prevX, currX, ease);
            float z = Mathf.Lerp(prevZ, currZ, ease);

            // Height is a parabola peaking mid-hop.
            float height = hopping ? Mathf.Sin(t * Mathf.PI) * hopHeight : 0f;

            body.position = new Vector3(x, height + 0.35f, z);

            ApplySquash(t, hopping);
            ApplyFacing();
            ApplyDeath(state);
        }

        private void ApplySquash(float t, bool hopping)
        {
            float scaleY = 1f;
            float scaleXZ = 1f;

            if (hopping)
            {
                // Stretch peaks early on the launch and is gone by the apex;
                // squash comes back on the landing. Peaking with the height would
                // read as inflation rather than effort.
                float launch = Mathf.Clamp01(1f - t * 3f);
                float land = Mathf.Clamp01((t - 0.72f) / 0.28f);

                scaleY = 1f + launchStretch * launch - landSquash * land;
                // Preserve volume, which is what sells it as a body rather than a
                // sprite being scaled.
                scaleXZ = 1f / Mathf.Sqrt(Mathf.Max(scaleY, 0.01f));
            }

            body.localScale = new Vector3(scaleXZ, scaleY, scaleXZ) * 0.62f;
        }

        private void ApplyFacing()
        {
            float current = body.eulerAngles.y;
            float next = Mathf.SmoothDampAngle(
                current, _facingYaw, ref _facingVelocity, turnTime, Mathf.Infinity,
                Time.unscaledDeltaTime);
            body.rotation = Quaternion.Euler(0f, next, 0f);
        }

        /// <summary>
        /// Death reads differently depending on how it happened, because the
        /// player needs to know WHY they died to feel it was fair.
        /// </summary>
        private void ApplyDeath(Sim.State state)
        {
            if (state.Reason == null || state.Reason == Sim.EndCashOut) return;
            if (_deathTimer < 0f) return;

            _deathTimer += Time.unscaledDeltaTime;
            float d = Mathf.Clamp01(_deathTimer / 0.45f);

            if (state.Reason == Sim.EndDeath &&
                Sim.RowTypeAt(state.Seed, state.Row) == Sim.RowRiver)
            {
                // Drowning: sink and shrink.
                body.position += Vector3.down * (d * 0.9f * Time.unscaledDeltaTime * 4f);
                body.localScale = Vector3.one * 0.62f * (1f - d * 0.5f);
            }
            else if (state.Reason == Sim.EndDeath)
            {
                // Flattened by a vehicle or a train.
                body.localScale = new Vector3(1.5f, 0.12f, 1.5f) * 0.62f;
            }
            else
            {
                // Caught by the idle line: sink into shadow rather than splat, so
                // it is visibly a different failure from being hit.
                body.localScale = Vector3.one * 0.62f * (1f - d * 0.8f);
            }
        }

        /// <summary>Reset for a fresh run.</summary>
        public void ResetView()
        {
            _hopStartedAt = -999f;
            _facingYaw = 0f;
            _facingVelocity = 0f;
            _deathTimer = -1f;
            if (body != null) body.localScale = Vector3.one * 0.62f;
        }
    }
}
