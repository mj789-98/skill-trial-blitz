/**
 * The design tokens. Small on purpose.
 *
 * Dark by default rather than following the system: the game renders a bright
 * outdoor scene, and a light chrome around it makes the transition into a round
 * feel like a flashbang. Committing to one palette also means the money screens
 * and the game agree about what "background" is, so the seam between React and
 * Unity is less visible.
 *
 * The accent is used for one thing only — money going the player's way. Nothing
 * else in the app is allowed to be green, so a green number is always a payout.
 */

export const colors = {
  bg: '#0E1116',
  surface: '#171C24',
  surfaceHigh: '#212936',
  border: '#2C3646',

  text: '#F2F5F9',
  textMuted: '#93A1B5',
  textFaint: '#5C6B80',

  /** Money in the player's favour. Reserved. */
  win: '#4ADE80',
  /** Money leaving. Used for the stake and for a loss. */
  loss: '#F87171',
  /** The one interactive accent. Buttons, the live curve marker. */
  accent: '#FFB020',
  accentText: '#1A1204',
} as const;

/** A 4pt grid. Every margin in the app is one of these. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const type = {
  /** A settled payout. The largest number the app ever shows. */
  hero: { fontSize: 48, fontWeight: '800' as const, letterSpacing: -1 },
  title: { fontSize: 26, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 15, fontWeight: '500' as const },
  small: { fontSize: 13, fontWeight: '500' as const },
  /** Section labels and units. Uppercased at the call site, not here. */
  label: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1.2 },
} as const;
