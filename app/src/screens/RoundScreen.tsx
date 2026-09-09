/**
 * The round. Unity fills the screen; React owns everything with money in it.
 *
 * ── What this screen is responsible for ──────────────────────────────────────
 *
 * Starting the round with the SERVER's seed, forwarding progress to the
 * heartbeat, and turning the one ROUND_END message into a settlement. That is
 * all. It renders no score of its own and no balance: the in-round HUD lives
 * inside Unity, and the money lives on the screen after this one.
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
 * that heartbeat is as current as possible — hence the flush below. Aborting
 * instead would mean a phone call costs a player their run.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';

import UnityHost, { type UnityHostHandle } from '../unity/UnityHost';
import type { GameId, RoundEndMessage, ScoreTickMessage } from '../unity/protocol';
import { Txt } from '../ui/components';
import { colors, space } from '../ui/theme';

interface Props {
  gameId: GameId;
  seed: string;
  /** Present in blitz, absent in practice. Its presence is what enables the API calls. */
  roundId: string | null;
  onHeartbeat: (score: number, tick: number) => void;
  onEnded: (msg: RoundEndMessage) => void;
  /** Rendered over the game while the settlement request is in flight. */
  settling: boolean;
}

export default function RoundScreen({
  seed,
  roundId,
  gameId,
  onHeartbeat,
  onEnded,
  settling,
}: Props) {
  const unity = useRef<UnityHostHandle>(null);
  const [started, setStarted] = useState(false);

  // The last progress Unity reported, kept so it can be flushed on the way to
  // the background without waiting for the next tick.
  const lastTick = useRef<ScoreTickMessage>({ type: 'SCORE_TICK', score: 0, tick: 0 });
  const ended = useRef(false);

  const start = useCallback(() => {
    const sent = unity.current?.send({
      type: 'START_ROUND',
      gameId,
      mode: roundId ? 'blitz' : 'practice',
      seed,
      roundId: roundId ?? '',
    });
    if (sent) setStarted(true);
  }, [gameId, roundId, seed]);

  // Unity may already be mounted and READY from a previous round, in which case
  // no READY message is coming and waiting for one would hang on a black screen
  // with the stake already taken.
  useEffect(() => {
    if (unity.current?.isReady()) start();
  }, [start]);

  const handleScoreTick = useCallback(
    (msg: ScoreTickMessage) => {
      lastTick.current = msg;
      if (roundId) onHeartbeat(msg.score, msg.tick);
    },
    [onHeartbeat, roundId]
  );

  const handleRoundEnd = useCallback(
    (msg: RoundEndMessage) => {
      if (ended.current) return;
      ended.current = true;
      onEnded(msg);
    },
    [onEnded]
  );

  /**
   * Unity fell over. The stake is already gone, so this still has to produce an
   * outcome rather than leaving the player on a dead screen.
   *
   * Reported as an abort carrying the acknowledged progress and an EMPTY trace.
   * That is deliberate: with nothing to replay, the server settles at the
   * heartbeat it already bounded by elapsed time, not at anything this client
   * claims. A crash is not a payout opportunity.
   */
  const handleUnityError = useCallback(
    (message: string) => {
      console.warn('[unity] round aborted:', message);
      handleRoundEnd({
        type: 'ROUND_END',
        reason: 'aborted',
        score: lastTick.current.score,
        tick: lastTick.current.tick,
        trace: '',
      });
    },
    [handleRoundEnd]
  );

  useEffect(() => {
    if (!roundId) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' || ended.current) return;
      // One last heartbeat on the way out. If this process is killed, this is
      // the number the sweeper will settle against.
      onHeartbeat(lastTick.current.score, lastTick.current.tick);
    });
    return () => sub.remove();
  }, [onHeartbeat, roundId]);

  return (
    <View style={styles.root}>
      <UnityHost
        ref={unity}
        onReady={start}
        onScoreTick={handleScoreTick}
        onRoundEnd={handleRoundEnd}
        onError={handleUnityError}
      />

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
  root: { flex: 1, backgroundColor: colors.bg },
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
