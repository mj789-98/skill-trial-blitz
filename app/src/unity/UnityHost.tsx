/**
 * The one place the Unity view is mounted.
 *
 * Everything about the embed that is fiddly lives here so the screens above it
 * stay ordinary React: mounting, the READY handshake, message parsing, the
 * focus-restore workaround, and unmount teardown.
 *
 * ── What this component is NOT allowed to do ─────────────────────────────────
 *
 * It does not call the backend, and it does not decide anything about money. It
 * turns Unity messages into typed callbacks and hands them upward. The screen
 * that owns the round is what talks to the API. Keeping that split means the
 * trust boundary is visible in the file layout: nothing under src/unity/ has any
 * reason to import the API client.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus, StyleSheet, View } from 'react-native';
import UnityView from '@azesmway/react-native-unity';

import {
  encodeToUnity,
  parseFromUnity,
  UNITY_BRIDGE_METHOD,
  UNITY_BRIDGE_OBJECT,
  type FromUnity,
  type RoundEndMessage,
  type ScoreTickMessage,
  type ToUnity,
} from './protocol';

export interface UnityHostHandle {
  /** Send a typed message to Unity. No-ops until Unity has reported READY. */
  send(message: ToUnity): boolean;
  /** Whether Unity has completed its handshake. */
  isReady(): boolean;
}

interface Props {
  /** Unity finished loading and can accept a START_ROUND. */
  onReady?: () => void;
  /** Throttled progress. The owning screen forwards these to the heartbeat. */
  onScoreTick?: (msg: ScoreTickMessage) => void;
  /** The run ended. Exactly one of these fires per mounted round. */
  onRoundEnd?: (msg: RoundEndMessage) => void;
  /** Unity hit something unrecoverable. */
  onError?: (message: string) => void;
  /** Anything that arrived but was not understood. Useful while iterating. */
  onUnhandled?: (raw: string) => void;
}

