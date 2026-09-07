using TMPro;
using UnityEngine;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// The in-game HUD: score, and in Blitz, what that score is currently worth.
    ///
    /// ── Why the payout readout exists ────────────────────────────────────────
    ///
    /// The brief says the payout screen "has to make sense to a player holding
    /// that choice" — the choice being when to cash out. A player deciding
    /// whether to risk one more row needs to know what they are risking, and a
    /// bare score does not tell them. So during a Blitz round the HUD shows the
    /// live multiplier and cash value alongside the score, and the next step up,
    /// which is what makes the decision informed rather than a guess.
    ///
    /// In practice mode none of that exists, so the HUD is just the score. The
    /// mode arrives in START_ROUND rather than being compiled in, which is the
    /// same per-game switch Blitz itself uses.
    ///
    /// ── Money display ────────────────────────────────────────────────────────
    ///
    /// Cash values arrive as integer CENTS and are formatted here for display
    /// only. Nothing in this class computes a payout — it renders numbers the
    /// server sent.
    /// </summary>
    public class ChickenRunHud : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;

        [Header("Always visible")]
        [SerializeField] private TMP_Text scoreLabel;

        [Header("Blitz only")]
        [SerializeField] private GameObject blitzPanel;
        [SerializeField] private TMP_Text multiplierLabel;
        [SerializeField] private TMP_Text payoutLabel;
        [SerializeField] private TMP_Text nextStepLabel;

        /// <summary>
        /// The locked curve for this round, as absolute score breakpoints. Sent
        /// down at round start; null in practice mode.
        /// </summary>
        private CurvePoint[] _curve;
        private int _stakeCents;
        private int _lastRenderedScore = -1;

        public struct CurvePoint
        {
            public int Score;
            public int MultBp; // basis points, 10000 = 1.00x — integers, as on the server
        }

        private void OnEnable()
        {
            if (game != null) game.ScoreChanged += OnScoreChanged;
            ShowPractice();
        }

        private void OnDisable()
        {
            if (game != null) game.ScoreChanged -= OnScoreChanged;
        }

        /// <summary>Practice: score only, no money anywhere on screen.</summary>
        public void ShowPractice()
        {
            _curve = null;
            _stakeCents = 0;
            if (blitzPanel != null) blitzPanel.SetActive(false);
            Render(0);
        }

        /// <summary>Blitz: show what the current score is worth on the locked curve.</summary>
        public void ShowBlitz(CurvePoint[] curve, int stakeCents)
        {
            _curve = curve;
            _stakeCents = stakeCents;
            if (blitzPanel != null) blitzPanel.SetActive(curve != null && curve.Length > 0);
            Render(game != null && game.State != null ? game.State.FurthestRow : 0);
        }

        private void OnScoreChanged(int score) => Render(score);

        private void Render(int score)
        {
            if (score == _lastRenderedScore) return;
            _lastRenderedScore = score;

            if (scoreLabel != null) scoreLabel.text = score.ToString();

            if (_curve == null || _curve.Length == 0) return;

            int multBp = MultiplierBpForScore(score);
            // Floor, matching the server's single rounding rule exactly. Showing a
            // rounded-up value the player then does not receive would be worse
            // than showing nothing.
            int payoutCents = (int)((long)_stakeCents * multBp / 10000L);

            if (multiplierLabel != null)
                multiplierLabel.text = $"{multBp / 10000f:0.00}x";

            if (payoutLabel != null)
                payoutLabel.text = FormatCents(payoutCents);

            if (nextStepLabel != null)
            {
                var next = NextBreakpointAbove(score);
                nextStepLabel.text = next.HasValue
                    // The whole tension of the mode in one line: what one more
                    // push is worth, and therefore what is being risked.
                    ? $"{next.Value.Score} → {next.Value.MultBp / 10000f:0.00}x"
                    : "MAX";
            }
        }

        /// <summary>
        /// Piecewise-linear lookup, mirroring functions/engine/curve.js.
        ///
        /// Duplicated here on purpose and kept in integers: this is a DISPLAY of
        /// what the server will pay, and if the two ever disagreed the player
        /// would be shown one number and paid another. Integer basis points mean
        /// the two cannot drift through float rounding.
        /// </summary>
        private int MultiplierBpForScore(int score)
        {
            if (_curve.Length == 0) return 0;
            if (score <= _curve[0].Score) return _curve[0].MultBp;

            var last = _curve[_curve.Length - 1];
            if (score >= last.Score) return last.MultBp;

            for (int i = 1; i < _curve.Length; i++)
            {
                var hi = _curve[i];
                if (score > hi.Score) continue;

                var lo = _curve[i - 1];
                int span = hi.Score - lo.Score;
                if (span <= 0) return Mathf.Max(lo.MultBp, hi.MultBp);

                int rise = hi.MultBp - lo.MultBp;
                return lo.MultBp + (rise * (score - lo.Score)) / span;
            }
            return last.MultBp;
        }

        private CurvePoint? NextBreakpointAbove(int score)
        {
            foreach (var p in _curve)
            {
                if (p.Score > score) return p;
            }
            return null;
        }

        private static string FormatCents(int cents)
        {
            return $"${cents / 100}.{cents % 100:00}";
        }
    }
}
