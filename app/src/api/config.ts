/**
 * Where the backend lives.
 *
 * ── Why the Firebase JS SDK and not @react-native-firebase ───────────────────
 *
 * @react-native-firebase needs a google-services.json, which only a real
 * Firebase project can issue. This trial runs against `demo-skill-trial` — a
 * demo project ID, which the Firebase emulators treat as fully offline and which
 * no real project backs. The JS SDK takes a plain config object and can be
 * pointed at an emulator explicitly, so the whole app runs with no cloud
 * project, no service account, and no native rebuild.
 *
 * The trade is real and worth stating: the JS SDK's auth persistence goes
 * through AsyncStorage rather than the native keychain, and there is no native
 * crash reporting. For a trial that has to be checked out and run by someone
 * else on a machine we do not control, "it works from a clean clone" wins.
 *
 * ── Finding the host machine from a real device ──────────────────────────────
 *
 * The emulators bind to the development machine. What address that is depends on
 * where the app is running:
 *
 *   Android emulator   10.0.2.2      (the host, as seen from inside the AVD)
 *   physical device    192.168.x.x   (the host's LAN address)
 *   iOS simulator      localhost
 *
 * Hard-coding any one of those breaks the other two, and the brief asks for a
 * recording on a REAL DEVICE — the case a hard-coded `localhost` gets wrong.
 *
 * So we read it from Metro instead. In a debug build the bundle URL is, by
 * definition, the development machine at an address this device can already
 * reach. It is the same answer for all three cases, and it is derived rather
 * than configured.
 *
 * ── Getting that URL under the New Architecture ──────────────────────────────
 *
 * `NativeModules.SourceCode.scriptURL` is the answer every tutorial gives, and
 * on React Native 0.86 it is `undefined`. 0.86 is bridgeless-only, and the
 * legacy NativeModules proxy no longer exposes SourceCode — so the lookup does
 * not throw, it silently returns nothing, and the fallback below takes over.
 *
 * That failure was invisible until the app ran on a real phone: an Android
 * emulator reaches the host at 10.0.2.2, which is exactly what the fallback
 * returns, so every simulator test passed. On hardware it produced
 * `auth/network-request-failed` and a splash screen that never left.
 *
 * `getDevServer()` is the bridgeless-safe equivalent and is what the RN dev menu
 * itself uses. Both are tried, in that order.
 *
 * A release build has no Metro, so `EMULATOR_HOST_OVERRIDE` exists for the APK:
 * set it, rebuild, and the release binary talks to a named host.
 */

import { NativeModules, Platform } from 'react-native';

/** The demo project. Matches .firebaserc, and is what the emulators expect. */
export const PROJECT_ID = 'demo-skill-trial';

/**
 * Set this before building a release APK that should reach a specific machine.
 * Left empty, a release build falls back to the Android emulator address, which
 * is wrong on a physical device — deliberately, so it fails loudly rather than
 * silently pointing at nothing.
 */
const EMULATOR_HOST_OVERRIDE = '';

export const PORTS = {
  auth: 9099,
  functions: 5001,
} as const;

/** Cloud Functions region. Defaults for onCall are us-central1. */
export const REGION = 'us-central1';

/**
 * The development machine's address, as reachable from wherever this code runs.
 */
export function resolveHost(): string {
  if (EMULATOR_HOST_OVERRIDE) return EMULATOR_HOST_OVERRIDE;

  const host = devServerHost();
  if (host) return host;

  // Release build, no override. The Android emulator alias is the least-wrong
  // default; on a device this fails to connect, which is the intended outcome.
  return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
}

/**
 * The host Metro served this bundle from, or null in a release build.
 *
 * Two sources, because neither is available everywhere: `getDevServer` is the
 * bridgeless one and is what actually works on 0.86; `SourceCode.scriptURL` is
 * kept as a fallback for any environment where the internal path moves. Both
 * are wrapped, because a diagnostic that throws is worse than one that returns
 * nothing.
 */
function devServerHost(): string | null {
  try {
    // A deep import, and lint says so. There is no top-level export for this —
    // React Native's own dev menu reaches for the same path — so the choice is
    // this or no way to find Metro at all under bridgeless. Kept narrow: one
    // require, wrapped, with a fallback below if the path ever moves.
    // eslint-disable-next-line @react-native/no-deep-imports
    const getDevServer = require('react-native/Libraries/Core/Devtools/getDevServer');
    const server = (getDevServer.default ?? getDevServer)();
    if (server?.bundleLoadedFromServer && server.url) {
      const host = hostOf(server.url);
      if (host) return host;
    }
  } catch {
    // Not a debug build, or the internal module moved. Fall through.
  }

  try {
    const scriptURL: string | undefined = NativeModules?.SourceCode?.scriptURL;
    if (scriptURL) return hostOf(scriptURL);
  } catch {
    // Same.
  }

  return null;
}

/** Pull the hostname out of a bundle URL like http://192.168.1.7:8081/index.bundle. */
function hostOf(url: string): string | null {
  const match = /^[a-z]+:\/\/([^/:]+)/i.exec(url);
  if (!match) return null;
  const host = match[1];
  // A device that loaded the bundle from localhost is a simulator; anything
  // else is a real address and can be used as-is.
  return host;
}

/**
 * The Firebase config.
 *
 * The apiKey is a placeholder because a demo project has no real one, and the
 * Auth emulator does not check it. Committing a placeholder is safer than
 * committing a live key — an apiKey is not a secret, but it does identify a real
 * project, and this repo is public.
 */
export const FIREBASE_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
  appId: '1:000000000000:android:0000000000000000000000',
};
