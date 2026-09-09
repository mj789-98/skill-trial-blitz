using UnityEngine;
using SkillApp.ChickenRun.Simulation;
using SkillApp.ChickenRun.View;

namespace SkillApp.ChickenRun.Audio
{
    /// <summary>
    /// Decides what every moment in a run sounds and feels like.
    ///
    /// ── One component for both, on purpose ───────────────────────────────────
    ///
    /// Sound and haptics are not two systems. A hop is one sensation that happens
    /// to reach the player through two channels, and if the tap and the buzz are
    /// decided in different files they drift apart — one gets tuned, the other
    /// does not, and the result is a game where the vibration arrives slightly
    /// after the click and nobody can say why it feels wrong. So each event is
    /// described once, here, in both channels.
    ///
    /// ── This is strictly a view-layer component ──────────────────────────────
    ///
    /// It subscribes to events and produces output. It has no way to influence the
    /// simulation, the input trace, or the score — which matters more than it
    /// might look: the server replays the trace, so anything that could alter it
    /// could alter a payout. Feedback reads; it never writes.
    ///
    /// ── The rising hop ───────────────────────────────────────────────────────
    ///
    /// The single largest piece of game feel in here. Consecutive forward progress
    /// walks the hop sound up a pentatonic scale; dying, being blocked, or
    /// starting a run resets it to the bottom. It is the trick Crossy Road uses,
    /// and it works because it converts a streak — which is otherwise only a
    /// number in the corner — into something the player hears building. Losing it
    /// is then audible too, which is what makes a death sting rather than just
    /// stop.
    ///
    /// Pentatonic rather than chromatic because every subset of a pentatonic scale
    /// is consonant, so a run of any length sounds like music rather than a siren.
    /// </summary>
    public class GameFeedback : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;
        [SerializeField] private CashOutButton cashOut;

        [Header("Channels")]
        [SerializeField] private bool soundEnabled = true;
        [SerializeField] private bool hapticsEnabled = true;
        [Range(0f, 1f)]
        [SerializeField] private float volume = 0.8f;

        /// <summary>
        /// Semitone offsets walked as a run continues. Pentatonic, two octaves.
        ///
        /// It stops climbing at the top rather than wrapping: a player on a very
        /// long run would otherwise hear the pitch drop back to the bottom, which
        /// reads as having lost something at the exact moment they are doing best.
        /// </summary>
        private static readonly int[] Ladder = { 0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24 };

        private AudioSource _pitched;
        private AudioSource _flat;
        private AudioSource _charge;

        private AudioClip _hop, _blocked, _thud, _horn, _splash, _idle, _cashCharge, _cashConfirm;

        private int _ladderIndex;

        // Idle-line tracking. The line's absolute row also moves when the player
        // hops FORWARD (it is anchored to the furthest row), so its position alone
        // cannot distinguish progress from stalling. LastAdvanceTick can: it only
        // changes when the player actually advances.
        private int _idleAnchorTick = -1;
        private int _lastIdleLine;

        private void Awake()
        {
            // Two one-shot sources, not one. AudioSource.pitch is read when a clip
            // starts, so a single shared source would transpose the death sound to
            // wherever the hop ladder happened to be standing.
            _pitched = gameObject.AddComponent<AudioSource>();
            _flat = gameObject.AddComponent<AudioSource>();
            _charge = gameObject.AddComponent<AudioSource>();

            foreach (var source in new[] { _pitched, _flat, _charge })
            {
                source.playOnAwake = false;
                // 2D. The camera moves and the chicken moves; positional audio
                // would pan the hop around for no benefit on a phone speaker.
                source.spatialBlend = 0f;
                source.volume = volume;
            }

            _hop = ProceduralAudio.Hop();
            _blocked = ProceduralAudio.Blocked();
            _thud = ProceduralAudio.Thud();
            _horn = ProceduralAudio.Horn();
            _splash = ProceduralAudio.Splash();
            _idle = ProceduralAudio.IdlePulse();
            _cashConfirm = ProceduralAudio.CashConfirm();

            _cashCharge = ProceduralAudio.CashCharge(cashOut != null ? cashOut.HoldSeconds : 0.7f);
            _charge.clip = _cashCharge;
            _charge.loop = false;

            Haptics.Enabled = hapticsEnabled;
        }

        private void OnEnable()
        {
            if (game != null)
            {
                game.ScoreChanged += OnScoreChanged;
                game.Hopped += OnHopped;
                game.Blocked += OnBlocked;
                game.Ticked += OnTicked;
                game.RunEnded += OnRunEnded;
            }

            if (cashOut != null)
            {
                cashOut.HoldStarted += OnHoldStarted;
                cashOut.HoldCancelled += OnHoldCancelled;
                cashOut.Fired += OnCashedOut;
            }
        }

        private void OnDisable()
        {
            if (game != null)
            {
                game.ScoreChanged -= OnScoreChanged;
                game.Hopped -= OnHopped;
                game.Blocked -= OnBlocked;
                game.Ticked -= OnTicked;
                game.RunEnded -= OnRunEnded;
            }

            if (cashOut != null)
            {
                cashOut.HoldStarted -= OnHoldStarted;
                cashOut.HoldCancelled -= OnHoldCancelled;
                cashOut.Fired -= OnCashedOut;
            }

            Haptics.Cancel();
        }

