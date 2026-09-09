using TMPro;
using UnityEngine;
using SkillApp.PopShot.Simulation;

namespace SkillApp.PopShot.View
{
    /// <summary>
    /// Score and shot clock.
    ///
    /// Money is NOT shown here, for the same reason it is not shown in Chicken
    /// Run: Unity renders the game's reaction, React Native renders the money.
    /// The HUD does not know what a point is worth and cannot be made to.
    ///
    /// ── The clock has three states, and they must look different ─────────────
    ///
    /// It has not started, it is running, and it has expired but the ball is
    /// still up. The third one is the buzzer window, and it is the only moment in
    /// the game where the player has to understand a rule they cannot see — so it
    /// gets its own colour and its own word rather than a number counting nothing.
    /// </summary>
    public class PopShotHud : MonoBehaviour
    {
        [SerializeField] private PopShotGame game;
        [SerializeField] private TextMeshProUGUI scoreLabel;
        [SerializeField] private TextMeshProUGUI clockLabel;
        [SerializeField] private TextMeshProUGUI hintLabel;

        private static readonly Color Idle = new Color(0.80f, 0.84f, 0.90f);
        private static readonly Color Running = Color.white;
        private static readonly Color Urgent = new Color(1f, 0.72f, 0.20f);
        private static readonly Color Buzzer = new Color(1f, 0.44f, 0.36f);

        public void ResetHud()
        {
            if (scoreLabel != null) scoreLabel.text = "0";
            if (hintLabel != null)
            {
                hintLabel.gameObject.SetActive(true);
                hintLabel.text = "tap to lift the ball";
            }
        }

        public void ShowFinal(int score, string reason)
        {
            if (scoreLabel != null) scoreLabel.text = score.ToString();
            if (clockLabel != null)
            {
                clockLabel.text = "0.0";
                clockLabel.color = Buzzer;
            }
            if (hintLabel != null)
            {
                hintLabel.gameObject.SetActive(true);
                hintLabel.text = reason == Sim.EndAborted ? "round ended" : "time";
            }
        }

        private void LateUpdate()
        {
            var state = game != null ? game.State : null;
            if (state == null) return;

            if (scoreLabel != null) scoreLabel.text = state.Points.ToString();
            if (clockLabel == null) return;

            if (!state.ClockRunning)
            {
                // The clock does not start until the first basket. Showing it
                // frozen at its full value, greyed, says that far better than a
                // number that simply is not moving.
                clockLabel.text = Seconds(Sim.StartClockTicks);
                clockLabel.color = Idle;
            }
            else if (Sim.InBuzzerWindow(state))
            {
                clockLabel.text = "BUZZER";
                clockLabel.color = Buzzer;
            }
            else
            {
                clockLabel.text = Seconds(state.ClockTicks);
                clockLabel.color = state.ClockTicks <= 3 * Sim.TickHz ? Urgent : Running;
            }

            if (hintLabel != null && hintLabel.gameObject.activeSelf && state.Baskets > 0)
            {
                // The hint has done its job the moment they score.
                hintLabel.gameObject.SetActive(false);
            }
        }

        /// <summary>Ticks to a one-decimal seconds string, without floating the sim.</summary>
        private static string Seconds(int ticks)
        {
            int tenths = ticks * 10 / Sim.TickHz;
            return $"{tenths / 10}.{tenths % 10}";
        }
    }
}
