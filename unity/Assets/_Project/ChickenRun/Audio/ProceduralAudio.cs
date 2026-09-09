using System;
using UnityEngine;

namespace SkillApp.ChickenRun.Audio
{
    /// <summary>
    /// Every sound in the game, synthesised at load rather than imported.
    ///
    /// ── Why generate audio instead of shipping .wav files ────────────────────
    ///
    /// Three reasons, and the first is the one that decided it.
    ///
    /// There is no art budget on this trial, and audio I did not make is audio
    /// whose licensing I cannot vouch for. A repo that ships sound it is not
    /// entitled to ship is a worse problem than a repo that sounds synthetic.
    ///
    /// Second, it is tunable by editing a number. The hop is a decaying sine at
    /// 520Hz over 90ms; making it shorter and brighter is a diff, not a trip back
    /// to a DAW and a re-export. For a build where the whole point is that the
    /// game FEELS right, being able to change the feel in one line matters more
    /// than fidelity.
    ///
    /// Third, it keeps binaries out of git. Eight clips at 44.1kHz would be a few
    /// hundred KB of opaque blobs; this is 200 lines that diff.
    ///
    /// ── What it costs ────────────────────────────────────────────────────────
    ///
    /// It sounds like a synthesiser, because it is one. A real product would
    /// replace this with recorded foley and keep the same call sites — GameFeedback
    /// asks for "the hop sound", not for a waveform, so the swap is one file.
    ///
    /// ── One clip per sound, pitched at playback ──────────────────────────────
    ///
    /// The hop rises in pitch as a run continues (see GameFeedback). That is done
    /// with AudioSource.pitch on a single clip rather than by generating one clip
    /// per semitone: transposing is free, and generating twelve variants of the
    /// same 90ms tone would be four thousand samples of waste each.
    /// </summary>
    public static class ProceduralAudio
    {
        private const int SampleRate = 44100;

        /// <summary>The tap of a successful hop. Transposed at playback.</summary>
        public static AudioClip Hop() => Build("cr_hop", 0.09f, (t, d) =>
        {
            // A sine with a little of its own second harmonic: pure sine reads as
            // a test tone, a square reads as cheap. The harmonic gives it a body
            // that survives a phone speaker, which is the only speaker that
            // matters here.
            float env = Decay(t, d, 26f) * Attack(t, 0.004f);
            float wave = Mathf.Sin(TwoPi * 520f * t) + 0.35f * Mathf.Sin(TwoPi * 1040f * t);
            return wave * env * 0.65f;
        });

        /// <summary>An input the terrain refused. Deliberately unsatisfying.</summary>
        public static AudioClip Blocked() => Build("cr_blocked", 0.07f, (t, d) =>
        {
            // Low, short and slightly detuned, so it reads as "no" rather than as
            // a quieter version of "yes". A blocked hop that sounds like a hop
            // teaches the player the wrong thing.
            //
            // 196Hz rather than the 150Hz this started at: a phone speaker is a
            // few millimetres across and rolls off hard below roughly 200Hz, so a
            // "nice low thunk" on headphones is silence in a player's hand. The
            // beating between the two detuned partials is what carries the
            // roughness, and that survives the roll-off because it is amplitude
            // modulation, not bass.
            float env = Decay(t, d, 40f);
            float wave = Mathf.Sin(TwoPi * 196f * t) + 0.5f * Mathf.Sin(TwoPi * 205f * t);
            return wave * env * 0.45f;
        });

        /// <summary>Hit by a car. A flat, final thud.</summary>
        public static AudioClip Thud() => Build("cr_thud", 0.30f, (t, d) =>
        {
            // A pitch sweep downward is what makes something sound like it fell
            // over rather than like it beeped.
            float env = Decay(t, d, 9f);
            // Sweeps to 90Hz rather than 60Hz. Below about 200Hz a phone speaker
            // is reproducing harmonics rather than the fundamental, and a sweep
            // that ends at 60Hz simply fades out early instead of landing.
            float freq = Mathf.Lerp(240f, 90f, Mathf.Clamp01(t / 0.12f));
            float body = Mathf.Sin(TwoPi * freq * t);
            float grit = Noise(t) * 0.4f * Decay(t, d, 30f);
            return (body + grit) * env * 0.55f;
        });

        /// <summary>Hit by a train. Louder, with a horn under it.</summary>
        public static AudioClip Horn() => Build("cr_horn", 0.45f, (t, d) =>
        {
            // Two tones a fourth apart is the interval a real level-crossing horn
            // uses, and it is instantly recognisable as "train" even out of context.
            float env = Attack(t, 0.02f) * Decay(t, d, 5f);
            float wave = Mathf.Sin(TwoPi * 165f * t) + Mathf.Sin(TwoPi * 220f * t);
            return wave * env * 0.42f;
        });

