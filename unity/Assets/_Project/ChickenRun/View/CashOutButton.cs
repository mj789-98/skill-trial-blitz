using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Hold to bank your score.
    ///
    /// ── Why a hold and not a tap ─────────────────────────────────────────────
    ///
    /// This is the most consequential control in the app. A misfire ends the run
    /// and banks whatever the player had at that instant — a stray tap at score 3
    /// costs them the 30 they were going for, in real money. A tap is far too
    /// cheap for that. The hold makes it unambiguously deliberate, and the ring
    /// gives the player the whole duration to change their mind.
    ///
    /// 700ms is the compromise: long enough that nothing accidental completes it,
    /// short enough that it does not feel unresponsive when the player is under
    /// pressure and wants out NOW.
    ///
    /// ── The edge case that is deliberately left in ───────────────────────────
    ///
    /// Holding does not advance you, so the idle kill line keeps closing while
    /// the ring fills. A player who dithers can die in the act of banking and
    /// lose everything.
    ///
    /// That is intentional, not an oversight. Pausing the idle line during a hold
    /// would hand out a free 700ms of standing still on demand, and banking is
    /// supposed to be a decision with a cost. It is recorded in DECISIONS.md,
    /// because the brief never mentions the interaction and it is exactly the kind
    /// of edge case worth surfacing.
    /// </summary>
    public class CashOutButton : MonoBehaviour, IPointerDownHandler, IPointerUpHandler
    {
        [SerializeField] private ChickenRunSession session;
        [SerializeField] private ChickenRunGame game;
        [SerializeField] private ChickenRunInput input;

        /// <summary>The ring that fills clockwise while held.</summary>
        [SerializeField] private Image progressRing;

        /// <summary>The egg itself, scaled slightly while held for feedback.</summary>
        [SerializeField] private RectTransform egg;

        [SerializeField] private float holdSeconds = 0.7f;

        private float _heldFor;
        private bool _holding;
        private bool _fired;

        private void Update()
        {
            // A run that ends underneath a held finger must not then fire.
            if (_holding && (game == null || !game.IsRunning)) Cancel();

            if (_holding && !_fired)
            {
                _heldFor += Time.unscaledDeltaTime;

                if (_heldFor >= holdSeconds)
                {
                    _fired = true;
                    // Appends ACT_CASH_OUT to the input trace. The button does not
                    // decide anything about money — the server replays the trace,
                    // sees the cash-out, and pays on the locked curve.
                    session?.RequestCashOut();
                }
            }
            else if (!_holding && _heldFor > 0f)
            {
                // Unwind faster than it filled, so an abandoned hold clears
                // promptly rather than lingering as a half-full ring.
                _heldFor = Mathf.Max(0f, _heldFor - Time.unscaledDeltaTime * 2.5f);
            }

            Render();
        }

        private void Render()
        {
            float t = Mathf.Clamp01(_heldFor / holdSeconds);

            if (progressRing != null) progressRing.fillAmount = t;

            if (egg != null)
            {
                // Press in slightly, then a small pop at completion. Without the
                // pop the ring simply stops and it is unclear whether it fired.
                float squeeze = Mathf.Lerp(1f, 0.9f, t);
                float pop = _fired ? 1.12f : 1f;
                egg.localScale = Vector3.one * squeeze * pop;
            }
        }

        public void OnPointerDown(PointerEventData eventData)
        {
            if (game == null || !game.IsRunning) return;

            _holding = true;
            _fired = false;

            // The same press would otherwise be read by the gesture handler as a
            // tap when released, hopping the chicken forward at the exact moment
            // it is trying to stop.
            if (input != null) input.SuppressNextGesture = true;
        }

        public void OnPointerUp(PointerEventData eventData) => Cancel();

        private void Cancel()
        {
            _holding = false;
            if (!_fired && egg != null) egg.localScale = Vector3.one;
        }

        /// <summary>Reset between runs.</summary>
        public void ResetButton()
        {
            _holding = false;
            _fired = false;
            _heldFor = 0f;
            Render();
        }
    }
}
