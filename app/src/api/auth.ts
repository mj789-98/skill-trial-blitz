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
 * That password is in the repo on purpose: the alternative — a credential a
 * reviewer has to be sent separately — makes "install and play" impossible.
 *
 * ── What changes once there is a real project ────────────────────────────────
 *
 * Against the emulator a public password costs nothing. Against the deployed
 * project it is a shared account anyone can sign into, and anyone who can sign
 * in can CHANGE ITS PASSWORD. Nothing is stolen that way — the money is fake and
 * every callable acts only on the caller's own uid — but every other install
 * would then fail to sign in, and the app would stop working for every reviewer
 * at once because of one person.
 *
 * So the shared account stays the normal path, and if it has been taken away —
 * the email exists but the password no longer matches, or password sign-in has
 * been switched off — this install falls back to an anonymous account of its
 * own. The player gets a working app with a separate balance instead of a dead
 * one.
 */

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
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
    console.warn('[auth] signing in with the shared account');
    const cred = await signInWithEmailAndPassword(a, TEST_ACCOUNT.email, TEST_ACCOUNT.password);
    return cred.user;
  } catch (err) {
    const code = (err as { code?: string }).code;

    // Password sign-in is switched off for this project. The shared account
    // cannot work at all, so do not try to create it either.
    if (code === 'auth/operation-not-allowed') {
      console.warn('[auth] password sign-in is off; falling back to anonymous');
      return (await signInAnonymously(a)).user;
    }

    const missing =
      code === 'auth/user-not-found' ||
      // Modern Identity Toolkit collapses "no such user" and "wrong password"
      // into one code so an attacker cannot enumerate accounts. Against the
      // emulator with a known password, treating it as "not created yet" is the
      // only reading that can be true.
      code === 'auth/invalid-credential';
    if (!missing) throw err;

    try {
      const cred = await createUserWithEmailAndPassword(
        a,
        TEST_ACCOUNT.email,
        TEST_ACCOUNT.password
      );
      return cred.user;
    } catch (createErr) {
      // The account exists, yet the published password did not match it: the
      // password has been changed out from under every install. See the header.
      if ((createErr as { code?: string }).code === 'auth/email-already-in-use') {
        console.warn('[auth] shared account password changed; falling back to anonymous');
        return (await signInAnonymously(a)).user;
      }
      throw createErr;
    }
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
