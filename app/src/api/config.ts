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
 * So we read it from Metro instead. In a debug build, `SourceCode.scriptURL` is
 * the bundle URL the app was actually loaded from, which is by definition the
 * development machine at an address this device can already reach. It is the
 * same answer for all three cases, and it is derived rather than configured.
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

  // Debug builds: ask Metro where it served the bundle from.
  const scriptURL: string | undefined = NativeModules?.SourceCode?.scriptURL;
  const host = scriptURL ? hostOf(scriptURL) : null;
  if (host) return host;

  // Release build, no override. The Android emulator alias is the least-wrong
  // default; on a device this fails to connect, which is the intended outcome.
  return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
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
