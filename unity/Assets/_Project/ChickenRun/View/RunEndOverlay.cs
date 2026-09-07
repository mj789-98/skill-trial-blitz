using TMPro;
using UnityEngine;
using UnityEngine.UI;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// The in-world reaction when a run ends.
    ///
    /// ── What this deliberately does NOT do ───────────────────────────────────
    ///
    /// It never displays a currency value. Not once, in any mode.
    ///
    /// The split is by concern, not by mode: Unity owns the game's reaction
    /// (gravestone, coin burst, why you died), React Native owns the result
    /// screen with the money. Neither duplicates the other, because neither does
    /// the other's job.
    ///
    /// That is not only tidiness. Anything shown here would be a CLIENT-computed
    /// figure, displayed before the server has settled the round — and the
    /// settled amount is the only one that is true. Showing a player "$4.20" and
    /// then paying them something else is the exact failure the brief calls out.
    /// So the money lives on the RN result screen, rendered from what submit
    /// returned.
    ///
    /// The reference recordings split the same way: "YOU SCORED 12" is a
    /// game-side screen, and the separate Result / Buy-in / multiplier screen is
    /// plainly native.
    ///
    /// ── Telling the player why ───────────────────────────────────────────────
    ///
    /// A death names its cause. "You died" alone invites the player to blame the
    /// game; "hit by a car" is a thing they can learn from, and a player who
    /// understands the loss is one who plays again.
    /// </summary>
    public class RunEndOverlay : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;

        [SerializeField] private CanvasGroup group;
        [SerializeField] private Image scrim;
        [SerializeField] private TMP_Text headline;
        [SerializeField] private TMP_Text detail;
        [SerializeField] private TMP_Text scoreLabel;
        [SerializeField] private TMP_Text hint;

        [Header("Feel")]
        [SerializeField] private float fadeSeconds = 0.35f;
        /// <summary>
        /// Beat before the overlay appears, so the death animation is seen rather
        /// than instantly covered. Losing is the moment the player most wants to
        /// understand.
        /// </summary>
        [SerializeField] private float deathDelay = 0.55f;
        [SerializeField] private float cashOutDelay = 0.3f;

        [Header("Colours")]
        [SerializeField] private Color winTint = new Color(1f, 0.85f, 0.25f);
        [SerializeField] private Color loseTint = new Color(1f, 0.82f, 0.20f);

        private float _shownAt = -1f;
        private float _delay;
        private bool _active;

        /// <summary>
        /// True once the overlay is up. The host uses this to know the in-world
        /// reaction has played and the result screen can take over.
        /// </summary>
        public bool IsShowing => _active && Time.unscaledTime >= _shownAt + _delay;

        private void OnEnable()
        {
            if (game != null) game.RunEnded += OnRunEnded;
            Hide();
        }

        private void OnDisable()
        {
            if (game != null) game.RunEnded -= OnRunEnded;
        }

        public void Hide()
        {
            _active = false;
            _shownAt = -1f;
            if (group != null)
            {
                group.alpha = 0f;
                group.blocksRaycasts = false;
            }
        }

        private void OnRunEnded(string reason)
        {
            var state = game.State;
            _active = true;
            _shownAt = Time.unscaledTime;
            _delay = reason == Sim.EndCashOut ? cashOutDelay : deathDelay;

            bool banked = reason == Sim.EndCashOut;

            if (headline != null)
            {
                headline.text = banked ? "YOU SCORED" : "YOU DIED";
                headline.color = banked ? winTint : loseTint;
            }

            if (scoreLabel != null)
            {
                // The SCORE, which is a game number, not a payout. What that score
                // is worth is the result screen's business.
                scoreLabel.text = (banked ? state.FurthestRow : 0).ToString();
            }

            if (detail != null) detail.text = DescribeEnding(reason, state);

            if (hint != null)
            {
                // Only meaningful when playing standalone. Under a host, React
                // Native drives what happens next.
                hint.text = "TAP TO PLAY AGAIN";
                hint.gameObject.SetActive(!HasHost);
            }
        }

        /// <summary>
        /// Explain the ending in the player's terms.
        ///
        /// The cause is derived from the row the run ended on, using the same
        /// world queries the simulation kills with — so the explanation cannot
        /// disagree with what actually happened.
        /// </summary>
        private static string DescribeEnding(string reason, Sim.State state)
        {
            if (reason == Sim.EndCashOut) return "banked and clear";
            if (reason == Sim.EndIdle) return "you stopped moving for too long";
            if (reason == Sim.EndAborted) return "run abandoned";

            switch (Sim.RowTypeAt(state.Seed, state.Row))
            {
                case Sim.RowRiver: return "you fell in the water";
                case Sim.RowRail: return "hit by a train";
                case Sim.RowRoad: return "hit by a car";
                default: return "you died";
            }
        }

        /// <summary>
        /// Whether a React Native host is driving. Set by the session; without a
        /// host the overlay offers its own restart so the game stays playable
        /// standalone, which is where feel gets tuned.
        /// </summary>
        public bool HasHost { get; set; }

        private void Update()
        {
            if (!_active || group == null) return;

            float since = Time.unscaledTime - _shownAt - _delay;
            if (since < 0f) return;

            group.alpha = Mathf.Clamp01(since / fadeSeconds);
            group.blocksRaycasts = true;

            if (scrim != null)
            {
                var c = scrim.color;
                // Dim, not black out: the board stays readable behind, so the
                // player can see the car that got them.
                c.a = Mathf.Lerp(0f, 0.62f, group.alpha);
                scrim.color = c;
            }
        }
    }
}
