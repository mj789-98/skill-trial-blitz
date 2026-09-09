using UnityEngine;

namespace SkillApp.ChickenRun.Audio
{
    /// <summary>
    /// Short, amplitude-controlled vibration on Android.
    ///
    /// ── Why not Handheld.Vibrate() ───────────────────────────────────────────
    ///
    /// Unity's built-in `Handheld.Vibrate()` is a fixed buzz of roughly half a
    /// second with no amplitude control. A hop in this game lasts 120ms. Firing a
    /// 500ms buzz on every hop would overlap itself continuously, drain the
    /// battery, and feel like the phone was broken — it is worse than no haptics
    /// at all, which is why "add haptics" cannot honestly mean "call Vibrate()".
    ///
    /// So this goes to the platform API directly through JNI. A hop is 10ms at a
    /// third of full strength; a death is 180ms at full. Those are different
    /// sensations, and being able to express the difference is the entire point.
    ///
    /// ── The two Android APIs ─────────────────────────────────────────────────
    ///
    /// - API 31+ (Android 12): the Vibrator must be obtained from VibratorManager.
    ///   Asking for "vibrator" directly is deprecated and returns a vibrator that
    ///   may not be the right one on a multi-actuator device.
    /// - API 26+ (Android 8): VibrationEffect.createOneShot(ms, amplitude).
    /// - Below that: a bare duration, no amplitude. `minSdkVersion` for a React
    ///   Native 0.86 app is 24, so this range is reachable and is handled rather
    ///   than assumed away.
    ///
    /// Amplitude is only honoured on devices whose motor supports it
    /// (`hasAmplitudeControl`). On the ones that do not, Android substitutes full
    /// strength, so a "light" hop becomes a full one — which is why the DURATIONS
    /// are also scaled per event and not just the amplitudes. The feel degrades
    /// rather than collapsing.
    ///
    /// Everything here is a no-op in the editor and on any non-Android platform.
    /// </summary>
    public static class Haptics
    {
        /// <summary>Turned off by the host through SET_AUDIO, or by a failure to bind.</summary>
        public static bool Enabled { get; set; } = true;

#if UNITY_ANDROID && !UNITY_EDITOR
        private static bool _initialised;
        private static bool _available;
        private static bool _hasAmplitude;
        private static int _sdk;

        private static AndroidJavaObject _vibrator;
        private static AndroidJavaClass _effectClass;

        private static void Initialise()
        {
            if (_initialised) return;
            _initialised = true;

            try
            {
                using var version = new AndroidJavaClass("android.os.Build$VERSION");
                _sdk = version.GetStatic<int>("SDK_INT");

                using var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
                using var activity = player.GetStatic<AndroidJavaObject>("currentActivity");

                if (_sdk >= 31)
                {
                    // Android 12 routes through VibratorManager; the direct
                    // "vibrator" service is deprecated and may be the wrong motor.
                    using var manager = activity.Call<AndroidJavaObject>(
                        "getSystemService", "vibrator_manager");
                    _vibrator = manager?.Call<AndroidJavaObject>("getDefaultVibrator");
                }
                else
                {
                    _vibrator = activity.Call<AndroidJavaObject>("getSystemService", "vibrator");
                }

                if (_vibrator == null) return;
                if (!_vibrator.Call<bool>("hasVibrator")) return;

                if (_sdk >= 26)
                {
                    _effectClass = new AndroidJavaClass("android.os.VibrationEffect");
                    _hasAmplitude = _vibrator.Call<bool>("hasAmplitudeControl");
                }

                _available = true;
            }
            catch (System.Exception e)
            {
                // A device that will not give us a vibrator is not a broken game.
                // Log once and never try again — retrying per hop would be a JNI
                // call and an exception fifty times a second.
                Debug.LogWarning($"[haptics] unavailable: {e.Message}");
                _available = false;
            }
        }
#endif

        /// <summary>
        /// Fire one pulse.
        /// </summary>
        /// <param name="milliseconds">Duration. Below ~8ms most motors produce nothing.</param>
        /// <param name="strength">0..1. Ignored on motors without amplitude control.</param>
        public static void Pulse(int milliseconds, float strength = 1f)
        {
            if (!Enabled) return;

#if UNITY_ANDROID && !UNITY_EDITOR
            Initialise();
            if (!_available) return;

            try
            {
                if (_sdk >= 26)
                {
                    // 1..255. Clamped to at least 1 because 0 means "device default"
                    // to Android, which is full strength — the exact opposite of
                    // what a caller asking for near-silence wants.
                    int amplitude = Mathf.Clamp(Mathf.RoundToInt(strength * 255f), 1, 255);
                    using var effect = _effectClass.CallStatic<AndroidJavaObject>(
                        "createOneShot", (long)milliseconds, amplitude);
                    _vibrator.Call("vibrate", effect);
                }
                else
                {
                    _vibrator.Call("vibrate", (long)milliseconds);
                }
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[haptics] pulse failed: {e.Message}");
                _available = false;
            }
#endif
        }

        /// <summary>
        /// Fire a pattern: alternating wait/vibrate durations, as Android expects.
        ///
        /// Used for the sensations a single pulse cannot express — the double tap
        /// of a refused input, and the rising two-stage buzz of a cash-out.
        /// </summary>
        public static void Pattern(long[] timings, float strength = 1f)
        {
            if (!Enabled || timings == null || timings.Length == 0) return;

#if UNITY_ANDROID && !UNITY_EDITOR
            Initialise();
            if (!_available) return;

            try
            {
                if (_sdk >= 26)
                {
                    int amplitude = Mathf.Clamp(Mathf.RoundToInt(strength * 255f), 1, 255);
                    var amplitudes = new int[timings.Length];
                    for (int i = 0; i < timings.Length; i++)
                    {
                        // Even entries are waits and must be silent; odd entries buzz.
                        amplitudes[i] = (i % 2 == 0) ? 0 : amplitude;
                    }

                    using var effect = _effectClass.CallStatic<AndroidJavaObject>(
                        "createWaveform", timings, amplitudes, -1); // -1 = do not repeat
                    _vibrator.Call("vibrate", effect);
                }
                else
                {
                    _vibrator.Call("vibrate", timings, -1);
                }
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[haptics] pattern failed: {e.Message}");
                _available = false;
            }
#endif
        }

        /// <summary>Stop anything in progress. Called when a run ends mid-pattern.</summary>
        public static void Cancel()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!_available) return;
            try { _vibrator.Call("cancel"); }
            catch { /* nothing useful to do */ }
#endif
        }
    }
}
