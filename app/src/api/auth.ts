/**
 * Sign-in.
 *
 * ── Why a fixed test account and not anonymous auth ──────────────────────────
 *
 * The brief asks for "a test account we can log in with". Anonymous auth would
 * be one line and would technically work, but it gives every install a fresh
 * uid — and a fresh uid means a fresh balance, an empty ledger, and a target
 * engine that has never seen this player. Which is the opposite of what a
 * reviewer needs: they should be able to open the app, play a few rounds, close
 * it, reopen it, and find the same money and the same calibrated targets.
 *
 * So there is one seeded account with a password anyone reading the README can
 * use. It is a real Firebase Auth user against the Auth emulator, created on
 * first run if it does not exist.
 *
 * That password is in the repo on purpose. It authenticates against an emulator
 * on the reviewer's own machine holding fake money, and the alternative — a
 * credential they have to be sent separately — makes "clone and run" impossible.
 * Nothing here is used against a real project.
 */

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';

import { auth } from './firebase';

export const TEST_ACCOUNT = {
  email: 'player@skilltrial.test',
  password: 'blitz-trial-2026',
} as const;

/**
 * Sign in as the seeded test player, creating the account on first run.
 *
 * The create path is tried only after sign-in fails with a missing user, so
 * repeat launches take the cheap path and a wrong password does not silently
 * become an account creation.
 */
export async function signInAsTestPlayer(): Promise<User> {
  const a = auth();
  try {
    const cred = await signInWithEmailAndPassword(a, TEST_ACCOUNT.email, TEST_ACCOUNT.password);
    return cred.user;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const missing =
      code === 'auth/user-not-found' ||
      // Modern Identity Toolkit collapses "no such user" and "wrong password"
      // into one code so an attacker cannot enumerate accounts. Against the
      // emulator with a known password, treating it as "not created yet" is the
      // only reading that can be true.
      code === 'auth/invalid-credential';
    if (!missing) throw err;

    const cred = await createUserWithEmailAndPassword(
      a,
      TEST_ACCOUNT.email,
      TEST_ACCOUNT.password
    );
    return cred.user;
  }
}

export function signOut(): Promise<void> {
  return fbSignOut(auth());
}

/**
 * Subscribe to the signed-in user.
 *
 * Fires once with the restored user (or null) as soon as persistence has been
 * read, which is what the app waits on before deciding whether to show a lobby
 * or a sign-in.
 */
export function watchUser(onChange: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth(), onChange);
}
