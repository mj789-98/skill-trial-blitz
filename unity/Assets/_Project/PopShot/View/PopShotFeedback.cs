using UnityEngine;
using SkillApp.ChickenRun.Audio;

namespace SkillApp.PopShot.View
{
    /// <summary>
    /// Sound and haptics for Pop Shot.
    ///
    /// Reuses ProceduralAudio and Haptics rather than growing its own copies: the
    /// synthesiser is a library of shapes, and a game is a choice of which shapes
    /// mean what. Pop Shot's flap is Chicken Run's hop clip pitched down; its
    /// swish is the cash-out chord. That is not laziness — a player moving
    /// between two games in the same app should hear one instrument, not two
    /// unrelated sound sets.
    ///
    /// ── The pitch ladder is attached to something else here ──────────────────
    ///
    /// In Chicken Run the hop climbs as a run continues, so a streak is audible
    /// and losing it stings. Pop Shot has a clock rather than a streak of
    /// survival, so the flap stays flat and the ladder moves to SCORING:
    /// consecutive baskets without hitting iron walk up the scale, and a clang
    /// drops it back. Same idea, attached to the thing that is actually at stake
    /// in each game.
    /// </summary>
    public class PopShotFeedback : MonoBehaviour
    {
        [SerializeField] private PopShotGame game;

        [Header("Channels")]
        [SerializeField] private bool soundEnabled = true;
        [SerializeField] private bool hapticsEnabled = true;
        [Range(0f, 1f)]
        [SerializeField] private float volume = 0.8f;

        /// <summary>Pentatonic, as in Chicken Run. Every subset of it is consonant.</summary>
        private static readonly int[] Ladder = { 0, 2, 4, 7, 9, 12, 14, 16 };

        private AudioSource _pitched;
        private AudioSource _flat;
        private AudioClip _flap, _clang, _basket, _swish;
        private int _streak;

        private void Awake()
        {
            _pitched = gameObject.AddComponent<AudioSource>();
            _flat = gameObject.AddComponent<AudioSource>();
            foreach (var s in new[] { _pitched, _flat })
            {
                s.playOnAwake = false;
                s.spatialBlend = 0f;
                s.volume = volume;
            }

            _flap = ProceduralAudio.Hop();
            _clang = ProceduralAudio.Blocked();
            _basket = ProceduralAudio.IdlePulse();
            _swish = ProceduralAudio.CashConfirm();

            Haptics.Enabled = hapticsEnabled;
        }

        private void OnEnable()
        {
            if (game == null) return;
            game.Flapped += OnFlapped;
            game.Scored += OnScored;
            game.Clanged += OnClanged;
            game.RunEnded += OnRunEnded;
        }

        private void OnDisable()
        {
            if (game == null) return;
            game.Flapped -= OnFlapped;
            game.Scored -= OnScored;
            game.Clanged -= OnClanged;
            game.RunEnded -= OnRunEnded;
            Haptics.Cancel();
        }

        public void Configure(bool sound, bool haptics)
        {
            soundEnabled = sound;
            hapticsEnabled = haptics;
            Haptics.Enabled = haptics;
        }

        public void ResetForRun()
        {
            _streak = 0;
            Haptics.Cancel();
        }

        private void OnFlapped()
        {
            // Flat and low: this happens several times a second and must not
            // become the loudest thing in the game.
            PlayPitched(_flap, -7);
            Haptics.Pulse(8, 0.3f);
        }

        private void OnScored(bool swish)
        {
            if (_streak < Ladder.Length - 1) _streak++;

            if (swish)
            {
                PlayFlat(_swish);
                Haptics.Pattern(new long[] { 0, 16, 55, 40 }, 0.9f);
            }
            else
            {
                PlayPitched(_basket, Ladder[_streak]);
                Haptics.Pulse(30, 0.7f);
            }
        }

        private void OnClanged()
        {
            // Hitting iron costs the streak, which is what makes the ladder mean
            // something rather than only ever rising.
            _streak = 0;
            PlayFlat(_clang);
            Haptics.Pulse(22, 0.55f);
        }

        private void OnRunEnded(string reason)
        {
            Haptics.Pulse(160, 0.9f);
        }

        private void PlayPitched(AudioClip clip, int semitones)
        {
            if (!soundEnabled || clip == null) return;
            _pitched.pitch = Mathf.Pow(2f, semitones / 12f);
            _pitched.PlayOneShot(clip, volume);
        }

        private void PlayFlat(AudioClip clip)
        {
            if (!soundEnabled || clip == null) return;
            _flat.PlayOneShot(clip, volume);
        }
    }
}
