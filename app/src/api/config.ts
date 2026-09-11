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

import { NativeModules } from 'react-native';

/**
 * Which backend this build talks to.
 *
 * ── Why a release build defaults to the cloud ────────────────────────────────
 *
 * Until the deployment existed, every build talked to the Firebase emulators on
 * the development machine, reached over `adb reverse` or the LAN. That works for
 * whoever holds the cable and for nobody else: a reviewer who installs the APK
 * has no emulators, no cable and no route to this laptop, so the app opened,
 * waited twelve seconds and said it could not reach the server -- every time,
 * with nothing they could do about it.
 *
 * So a RELEASE build talks to the deployed project, and a DEBUG build (Metro,
 * `__DEV__`) keeps talking to the local emulators, where the tests, the seed and
 * the fake money live. FORCE_BACKEND overrides either way, for the one case that
 * wants the other: a release APK aimed at local emulators.
 */
const FORCE_BACKEND: 'emulator' | 'cloud' | null = null;

export const BACKEND: 'emulator' | 'cloud' =
  FORCE_BACKEND ?? (__DEV__ ? 'emulator' : 'cloud');

/**
 * The Firebase project.
 *
 * `demo-skill-trial` is a demo project ID, which the emulators treat as fully
 * offline and which no real project backs; it matches .firebaserc's default.
 * `mobileroomgame` is the real project the functions are deployed to.
 */
export const PROJECT_ID = BACKEND === 'cloud' ? 'mobileroomgame' : 'demo-skill-trial';

/**
 * Force a specific host, ignoring everything below. Normally empty.
 *
 * Set this only for a release APK aimed at a named machine on a LAN. The
 * default release path (see resolveHost) is `localhost` plus `adb reverse`,
 * which needs no IP and therefore no rebuild.
 */
const EMULATOR_HOST_OVERRIDE = '';

export const PORTS = {
  auth: 9099,
  functions: 5001,
} as const;

/**
 * Cloud Functions region.
 *
 * asia-south1 (Mumbai), not the us-central1 default, because that is where the
 * database is. The Supabase pooler is in ap-south-1, and a single Blitz entry is
 * several round trips inside one transaction; from Iowa every one of them would
 * cross the planet twice. Must match setGlobalOptions in functions/index.js. The
 * emulator honours the region too, so both modes use the same value.
 */
export const REGION = 'asia-south1';

/**
 * The development machine's address, as reachable from wherever this code runs.
 */
/**
 * An address chosen on the device, applied before the first Firebase call.
 *
 * Module-level rather than passed around because resolveHost() is called from
 * inside the Firebase SDK setup, which has no access to React state. It is set
 * once at boot, from storage, before anything touches the network.
 */
let runtimeHost: string | null = null;

/** Apply a device-chosen address. Must run before the first API call. */
export function setRuntimeHost(host: string | null): void {
  runtimeHost = host;
}

export function resolveHost(): string {
  if (runtimeHost) return runtimeHost;
  if (EMULATOR_HOST_OVERRIDE) return EMULATOR_HOST_OVERRIDE;

  const host = devServerHost();
  if (host) return host;

  // Release build: no Metro to ask.
  //
  // `localhost` rather than the 10.0.2.2 emulator alias, because it is the one
  // answer that works everywhere WITHOUT editing this file and rebuilding:
  //
  //     adb reverse tcp:5001 tcp:5001
  //     adb reverse tcp:9099 tcp:9099
  //
  // forwards the device's localhost to the development machine, over the USB
  // cable, on a physical device and an emulator alike. It needs no LAN address,
  // survives the machine changing networks, crosses no firewall, and does not
  // expose the emulator suite to anything.
  //
  // 10.0.2.2 would have been correct for exactly one target — an Android
  // emulator — which is the case a reviewer is least likely to be using for a
  // recording.
  return 'localhost';
}

/**
 * The resolved host, plus how it was arrived at, for an error a human reads.
 *
 * `localhost` is the answer most likely to be on screen when something is
 * wrong, and on its own it is actively misleading — a player reading it would
 * reasonably think the app was talking to itself. Saying which mechanism is
 * supposed to make localhost mean the development machine turns a dead end
 * into the actual next step.
 */
export function describeHost(): string {
  if (BACKEND === 'cloud') return `the game server (${PROJECT_ID}, ${REGION})`;
  const host = resolveHost();
  if (runtimeHost) return `${host} (set on this device)`;
  if (host === 'localhost') return 'localhost (via adb reverse over USB)';
  return host;
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
 * Against the emulators the apiKey is a placeholder: a demo project has no real
 * one, and the Auth emulator does not check it.
 *
 * Against the cloud it is the real key of the web app registered in
 * `mobileroomgame`, committed on purpose. A Firebase web API key is not a
 * credential -- it identifies the project to Google's endpoints and grants
 * nothing by itself. Every callable here checks a verified ID token, and the
 * database is not reachable from the client at all. Keeping it out of the repo
 * would protect nothing and would make the APK impossible to build from a clean
 * clone.
 */
export const FIREBASE_CONFIG =
  BACKEND === 'cloud'
    ? {
        apiKey: 'AIzaSyCSmjUVC2nS83jos2WeAGpkY3o1rcThE0I',
        authDomain: 'mobileroomgame.firebaseapp.com',
        projectId: 'mobileroomgame',
        appId: '1:97905244197:web:2779925abc137ee33527cc',
        messagingSenderId: '97905244197',
      }
    : {
        apiKey: 'demo-api-key',
        authDomain: `${PROJECT_ID}.firebaseapp.com`,
        projectId: PROJECT_ID,
        appId: '1:000000000000:android:0000000000000000000000',
      };
