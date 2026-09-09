/**
 * The round. Unity fills the screen behind this; React owns everything with
 * money in it.
 *
 * ── This screen does NOT mount Unity ─────────────────────────────────────────
 *
 * The Unity player is mounted once, for the whole app session, by App.tsx. This
 * screen is a transparent overlay on top of it that sends a START_ROUND.
 *
 * That is not tidiness, it is the fix for a crash. The Unity player is a
 * process-wide singleton, and the embed calls resumeUnity() itself whenever its
 * view is attached to a window. Mounting a UnityView per round therefore
 * re-attached the surface every time, racing Unity's own graphics init:
 *
 *     E Unity : Graphics device is null.
 *     F libc  : Fatal signal 5 (SIGTRAP) in tid (UnityMain)
 *
 * Keeping the view attached for the session removes the race, and it is what
 * `androidKeepPlayerMounted` was for in the first place — mounting per round was
 * quietly fighting the setting that makes entering a round instant.
 *
 * ── What this screen is responsible for ──────────────────────────────────────
 *
 * Starting the round with the SERVER's seed, and covering the game while it
 * loads or settles. It renders no score of its own and no balance: the in-round
 * HUD lives inside Unity, and the money lives on the screen after this one.
 *
 * That split is the trust boundary made visible. Unity never learns that a stake
 * exists, so a tampered Unity build can influence exactly one thing — the
 * contents of a ROUND_END — and that is replayed server-side before it is worth
 * anything.
 *
 * ── Backgrounding ───────────────────────────────────────────────────────────
 *
 * Going to the home screen mid-round does NOT abort it. The round keeps its
 * deadline, and if the app never comes back the sweeper settles it at the last
 * acknowledged heartbeat. So the only thing to do on the way out is make sure
 * that heartbeat is as current as possible. Aborting instead would mean a phone
 * call costs a player their run.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';

import type { UnityHostHandle } from '../unity/UnityHost';
import type { GameId } from '../unity/protocol';
import { Txt } from '../ui/components';
import { colors, space } from '../ui/theme';

interface Props {
  gameId: GameId;
  seed: string;
  /** Present in blitz, absent in practice. Its presence is what enables the API calls. */
  roundId: string | null;
  /** The player's sound and haptics preferences. Unity does not remember these. */
  feedback: { sound: boolean; haptics: boolean };
  /** The session-long Unity player, owned by App. */
  unity: React.RefObject<UnityHostHandle | null>;
  /** Whether Unity has completed its handshake. Drives the start attempt. */
  unityReady: boolean;
  /** The most recent progress Unity reported, for the background flush. */
  lastProgress: React.RefObject<{ score: number; tick: number }>;
  onHeartbeat: (score: number, tick: number) => void;
  /** Rendered over the game while the settlement request is in flight. */
  settling: boolean;
}

export default function RoundScreen({
  seed,
  roundId,
  gameId,
  feedback,
  unity,
  unityReady,
  lastProgress,
  onHeartbeat,
  settling,
}: Props) {
  const [started, setStarted] = useState(false);
  const sentFor = useRef<string | null>(null);

  useEffect(() => {
    if (!unityReady) return;
    // Exactly one START_ROUND per seed. This effect can re-run — a re-render, a
    // settings change — and a second START_ROUND would restart the world under a
    // player who has already paid for this one.
    if (sentFor.current === seed) return;

    // Preferences first. Unity holds no persisted copy, so a round that began
    // before this arrived would play its first hops at the wrong settings —
    // which for a player who muted the game is the only moment that matters.
    unity.current?.send({
      type: 'SET_AUDIO',
      sound: feedback.sound,
      music: false, // there is no music track; declared so the contract is complete
      haptics: feedback.haptics,
    });

    const sent = unity.current?.send({
      type: 'START_ROUND',
      gameId,
      mode: roundId ? 'blitz' : 'practice',
      seed,
      roundId: roundId ?? '',
    });

    if (sent) {
      sentFor.current = seed;
      setStarted(true);
    }
  }, [feedback.haptics, feedback.sound, gameId, roundId, seed, unity, unityReady]);

  useEffect(() => {
    if (!roundId) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      // One last heartbeat on the way out. If this process is killed, this is
      // the number the sweeper will settle against.
      onHeartbeat(lastProgress.current.score, lastProgress.current.tick);
    });
    return () => sub.remove();
  }, [lastProgress, onHeartbeat, roundId]);

  // Transparent, and box-none so touches reach the Unity surface underneath.
  return (
    <View style={styles.root} pointerEvents="box-none">
      {!started ? <Curtain caption="Loading the course" /> : null}
      {settling ? <Curtain caption="Settling with the server" /> : null}
    </View>
  );
}

/**
 * A full-bleed cover over the game.
 *
 * Opaque, not translucent: while a settlement is in flight the last frame shows
 * a final score that has not been validated yet, and letting the player read it
 * before the server has spoken invites the number to change under them.
 */
function Curtain({ caption }: { caption: string }) {
  return (
    <View style={styles.curtain}>
      <ActivityIndicator color={colors.accent} size="large" />
      <Txt variant="body" color={colors.textMuted}>
        {caption}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  curtain: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
});
