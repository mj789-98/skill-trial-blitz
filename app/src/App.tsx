/**
 * The app shell: auth, the flow reducer, and the API calls each transition makes.
 *
 * ── Why all the API calls live here ──────────────────────────────────────────
 *
 * Screens are given data and callbacks and render. None of them imports the API
 * client. That is not decoration: the calls that move money are `enter` and
 * `submit`, and having exactly one file that can issue them makes "is it
 * possible to charge twice?" a question you can answer by reading one screen of
 * code instead of auditing four.
 *
 * The `busy` flag is part of that. Every money call is guarded by it, so a
 * double-tap on "Pay and play" cannot produce two entries — and even if it did,
 * `enter` is idempotent on the quote, so the second would return the first
 * round rather than charging again. Two independent defences, because this is
 * the one place where being wrong costs a real person money.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { api } from './api/client';
import { ApiError, toApiError } from './api/errors';
import { signInAsTestPlayer, watchUser } from './api/auth';
import type { Game, Profile } from './api/types';
import { initialPhase, practiceSeed, reduce } from './flow/roundFlow';
import type { GameId, RoundEndMessage } from './unity/protocol';

import LobbyScreen from './screens/LobbyScreen';
import PayoutScreen from './screens/PayoutScreen';
import RoundScreen from './screens/RoundScreen';
import ResultScreen from './screens/ResultScreen';
import PracticeResultScreen from './screens/PracticeResultScreen';
import { Txt } from './ui/components';
import { colors, space } from './ui/theme';

export default function App() {
  const [phase, dispatch] = useReducer(reduce, initialPhase);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // ── Sign in ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsubscribe = watchUser((user) => {
      if (user) {
        dispatch({ type: 'SIGNED_IN' });
        return;
      }
      // No persisted session: sign in as the seeded test player. The brief asks
      // for an account a reviewer can log in with, and making that automatic
      // means a clean install lands in the lobby rather than on a form.
      signInAsTestPlayer().catch((err) => setFatal(toApiError(err).message));
    });
    return unsubscribe;
  }, []);

  // ── Loading the lobby ─────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    try {
      const [nextProfile, nextGames] = await Promise.all([api.profile(), api.games()]);
      setProfile(nextProfile);
      setGames(nextGames);
      setError(null);
    } catch (err) {
      setError(toApiError(err).playerMessage);
    }
  }, []);

  useEffect(() => {
    if (phase.name === 'lobby') void refresh();
  }, [phase.name, refresh]);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  /** Wrap a money call: one at a time, errors surfaced as player-readable text. */
  const guarded = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : toApiError(err);
      setError(apiError.playerMessage);
    } finally {
      setBusy(false);
    }
  }, []);

  // ── The round loop ────────────────────────────────────────────────────────

  const quote = useCallback(
    (gameId: GameId, stakeCents: number) =>
      guarded(async () => {
        const q = await api.quote(gameId, stakeCents);
        dispatch({ type: 'QUOTED', gameId, quote: q });
      }),
    [guarded]
  );

  const enter = useCallback(() => {
    if (phase.name !== 'payout') return;
    const { quote: q } = phase;
    return guarded(async () => {
      const round = await api.enter(q.quoteId);
      dispatch({ type: 'ENTERED', round });
    });
  }, [guarded, phase]);

  const heartbeat = useCallback((score: number, tick: number) => {
    if (phase.name !== 'round' || phase.mode !== 'blitz') return;
    // Fire and forget by design; see api.heartbeat.
    api.heartbeat(phase.round.roundId, score, tick);
  }, [phase]);

  /**
   * The run ended.
   *
   * The score Unity reported is passed through unchanged, including when it is
   * obviously wrong. Sanitising it here would destroy the evidence: the server
   * compares the claim against its own replay, and a mismatch is a cheat signal
   * it wants to see. The client's job is to report honestly, not to pre-approve.
   */
  const endRound = useCallback(
    (msg: RoundEndMessage) => {
      if (phase.name !== 'round') return;

      if (phase.mode === 'practice') {
        dispatch({ type: 'PRACTICE_ENDED', score: msg.score, reason: msg.reason });
        return;
      }

      const roundId = phase.round.roundId;
      void (async () => {
        setBusy(true);
        try {
          const settlement = await api.submit(roundId, msg.score, msg.trace);
          dispatch({ type: 'SETTLED', settlement });
        } catch (err) {
          // Submitting failed after four attempts. The player is NOT stuck and
          // has NOT lost the stake: the round has a deadline and the sweeper
          // settles it at the acknowledged heartbeat. Say so, and send them
          // somewhere they can see their balance.
          console.warn('[round] submit gave up, leaving it to the sweeper:', err);
          setError(
            'We could not reach the server to settle this round. It will be settled ' +
              'automatically — your balance will update shortly.'
          );
          dispatch({ type: 'BACK_TO_LOBBY' });
        } finally {
          setBusy(false);
        }
      })();
    },
    [phase]
  );

  const nameFor = useCallback(
    (gameId: GameId) => games.find((g) => g.game_id === gameId)?.display_name ?? gameId,
    [games]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const content = useMemo(() => {
    if (fatal) return <Fatal message={fatal} />;

    switch (phase.name) {
      case 'booting':
        return <Splash />;

      case 'lobby':
        return (
          <LobbyScreen
            profile={profile}
            games={games}
            busy={busy}
            refreshing={refreshing}
            error={error}
            onRefresh={pullToRefresh}
            onPractice={(gameId) =>
              dispatch({ type: 'PRACTICE_STARTED', gameId, seed: practiceSeed() })
            }
            onQuote={quote}
            onDeposit={() =>
              guarded(async () => {
                // The key is per-tap so each deliberate deposit is its own entry,
                // while a retry of the SAME tap is a no-op server-side.
                await api.deposit(1000, `lobby:${Date.now()}`);
                await refresh();
              })
            }
          />
        );

      case 'payout':
        return (
          <PayoutScreen
            quote={phase.quote}
            gameName={nameFor(phase.gameId)}
            busy={busy}
            error={error}
            onEnter={() => void enter()}
            onRequote={() => void quote(phase.gameId, phase.quote.stakeCents)}
            onBack={() => dispatch({ type: 'BACK_TO_LOBBY' })}
          />
        );

      case 'round':
        return (
          <RoundScreen
            gameId={phase.gameId}
            seed={phase.mode === 'blitz' ? phase.round.seed : phase.seed}
            roundId={phase.mode === 'blitz' ? phase.round.roundId : null}
            onHeartbeat={heartbeat}
            onEnded={endRound}
            settling={phase.mode === 'blitz' && busy}
          />
        );

      case 'result':
        return (
          <ResultScreen
            settlement={phase.settlement}
            gameName={nameFor(phase.gameId)}
            busy={busy}
            onPlayAgain={() => void quote(phase.gameId, phase.settlement.stakeCents)}
            onBack={() => dispatch({ type: 'BACK_TO_LOBBY' })}
          />
        );

      case 'practiceResult':
        return (
          <PracticeResultScreen
            gameName={nameFor(phase.gameId)}
            score={phase.score}
            reason={phase.reason}
            onPlayAgain={() =>
              dispatch({ type: 'PRACTICE_STARTED', gameId: phase.gameId, seed: practiceSeed() })
            }
            onBack={() => dispatch({ type: 'BACK_TO_LOBBY' })}
          />
        );
    }
  }, [
    busy,
    endRound,
    enter,
    error,
    fatal,
    games,
    guarded,
    heartbeat,
    nameFor,
    phase,
    profile,
    pullToRefresh,
    quote,
    refresh,
    refreshing,
  ]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      {/* The round is edge-to-edge on purpose — Unity draws its own safe area,
          and letting React inset the game would letterbox it. */}
      <SafeAreaView style={styles.root} edges={phase.name === 'round' ? [] : ['top', 'bottom']}>
        {content}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Splash() {
  return (
    <View style={styles.centre}>
      <ActivityIndicator color={colors.accent} size="large" />
    </View>
  );
}

/** Sign-in itself failed. Nothing in the app works without it, so say so plainly. */
function Fatal({ message }: { message: string }) {
  return (
    <View style={styles.centre}>
      <Txt variant="heading" color={colors.loss}>
        Cannot sign in
      </Txt>
      <Txt variant="small" color={colors.textFaint}>
        {message}
      </Txt>
      <Txt variant="small" color={colors.textFaint}>
        Check that the Firebase emulators are running on the development machine.
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.xl,
  },
});
