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

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  StatusBar,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { api } from './api/client';
import { describeHost, setRuntimeHost } from './api/config';
import { loadServerHost, normaliseHost, saveServerHost } from './api/serverHost';
import { ApiError, toApiError } from './api/errors';
import { signInAsTestPlayer, watchUser } from './api/auth';
import type { Game, Profile } from './api/types';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type FeedbackSettings,
} from './api/settings';
import { initialPhase, practiceSeed, reduce } from './flow/roundFlow';
import type { GameId, RoundEndMessage, ScoreTickMessage } from './unity/protocol';
import UnityHost, { type UnityHostHandle } from './unity/UnityHost';

import LobbyScreen from './screens/LobbyScreen';
import PayoutScreen from './screens/PayoutScreen';
import RoundScreen from './screens/RoundScreen';
import ResultScreen from './screens/ResultScreen';
import PracticeResultScreen from './screens/PracticeResultScreen';
import { Button, Txt } from './ui/components';
import { colors, space } from './ui/theme';

export default function App() {
  const [phase, dispatch] = useReducer(reduce, initialPhase);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  /** Bumped by Retry, to re-arm the boot deadline and re-run sign-in. */
  const [bootAttempt, setBootAttempt] = useState(0);
  const [feedback, setFeedback] = useState<FeedbackSettings>(DEFAULT_SETTINGS);

  // The Unity player, mounted ONCE for the session. See RoundScreen's header for
  // why it is not mounted per round.
  const unity = useRef<UnityHostHandle | null>(null);
  const [unityReady, setUnityReady] = useState(false);
  // The last progress Unity reported. A ref, because it is read from an AppState
  // listener that must not be re-subscribed on every tick.
  const lastProgress = useRef({ score: 0, tick: 0 });
  // The live phase, for the Unity callbacks — they are registered once and would
  // otherwise close over the phase as it was at mount.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Read once at startup. Unity is told these at the start of every round rather
  // than keeping its own copy — see api/settings.ts.
  useEffect(() => {
    loadSettings().then(setFeedback);
  }, []);

  const changeFeedback = useCallback((next: FeedbackSettings) => {
    // Applied immediately, persisted in the background. A toggle that waits for
    // storage before it moves feels broken, and the write cannot fail in a way
    // the player needs to hear about.
    setFeedback(next);
    void saveSettings(next);
  }, []);

  // ── Sign in ───────────────────────────────────────────────────────────────

  /**
   * The device-chosen backend address, applied before the first Firebase call.
   *
   * Gating sign-in on this is the whole point. `connectAuthEmulator` runs on
   * the first call to auth(), and it is one-shot — so if watchUser started
   * before storage was read, the SDK would already be pointed at the default
   * and the stored address would silently do nothing.
   */
  const [hostReady, setHostReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadServerHost()
      .then((host) => {
        if (cancelled) return;
        setRuntimeHost(host);
        setHostReady(true);
      })
      .catch(() => setHostReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hostReady) return;

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
  }, [bootAttempt, hostReady]);

  /**
   * A deadline on the splash screen.
   *
   * Signing in is the one step with nothing behind it: no lobby to fall back
   * to, no error banner to render into. So if it never resolves, `booting`
   * never ends and the app shows a spinner forever — which is exactly what a
   * player saw the first time the phone was unplugged from the machine running
   * the emulators. The release build reaches the backend over `adb reverse`, a
   * USB tunnel, and without it `localhost` is the phone itself. The request
   * does not fail; it hangs, so no catch anywhere in the app ever runs.
   *
   * Twelve seconds is well past a cold start on a real device and well short of
   * a player deciding the app is broken. What matters more than the number is
   * that the spinner is BOUNDED: an unbounded one is not a loading state, it is
   * an error state with no copy.
   */
  useEffect(() => {
    if (phase.name !== 'booting' || !hostReady) return;

    const timer = setTimeout(() => {
      setFatal(
        `No response from the backend at ${describeHost()}. ` +
        'The emulators may not be running, or this device may not be able to ' +
        'reach them.'
      );
    }, 12000);

    return () => clearTimeout(timer);
  }, [phase.name, bootAttempt, hostReady]);

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
    const current = phaseRef.current;
    if (current.name !== 'round' || current.mode !== 'blitz') return;
    // Fire and forget by design; see api.heartbeat.
    api.heartbeat(current.round.roundId, score, tick);
  }, []);

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
      const current = phaseRef.current;
      if (current.name !== 'round') return;

      if (current.mode === 'practice') {
        dispatch({ type: 'PRACTICE_ENDED', score: msg.score, reason: msg.reason });
        return;
      }

      const roundId = current.round.roundId;
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
    []
  );

  // ── Unity callbacks, registered once ──────────────────────────────────────

  const onUnityScoreTick = useCallback(
    (msg: ScoreTickMessage) => {
      lastProgress.current = { score: msg.score, tick: msg.tick };
      heartbeat(msg.score, msg.tick);
    },
    [heartbeat]
  );

  /**
   * Unity fell over. If a stake is on the table this still has to produce an
   * outcome rather than leaving the player on a dead screen.
   *
   * Reported as an abort carrying the acknowledged progress and an EMPTY trace.
   * With nothing to replay, the server settles at the heartbeat it already
   * bounded by elapsed time, not at anything this client claims. A crash is not
   * a payout opportunity.
   */
  const onUnityError = useCallback(
    (message: string) => {
      console.warn('[unity] round aborted:', message);
      endRound({
        type: 'ROUND_END',
        reason: 'aborted',
        score: lastProgress.current.score,
        tick: lastProgress.current.tick,
        trace: '',
      });
    },
    [endRound]
  );

  /**
   * The Android hardware back button.
   *
   * Choosing a state machine over a navigation stack (DECISIONS D-016) means
   * nothing handles this for free — and on a device that is not a missing
   * animation, it is the back gesture closing the app from the payout screen.
   * Found by pressing it.
   *
   * The rules are the reducer's, restated for the one input the reducer cannot
   * see: back leaves a screen, except a PAID round, which it must not leave.
   * Returning true consumes the press; returning false lets Android do what it
   * would have done, which from the lobby is to background the app — correct,
   * because that is the top of this app's stack.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase.name === 'booting' || phase.name === 'lobby') return false;

      // A paid round has no exit. Swallow the press rather than letting it
      // background the app mid-round: the round would survive on the server and
      // be swept, but the player would think they had lost their entry.
      if (phase.name === 'round' && phase.mode === 'blitz') return true;

      dispatch({ type: 'BACK_TO_LOBBY' });
      return true;
    });
    return () => sub.remove();
  }, [phase]);

  const nameFor = useCallback(
    (gameId: GameId) => games.find((g) => g.game_id === gameId)?.display_name ?? gameId,
    [games]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const content = useMemo(() => {
    if (fatal) {
      return (
        <Fatal
          message={fatal}
          onRetry={() => {
            setFatal(null);
            setBootAttempt((n) => n + 1);
          }}
        />
      );
    }

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
            feedback={feedback}
            onFeedbackChange={changeFeedback}
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
            feedback={feedback}
            unity={unity}
            unityReady={unityReady}
            lastProgress={lastProgress}
            onHeartbeat={heartbeat}
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
    changeFeedback,
    enter,
    error,
    fatal,
    feedback,
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
    unityReady,
  ]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.root}>
        {/*
          Unity, mounted for the whole session and never unmounted.

          It sits at the BOTTOM of the tree and every other screen is opaque, so
          it is simply covered when there is no round. That is deliberately dumb:
          hiding it with display:none, or unmounting it, detaches the surface —
          and re-attaching is what crashed the player with "Graphics device is
          null". A view that is merely covered is a view Android never touches.
        */}
        <View style={styles.unityLayer} pointerEvents={phase.name === 'round' ? 'auto' : 'none'}>
          <UnityHost
            ref={unity}
            onReady={() => setUnityReady(true)}
            onScoreTick={onUnityScoreTick}
            onRoundEnd={endRound}
            onError={onUnityError}
          />
        </View>

        {/* The round is edge-to-edge on purpose — Unity draws its own safe area,
            and letting React inset the game would letterbox it. */}
        <SafeAreaView
          style={phase.name === 'round' ? styles.transparent : styles.root}
          edges={phase.name === 'round' ? [] : ['top', 'bottom']}
          pointerEvents="box-none"
        >
          {content}
        </SafeAreaView>
      </View>
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
/**
 * Sign-in failed, and there is nothing behind it to fall back to.
 *
 * Carries the address field rather than burying it in a settings screen,
 * because this is the only screen on which it is ever the thing you want, and
 * a player who cannot get past it has no way to reach a settings screen
 * anyway.
 */
