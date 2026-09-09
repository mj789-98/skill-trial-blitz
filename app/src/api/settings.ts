/**
 * Sound and haptics preferences.
 *
 * ── Why these live in React Native and not in Unity ──────────────────────────
 *
 * Unity does not remember them. It is told, every round, by the host.
 *
 * That is the same split the rest of the app uses: Unity renders a game and
 * records inputs, and everything that is *about the player* rather than about
 * the round lives on the React side, where the settings UI is and where the
 * platform's storage is. If Unity persisted its own copy there would be two
 * sources of truth, and the first bug would be a player muting the game in the
 * lobby and hearing it anyway.
 *
 * Stored in AsyncStorage rather than on the server: this is a per-device
 * preference, not part of an account. Muting on a phone should not mute a
 * tablet, and it is not worth a round trip on a screen that has to be instant.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface FeedbackSettings {
  sound: boolean;
  haptics: boolean;
}

const KEY = 'feedback-settings-v1';

/** Both on. A game that starts silent reads as broken, not as considerate. */
export const DEFAULT_SETTINGS: FeedbackSettings = { sound: true, haptics: true };

export async function loadSettings(): Promise<FeedbackSettings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(raw) as Partial<FeedbackSettings>;
    // Read field by field rather than trusting the shape. This is data written
    // by an older build of this app, which is a real source of surprises.
    return {
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_SETTINGS.sound,
      haptics: typeof parsed.haptics === 'boolean' ? parsed.haptics : DEFAULT_SETTINGS.haptics,
    };
  } catch {
    // Storage can be unavailable or corrupt. Defaults are always a valid answer,
    // and failing to read a preference must never stop a player from playing.
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: FeedbackSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Non-fatal on purpose. The toggle already moved on screen and applies to
    // this session; the only thing lost is that it will not survive a restart.
  }
}
