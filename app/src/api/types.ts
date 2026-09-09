/**
 * The shapes the backend returns.
 *
 * Hand-written rather than generated, because the backend is plain JavaScript
 * per the brief and has no types to generate from. These mirror the literal
 * objects returned by functions/blitz/*.js — if one drifts, the mismatch shows
 * up here first.
 *
 * ── Money ────────────────────────────────────────────────────────────────────
 *
 * Every amount is an integer number of cents and every field carrying one says
 * so in its name. There is no `price: 3.5` anywhere in this app. Formatting to
 * "$3.50" happens once, at the edge, in format.ts.
 */

import type { GameId } from '../unity/protocol';

export interface Game {
  game_id: GameId;
  display_name: string;
  /** False when Blitz is off OR when no active config backs it. */
  blitz_enabled: boolean;
  /**
   * The entry amounts the server will accept, from the active config. Read from
   * the server rather than held here so retuning the economics does not need an
   * app rebuild — see the comment on listGames.
   */
  stakeTiersCents: number[];
  /** The cap that applies while the target engine is still calibrating. */
  bootstrapMaxStakeCents: number | null;
}

export interface BlitzProfileSummary {
  game_id: GameId;
  rounds_played: number;
  best_score: number | null;
  target_score: number;
}

export interface Profile {
  playerId: string;
  displayName: string;
  balanceCents: number;
  profiles: BlitzProfileSummary[];
}

/** One breakpoint on the payout curve, as the payout screen shows it. */
export interface CurvePoint {
  score: number;
  /** Integer basis points. 10000 = 1.00x. The money path never sees the float. */
  multBp: number;
  /** The same number as a display multiplier, computed by the server. */
  multiplier: number;
  payoutCents: number;
}

/**
 * The offer. Binding at entry: `enter` copies this curve onto the round and
 * settlement reads only that copy.
 */
export interface Quote {
  quoteId: string;
  gameId: GameId;
  stakeCents: number;
  expiresAt: string;
  ttlSeconds: number;
  balanceCents: number;
  affordable: boolean;
  /** True while the target engine is still calibrating to this player. */
  bootstrap: boolean;
  /** The score at which the player gets their entry back. */
  breakEvenScore: number;
  /** What the engine is asking them to beat. */
  targetScore: number;
  curve: CurvePoint[];
  maxMultiplier: number;
}

export interface Round {
  roundId: string;
  /** Server-issued. The client generates its world from this and cannot re-roll. */
  seed: string;
  gameId: GameId;
  stakeCents: number;
  curve: CurvePoint[];
  balanceCents: number;
  /** True when this quote had already been entered — a retry, not a second charge. */
  alreadyStarted: boolean;
}

export interface Heartbeat {
  accepted: boolean;
  heartbeatScore: number;
  /** The server refused to believe the claim and bounded it by elapsed time. */
  clamped: boolean;
}

export interface Settlement {
  roundId: string;
  alreadySettled: boolean;
  /** What the server computed by replaying the trace. This is what was paid on. */
  score: number;
  claimedScore?: number | null;
  /** The client's score disagreed with the replay. A cheat signal, logged server-side. */
  scoreMismatch?: boolean;
  endReason?: string | null;
  multiplier: number;
  stakeCents: number;
  payoutCents: number;
  netCents?: number;
  settleReason: 'submit' | 'sweep' | 'invalid_trace' | string;
  balanceCents: number;
}