        /// <summary>Host settings, from a SET_AUDIO message.</summary>
        public void Configure(bool sound, bool haptics)
        {
            soundEnabled = sound;
            hapticsEnabled = haptics;
            Haptics.Enabled = haptics;
            if (!sound && _charge != null) _charge.Stop();
        }

        /// <summary>Called when a run begins, so the ladder does not carry over.</summary>
        public void ResetForRun()
        {
            _ladderIndex = 0;
            _idleAnchorTick = -1;
            _lastIdleLine = 0;
            _charge?.Stop();
            Haptics.Cancel();
        }

        // ── Events ──────────────────────────────────────────────────────────

        /// <summary>
        /// Forward progress. Fired BEFORE Hopped by the game loop, deliberately
        /// relied upon here: the hop that earned the point plays at the new, higher
        /// pitch, so the reward is simultaneous with the action rather than one hop
        /// behind it.
        /// </summary>
        private void OnScoreChanged(int score)
        {
            if (_ladderIndex < Ladder.Length - 1) _ladderIndex++;
        }

        private void OnHopped(byte action)
        {
            // Every accepted hop makes a sound, but only forward progress moved the
            // ladder — so shuffling sideways to line up a gap is audible without
            // being rewarded, which is exactly how it should read.
            PlayPitched(_hop, Ladder[_ladderIndex]);
            Haptics.Pulse(10, 0.35f);
        }

        private void OnBlocked()
        {
            // A refused input costs the streak. That is a design decision, not a
            // side effect: hopping into a wall is a mistake, and the ladder is the
            // game's way of telling you that you were doing well until now.
            _ladderIndex = 0;
            PlayFlat(_blocked);
            // Two short taps read as a rejection; one would be indistinguishable
            // from a hop that felt slightly different.
            Haptics.Pattern(new long[] { 0, 9, 45, 9 }, 0.5f);
        }

        /// <summary>
        /// Watches the idle line rather than a timer.
        ///
        /// The line is what actually kills the player (see DECISIONS D-004), so the
        /// audio is tied to the line moving, not to a countdown running in parallel
        /// that could disagree with it. One pulse per row it gains: four pulses,
        /// getting closer together in the player's attention, then the run ends.
        /// </summary>
        private void OnTicked(Sim.State state)
        {
            int line = Sim.IdleLineRow(state);

            // The player advanced, so the line jumped forward with them. Re-anchor
            // and stay silent: this is progress, not the line gaining on them.
            if (state.LastAdvanceTick != _idleAnchorTick)
            {
                _idleAnchorTick = state.LastAdvanceTick;
                _lastIdleLine = line;
                return;
            }

            // Same anchor, higher line: the grace period has expired and the line
            // is genuinely closing. One pulse per row it takes.
            if (line > _lastIdleLine)
            {
                _lastIdleLine = line;
                PlayFlat(_idle);
                Haptics.Pulse(14, 0.5f);
            }
        }

        private void OnRunEnded(string reason)
        {
            _charge?.Stop();

            if (reason == Sim.EndCashOut)
            {
                // Handled by OnCashedOut, which fires from the button and therefore
                // lands on the press rather than a tick later.
                return;
            }

            if (reason == Sim.EndAborted)
            {
                Haptics.Cancel();
                return;
            }

            // Which death it was, so the sound matches what the player saw. The row
            // type is a pure function of the seed, so asking for it costs nothing
            // and requires no extra state to be carried out of the simulation.
            int kind = game != null && game.State != null
                ? Sim.RowTypeAt(game.State.Seed, game.State.Row)
                : Sim.RowGrass;

            AudioClip clip = kind switch
            {
                Sim.RowRiver => _splash,
                Sim.RowRail => _horn,
                _ => _thud,
            };

            PlayFlat(clip);
            // Long and full strength. This is the one moment worth being emphatic
            // about: the player just lost their entry.
            Haptics.Pulse(180, 1f);
            _ladderIndex = 0;
        }

        private void OnHoldStarted()
        {
            if (soundEnabled && _charge != null)
            {
                _charge.volume = volume;
                _charge.Play();
            }
            Haptics.Pulse(12, 0.4f);
        }

        private void OnHoldCancelled()
        {
            _charge?.Stop();
        }

        private void OnCashedOut()
        {
            _charge?.Stop();
            PlayFlat(_cashConfirm);
            // Two pulses, the second longer: a resolution rather than a warning.
            // The only haptic in the game that is meant to feel good.
            Haptics.Pattern(new long[] { 0, 18, 60, 45 }, 0.9f);
        }

        // ── Playback ────────────────────────────────────────────────────────

        private void PlayPitched(AudioClip clip, int semitones)
        {
            if (!soundEnabled || clip == null || _pitched == null) return;
            _pitched.pitch = Mathf.Pow(2f, semitones / 12f);
            _pitched.PlayOneShot(clip, volume);
        }

        private void PlayFlat(AudioClip clip)
        {
            if (!soundEnabled || clip == null || _flat == null) return;
            _flat.PlayOneShot(clip, volume);
        }
    }
}
