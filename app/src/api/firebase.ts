/**
 * Firebase initialisation — one app, one auth instance, one functions instance.
 *
 * Everything is lazy and memoised. Module-level `initializeApp()` runs before
 * React does, which makes a config mistake surface as a blank screen with a
 * stack trace in Metro instead of an error a screen can render.
 *
 * ── Emulator wiring ──────────────────────────────────────────────────────────
 *
 * Both emulator connections are made exactly once, immediately after the
 * instance is created. Calling connect*Emulator twice on the same instance
 * throws, and calling it after the first request has gone out is silently too
 * late — memoising the instance is what makes both impossible.
 *
 * Only when BACKEND is 'emulator'. A cloud build talks to the endpoints the SDK
 * already knows from FIREBASE_CONFIG, and connecting it to an emulator host
 * would send a reviewer's sign-in to a laptop they cannot reach.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, initializeAuth, type Auth } from 'firebase/auth';
// `getReactNativePersistence` only exists on @firebase/auth's react-native
// entry point, and the `firebase/auth` umbrella has no react-native condition
// in its exports map — so it resolves, and type-checks, only from here. Both
// specifiers land on the same copy of @firebase/auth, so this is one module,
// not two auth instances.
import { getReactNativePersistence } from '@firebase/auth';
import {
  connectFunctionsEmulator,
  getFunctions,
  type Functions,
} from 'firebase/functions';

import { BACKEND, FIREBASE_CONFIG, PORTS, REGION, resolveHost } from './config';

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let functionsInstance: Functions | null = null;

export function app(): FirebaseApp {
  if (appInstance) return appInstance;
  appInstance = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  console.warn(`[firebase] backend=${BACKEND} project=${FIREBASE_CONFIG.projectId} region=${REGION}`);
  return appInstance;
}

export function auth(): Auth {
  if (authInstance) return authInstance;

  try {
    // initializeAuth rather than getAuth: React Native has no default
    // persistence, and without this the player is signed out every cold start —
    // which in a cash app means their balance appears to vanish.
    authInstance = initializeAuth(app(), {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch (err) {
    // The JS context reloaded but the native Firebase app survived, so Auth is
    // already initialised and initializeAuth throws. Fast Refresh does this
    // constantly during development, and React Native also reloads JS on some
    // recoverable errors in production — so this is a real path, not just a
    // development annoyance. The existing instance already has the persistence
    // configured above; adopt it rather than starting a second one.
    if ((err as { code?: string })?.code !== 'auth/already-initialized') throw err;
    const existing = getAuth(app());
    authInstance = existing;
    return existing;
  }

  if (BACKEND === 'emulator') {
    connectAuthEmulator(authInstance, `http://${resolveHost()}:${PORTS.auth}`, {
      disableWarnings: true,
    });
  }
  return authInstance;
}

export function functions(): Functions {
  if (functionsInstance) return functionsInstance;
  functionsInstance = getFunctions(app(), REGION);
  if (BACKEND === 'emulator') {
    connectFunctionsEmulator(functionsInstance, resolveHost(), PORTS.functions);
  }
  return functionsInstance;
}
