/**
 * A short fade-and-rise whenever the app moves to a different screen.
 *
 * ── Why this exists now and did not before ───────────────────────────────────
 *
 * The app has no navigator (DECISIONS D-016): the screens are a state machine,
 * because a stack navigator unmounts the screen it leaves, and the Unity player
 * must never be unmounted. Dropping the navigator also dropped its built-in
 * transitions, and nothing replaced them — so every screen change was a hard
 * cut. That was a cost of losing the navigator, not of the state machine; this
 * restores it without bringing a navigator back.
 *
 * ── What it animates, and what it must never touch ───────────────────────────
 *
 * Only the screen layer. Unity sits BELOW it in App.tsx and is never animated,
 * covered differently, or remounted — the reason for having no navigator is left
 * exactly as it was.
 *
 * The incoming screen fades in over the app's own opaque background, not over
 * Unity, so a menu change never flashes the last frame of a game through a
 * half-transparent screen. The outgoing screen is not cross-faded: it is
 * replaced at opacity zero and the new one rises in. Cheaper, and nothing is
 * ever drawn twice.
 *
 * The wrapper passes touches through (`box-none`), so during a round the game
 * underneath still receives every tap and swipe; only the round's own HUD fades.
 *
 * ── Motion is optional ───────────────────────────────────────────────────────
 *
 * With the phone's Reduce motion setting on, screens switch instantly, exactly
 * as they did before this existed.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet } from 'react-native';

/** Long enough to read as movement, short enough never to feel like waiting. */
const DURATION_MS = 220;

/** How far the incoming screen rises, in points. A nudge, not a slide. */
const RISE = 14;

export function ScreenTransition({
  screenKey,
  children,
}: {
  /** Changes only when the screen does. A refresh of the same screen must not animate. */
  screenKey: string;
  children: React.ReactNode;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  // Layout effect, not a plain effect: the value has to be back at zero BEFORE
  // the new screen is painted, or it shows fully for one frame and then blinks
  // out to start its fade — a flicker on every screen change.
  useLayoutEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: DURATION_MS,
      easing: Easing.out(Easing.cubic),
      // Opacity and transform only, so the whole animation runs on the native
      // side and cannot stutter when JavaScript is busy loading the next screen.
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [screenKey, reduceMotion, progress]);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.fill,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [RISE, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** Follows the phone's Reduce motion setting, including changes while the app is open. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduce(value);
      })
      .catch(() => {
        // Unknown means animate; the animation is short and harmless.
      });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  return reduce;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
