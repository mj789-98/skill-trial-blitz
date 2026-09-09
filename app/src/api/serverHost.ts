/**
 * The backend address, as chosen on the device.
 *
 * ── Why this needs to exist ─────────────────────────────────────────────────
 *
 * The release APK reaches the emulators through `adb reverse`, which is a
 * tunnel over the USB cable. That is the right default — it needs no LAN
 * address, crosses no firewall, and exposes the emulator suite to nothing. But
 * it has one property that only shows up once somebody actually holds the
 * phone: unplug the cable and there is no backend, because `localhost` on a
 * phone is the phone.
 *
 * That is not a hypothetical. It is how the app behaved the first time it was
 * opened away from the development machine, and it is also how it would behave
 * for a reviewer who installs the APK and never plugs in at all — which is the
 * case the brief cares most about, since it says outright that they may not be
 * able to build the project themselves.
 *
 * So the address is settable on the device and remembered. No rebuild, no
 * editing a constant, no toolchain.
 *
 * ── Why a restart is required after changing it ─────────────────────────────
 *
 * `connectAuthEmulator` and `connectFunctionsEmulator` are one-shot: they
 * configure an SDK instance at creation and there is no supported way to
 * re-point a live one. Rather than pretend otherwise with a reset that would
 * silently keep the old host, the UI asks for a restart and means it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'server-host-v1';

/** Accepts a hostname or IPv4 address, with an optional port stripped off. */
export function normaliseHost(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const withoutPort = trimmed.replace(/:\d+$/, '');
  if (!withoutPort) return null;
  // Deliberately permissive: hostnames, .local names and IPv4 all pass. The
  // real validation is whether the next request succeeds, and the player finds
  // that out immediately.
  if (!/^[A-Za-z0-9._-]+$/.test(withoutPort)) return null;
  return withoutPort;
}

export async function loadServerHost(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? normaliseHost(raw) : null;
  } catch {
    return null;
  }
}

export async function saveServerHost(host: string | null): Promise<void> {
  try {
    if (host) await AsyncStorage.setItem(KEY, host);
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // Non-fatal: the address still applies to this session.
  }
}
