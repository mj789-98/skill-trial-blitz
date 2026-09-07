/**
 * The React Native ↔ Unity message contract.
 *
 * This file is the single source of truth for the bridge. `RNBridge.cs` mirrors
 * it on the Unity side; if you change a message here, change it there too.
 *
 * ── The trust boundary ────────────────────────────────────────────────────────
 *
 * Unity is a renderer and an input recorder. It does not know that money exists.
 * It holds no auth token, no API base URL, and makes no network call of its own.
 * Everything that touches a balance goes: Unity → RN → Cloud Function → Postgres.
 *
 * That is a deliberate choice and not just tidiness. It means the surface an
 * attacker can reach by tampering with the Unity runtime is exactly one thing —
 * the contents of a `ROUND_END` message — and that message is not trusted: the
 * server replays the input trace against the seed it issued and computes the
 * score itself. See `functions/sim/chickenRun.js`.
 *
 * ── Why a seed goes down and a trace comes up ─────────────────────────────────
 *
 * The server issues `seed`. The client generates its entire world from it, so a
 * player cannot roll for a favourable one. The client's only output is the list
 * of inputs it made, indexed by fixed-step tick. The server replays those inputs
 * against the same seed and derives the score. The client's own `score` field is
 * carried for comparison and logging only — a mismatch is a cheat signal, never
 * a payout input.
 */

/** Fixed simulation step. The sim advances in whole ticks and never reads frame time. */
export const TICK_HZ = 50;

/** Which mini-game is being played. Matches `games.game_id` in Postgres. */
export type GameId = 'chicken_run' | 'pop_shot';

/**
 * Blitz wraps a game; practice does not. The mode is decided by the server
 * (`games.blitz_enabled` plus a funded round), never by the client asking nicely.
 */
export type GameMode = 'blitz' | 'practice';

/** Every way a round can stop. There are no others. */
export type RoundEndReason =
  /** The player held Cash Out and banked. Score counts. */
  | 'cash_out'
  /** Hit by a vehicle, drowned, or crushed. Score is zero, per the rules. */
  | 'death'
  /** Idled too long and the advancing kill line caught up. Treated as a death. */
  | 'idle'
  /** RN told Unity to stop (app backgrounded past the limit, or a forced abort). */
  | 'aborted';

// ─────────────────────────────────────────────────────────────────────────────
// RN → Unity
//
// Delivered via the Fabric command:
//   Commands.postMessage(ref, 'RNBridge', 'OnMessage', JSON.stringify(msg))
// 'RNBridge' is the name of the GameObject in the Unity scene; 'OnMessage' is a
// public method on the MonoBehaviour attached to it.
// ─────────────────────────────────────────────────────────────────────────────

export interface StartRoundMessage {
  type: 'START_ROUND';
  gameId: GameId;
  mode: GameMode;
  /**
   * Server-issued. Seeds the world PRNG. Sent as a string because it is a 32-bit
   * unsigned value and JS numbers are floats — a string avoids any chance of the
   * client and server disagreeing about the seed itself.
   */
  seed: string;
  /** Correlates the trace with the funded round. Opaque to Unity. */
  roundId: string;
}

export interface AbortMessage {
  type: 'ABORT';
}

export interface SetAudioMessage {
  type: 'SET_AUDIO';
  sound: boolean;
  music: boolean;
  haptics: boolean;
}

export type ToUnity = StartRoundMessage | AbortMessage | SetAudioMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Unity → RN
//
// Delivered via the `onUnityMessage` prop as a JSON string.
// ─────────────────────────────────────────────────────────────────────────────

/** Unity has loaded its scene and can accept START_ROUND. */
export interface ReadyMessage {
  type: 'READY';
}

/**
 * Throttled progress ping, roughly once a second, forwarded by RN to the
 * heartbeat endpoint.
 *
 * This is what makes "an interrupted round settles at the last score the server
 * saw" a real outcome rather than a hand-wave: if the app is killed mid-round,
 * the sweeper has an acknowledged score to settle against.
 */
export interface ScoreTickMessage {
  type: 'SCORE_TICK';
  score: number;
  tick: number;
}

export interface RoundEndMessage {
  type: 'ROUND_END';
  reason: RoundEndReason;
  /** The client's claim. Compared against the replay; never paid on directly. */
  score: number;
  /** Total ticks simulated. With wall-clock elapsed time this bounds timing attacks. */
  tick: number;
  /** base64-packed (tick, action) pairs. A few hundred bytes for a full run. */
  trace: string;
}

/** Unity hit an unrecoverable error. RN aborts the round rather than hanging. */
export interface ErrorMessage {
  type: 'ERROR';
  message: string;
}

export type FromUnity =
  | ReadyMessage
  | ScoreTickMessage
  | RoundEndMessage
  | ErrorMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/** The GameObject in the Unity scene that receives RN messages. */
export const UNITY_BRIDGE_OBJECT = 'RNBridge';
/** The public method on that GameObject. */
export const UNITY_BRIDGE_METHOD = 'OnMessage';

export function encodeToUnity(msg: ToUnity): string {
  return JSON.stringify(msg);
}

/**
 * Parse a message from Unity.
 *
 * Returns null rather than throwing on anything malformed. A bad frame from the
 * game view must not be able to take down the JS side — and since a tampered
 * Unity build can send whatever it likes, this is a boundary that has to assume
 * hostile input even though the payload is not itself trusted for payout.
 */
export function parseFromUnity(raw: string): FromUnity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case 'READY':
      return { type: 'READY' };

    case 'SCORE_TICK':
      if (!isCount(msg.score) || !isCount(msg.tick)) return null;
      return { type: 'SCORE_TICK', score: msg.score, tick: msg.tick };

    case 'ROUND_END':
      if (!isCount(msg.score) || !isCount(msg.tick)) return null;
      if (typeof msg.trace !== 'string') return null;
      if (!isEndReason(msg.reason)) return null;
      return {
        type: 'ROUND_END',
        reason: msg.reason,
        score: msg.score,
        tick: msg.tick,
        trace: msg.trace,
      };

    case 'ERROR':
      return {
        type: 'ERROR',
        message: typeof msg.message === 'string' ? msg.message : 'unknown Unity error',
      };

    default:
      return null;
  }
}

/** A non-negative, finite integer. Scores and ticks are counts, never floats. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isEndReason(v: unknown): v is RoundEndReason {
  return v === 'cash_out' || v === 'death' || v === 'idle' || v === 'aborted';
}
