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
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, initializeAuth, type Auth } from 'firebase/auth';
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

import { FIREBASE_CONFIG, PORTS, REGION, resolveHost } from './config';

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let functionsInstance: Functions | null = null;

export function app(): FirebaseApp {
  if (appInstance) return appInstance;
  appInstance = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  return appInstance;
}

export function auth(): Auth {
  if (authInstance) return authInstance;

  // initializeAuth rather than getAuth: React Native has no default persistence,
  // and without this the player is signed out every cold start — which in a cash
  // app means their balance appears to vanish.
  authInstance = initializeAuth(app(), {
    persistence: getReactNativePersistence(AsyncStorage),
  });

  connectAuthEmulator(authInstance, `http://${resolveHost()}:${PORTS.auth}`, {
    disableWarnings: true,
  });
  return authInstance;
}

export function functions(): Functions {
  if (functionsInstance) return functionsInstance;
  functionsInstance = getFunctions(app(), REGION);
  connectFunctionsEmulator(functionsInstance, resolveHost(), PORTS.functions);
  return functionsInstance;
}