        /// <summary>Fell in the river. Filtered noise, no tone.</summary>
        public static AudioClip Splash() => Build("cr_splash", 0.38f, (t, d) =>
        {
            // Water has no pitch. Noise with a fast attack and a long tail, rolled
            // off so it is a splash and not static.
            float env = Attack(t, 0.006f) * Decay(t, d, 8f);
            return LowPassed(t, 0.35f) * env * 0.5f;
        });

        /// <summary>The idle line taking a step. A soft, ominous pulse.</summary>
        public static AudioClip IdlePulse() => Build("cr_idle", 0.16f, (t, d) =>
        {
            // This fires while the player is doing nothing, so it has to be
            // noticeable without being an alarm — the shadow on screen is the real
            // signal, and this is a nudge to look at it.
            //
            // The first version of this was a 98Hz sine at 0.3 gain, and the
            // audibility check in AudioPreview rejected it: peak 0.049, which is
            // both under the threshold and, at 98Hz, below what a phone speaker
            // can reproduce at all. Raised into the audible band and given a
            // minor-second partial, which is dissonant enough to read as a warning
            // without being loud.
            float env = Attack(t, 0.03f) * Decay(t, d, 10f);
            float wave = Mathf.Sin(TwoPi * 175f * t) + 0.45f * Mathf.Sin(TwoPi * 185f * t);
            return wave * env * 0.5f;
        });

        /// <summary>Held while Cash Out fills. Rises over the hold duration.</summary>
        public static AudioClip CashCharge(float seconds) =>
            Build("cr_cash_charge", seconds, (t, d) =>
            {
                // A rising tone is the clearest possible "keep holding". It ends a
                // whole tone below the confirm, so the confirm resolves upward
                // rather than arriving out of nowhere.
                float p = Mathf.Clamp01(t / d);
                float freq = Mathf.Lerp(300f, 620f, p * p);
                float env = Attack(t, 0.03f) * Mathf.Lerp(0.35f, 0.9f, p);
                return Mathf.Sin(TwoPi * freq * t) * env * 0.22f;
            });

        /// <summary>Cash Out fired. The one unambiguously good sound in the game.</summary>
        public static AudioClip CashConfirm() => Build("cr_cash", 0.55f, (t, d) =>
        {
            // A major triad, arpeggiated. It is the only sound here built from an
            // actual chord, because it is the only moment the player has won
            // something, and it should not be confusable with anything else.
            float env = Decay(t, d, 4.2f);
            float a = Mathf.Sin(TwoPi * 523.25f * t);                     // C5
            float b = t > 0.07f ? Mathf.Sin(TwoPi * 659.25f * t) : 0f;    // E5
            float c = t > 0.14f ? Mathf.Sin(TwoPi * 783.99f * t) : 0f;    // G5
            return (a + b + c) * env * 0.24f;
        });

        // ── Synthesis helpers ───────────────────────────────────────────────

        private const float TwoPi = Mathf.PI * 2f;

        /// <param name="shape">(time in seconds, duration) -> sample in [-1, 1]</param>
        private static AudioClip Build(string name, float seconds, Func<float, float, float> shape)
        {
            int count = Mathf.Max(1, Mathf.RoundToInt(seconds * SampleRate));
            var samples = new float[count];

            for (int i = 0; i < count; i++)
            {
                float t = i / (float)SampleRate;
                samples[i] = Mathf.Clamp(shape(t, seconds), -1f, 1f);
            }

            // A short fade at the very end. Without it the waveform is cut mid-cycle
            // and the discontinuity is audible as a click on every single play —
            // the kind of defect that makes a game feel cheap without anyone being
            // able to say why.
            int fade = Mathf.Min(count, SampleRate / 500);
            for (int i = 0; i < fade; i++)
            {
                samples[count - 1 - i] *= i / (float)fade;
            }

            var clip = AudioClip.Create(name, count, 1, SampleRate, false);
            clip.SetData(samples, 0);
            return clip;
        }

        /// <summary>Exponential decay. Higher rate = shorter sound.</summary>
        private static float Decay(float t, float duration, float rate) =>
            Mathf.Exp(-rate * (t / Mathf.Max(duration, 0.0001f)));

        /// <summary>Linear attack over the first `seconds`, to avoid a click at onset.</summary>
        private static float Attack(float t, float seconds) =>
            seconds <= 0f ? 1f : Mathf.Clamp01(t / seconds);

        /// <summary>
        /// Deterministic value noise.
        ///
        /// Deliberately not UnityEngine.Random: this runs at load, and reaching
        /// into the shared random stream would make the sequence the rest of the
        /// game sees depend on how many clips were built.
        /// </summary>
        private static float Noise(float t)
        {
            float x = Mathf.Sin(t * 12345.678f) * 43758.5453f;
            return (x - Mathf.Floor(x)) * 2f - 1f;
        }

        /// <summary>Noise with the top end rolled off, by averaging neighbours.</summary>
        private static float LowPassed(float t, float amount)
        {
            float step = amount / SampleRate * 40f;
            return (Noise(t) + Noise(t - step) + Noise(t - step * 2f)) / 3f;
        }
    }
}