function Fatal({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const applyHost = async () => {
    const host = normaliseHost(draft);
    await saveServerHost(host);
    setRuntimeHost(host);
    setSaved(true);
  };

  return (
    <View style={styles.centre}>
      <Txt variant="heading" color={colors.loss}>
        Cannot reach the server
      </Txt>
      <Txt variant="small" color={colors.textFaint}>
        {message}
      </Txt>
      <Txt variant="small" color={colors.textFaint}>
        Nothing has been charged. Your balance lives on the server and is
        exactly as you left it.
      </Txt>

      <Txt variant="small" color={colors.textFaint}>
        If the backend is on another machine, enter its address:
      </Txt>
      <TextInput
        style={styles.hostInput}
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          setSaved(false);
        }}
        placeholder="192.168.1.20"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
      />

      {saved ? (
        <Txt variant="small" color={colors.textFaint}>
          Saved. Close the app completely and reopen it — the connection is
          configured once, when the app starts.
        </Txt>
      ) : null}

      <Button
        title={draft.trim() ? 'Save address' : 'Try again'}
        onPress={draft.trim() ? applyHost : onRetry}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  transparent: { flex: 1, backgroundColor: 'transparent' },
  unityLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hostInput: {
    alignSelf: 'stretch',
    marginHorizontal: space.lg,
    borderWidth: 1,
    borderColor: colors.textFaint,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    fontSize: 16,
    textAlign: 'center',
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.xl,
  },
});