const UnityHost = forwardRef<UnityHostHandle, Props>(function UnityHost(
  { onReady, onScoreTick, onRoundEnd, onError, onUnhandled },
  ref
) {
  const unityRef = useRef<React.ComponentRef<typeof UnityView>>(null);
  const [ready, setReady] = useState(false);

  // The SAME fact as `ready`, held in a ref because the two are needed at
  // different times.
  //
  // `onReady` is invoked in the same tick as `setReady(true)`, and the owning
  // screen responds by immediately calling `send(START_ROUND)`. At that moment
  // React has not re-rendered, so the imperative handle below still closes over
  // `ready === false` — the send is refused, `started` never flips, and the app
  // sits on "Loading the course" forever with the stake already debited. Nothing
  // errors; the handshake just completes into a stale closure.
  //
  // The ref is written synchronously, before onReady is raised, so a send made
  // from inside that callback sees the truth. The state is kept because it is
  // what drives the re-render.
  const readyRef = useRef(false);

  // Callbacks are held in refs so the message handler identity stays stable.
  // Without this, a parent re-render mid-round would tear down and re-create the
  // handler — and with it, potentially, the Unity view.
  const handlers = useRef({ onReady, onScoreTick, onRoundEnd, onError, onUnhandled });
  handlers.current = { onReady, onScoreTick, onRoundEnd, onError, onUnhandled };

  // A round must produce exactly one terminal outcome. Unity should only ever
  // send one ROUND_END, but this component sits on the boundary with a process
  // that may be tampered with, so it enforces the invariant rather than trusting
  // it: a duplicate here would become a duplicate submit upstream.
  //
  // Reset when a START_ROUND goes out, NOT on mount. This component now lives
  // for the whole app session (see RoundScreen's header), so a latch that only
  // cleared on mount would clear exactly once — and every round after the first
  // would have its ROUND_END silently swallowed. The player would watch Unity's
  // own death overlay sit there while React never advanced to the result screen.
  //
  // Tying it to START_ROUND is also the honest definition: the latch guards one
  // round, so it should reset when a round begins.
  const roundEnded = useRef(false);

  const handleUnityMessage = useCallback((event: { nativeEvent: { message: string } }) => {
    const raw = event?.nativeEvent?.message;
    if (typeof raw !== 'string') return;

    const msg: FromUnity | null = parseFromUnity(raw);
    if (!msg) {
      handlers.current.onUnhandled?.(raw);
      return;
    }

    switch (msg.type) {
      case 'READY':
        // Ref first, then state, then the callback. The order is the fix: the
        // callback synchronously calls back into send().
        readyRef.current = true;
        setReady(true);
        handlers.current.onReady?.();
        break;

      case 'SCORE_TICK':
        if (roundEnded.current) return;
        handlers.current.onScoreTick?.(msg);
        break;

      case 'ROUND_END':
        if (roundEnded.current) return;
        roundEnded.current = true;
        handlers.current.onRoundEnd?.(msg);
        break;

      case 'ERROR':
        handlers.current.onError?.(msg.message);
        break;
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      isReady: () => readyRef.current,
      send(message: ToUnity) {
        const view = unityRef.current;
        if (!view) return false;
        // Sending before READY is dropped by Unity anyway; returning false lets
        // the caller retry on the handshake rather than losing a round silently.
        if (!readyRef.current && message.type === 'START_ROUND') return false;

        if (message.type === 'START_ROUND') roundEnded.current = false;

        view.postMessage(UNITY_BRIDGE_OBJECT, UNITY_BRIDGE_METHOD, encodeToUnity(message));
        return true;
      },
    }),
    // Reads only refs, so the handle never needs rebuilding — which is also why
    // it can no longer go stale.
    []
  );

  // `ready` drives re-render only; every decision reads readyRef.
  void ready;

  useEffect(() => {
    // Returning from background can leave the Unity surface black: the player
    // sees a dead screen with their stake already debited. The embed exposes
    // windowFocusChanged for exactly this, and it has to be re-asserted on the
    // way back to the foreground.
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') return;
      unityRef.current?.windowFocusChanged?.(true);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // Captured on mount rather than read in the cleanup: by the time cleanup
    // runs React has already detached the node, so unityRef.current is null and
    // the pause below would silently never happen.
    const view = unityRef.current;

    // Focus, NOT resumeUnity.
    //
    // The Unity player is a process-wide singleton: this component mounting and
    // unmounting does not create or destroy it. So anything done to the player
    // on unmount outlives the component that did it, and the next round inherits
    // that state.
    //
    // The obvious pairing is pauseUnity(true) on unmount and resumeUnity() on
    // mount. Both halves of that are wrong here, and the device proved it twice:
    //
    //   - With only the pause, round two mounted onto a still-suspended player:
    //     black surface, no input, and the run silently idled out. Only the
    //     FIRST round of an app session ever worked.
    //   - Adding resumeUnity() to fix that CRASHED the process — SIGTRAP on the
    //     UnityMain thread, 68ms after the call, every time.
    //
    // So the pause/resume pair is not used at all. windowFocusChanged is the
    // lifecycle signal Unity already handles thousands of times a session (every
    // app switch, every notification shade pull), which makes it the boring,
    // well-trodden path rather than the clever one. Unity throttles its own
    // rendering when unfocused, so the battery argument for pausing is mostly
    // served anyway.
    //
    // Leaving the player running is also what `androidKeepPlayerMounted` is FOR:
    // pausing it between rounds was quietly fighting the setting that makes
    // entering a round instant.
    view?.windowFocusChanged?.(true);

    return () => {
      // Tell Unity it is no longer the focused surface. Not a pause: see above.
      view?.windowFocusChanged?.(false);
    };
  }, []);

  return (
    <View style={styles.container}>
      <UnityView
        ref={unityRef}
        style={styles.unity}
        // Keeping the player mounted across screen transitions is what makes
        // going from the payout screen into a round feel instant instead of
        // showing a load.
        androidKeepPlayerMounted
        fullScreen={false}
        onUnityMessage={handleUnityMessage}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  unity: { flex: 1 },
});

export default UnityHost;
