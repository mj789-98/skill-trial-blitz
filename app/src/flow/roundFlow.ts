/**
 * The app's one state machine.
 *
 * ── Why this and not React Navigation ────────────────────────────────────────
 *
 * Two reasons, and the first is the load-bearing one.
 *
 * `UnityHost` is built around `androidKeepPlayerMounted`: the Unity player stays
 * alive across screens so that going from the payout screen into a round is
 * instant rather than a multi-second reload. A stack navigator unmounts the
 * screen it navigates away from, which would tear down the GL surface every
 * time — the exact cost the embed was set up to avoid.
 *
 * The second: this flow is not a navigation graph. It is a sequence with money
 * in it, and the illegal transitions are the interesting part. You cannot reach
 * a round without a funded entry; you cannot reach a result without a round.
 * Modelling it as a discriminated union makes those unreachable by construction
 * rather than by remembering not to push the wrong screen. A back gesture out of
 * a paid round is not a thing that can happen here, because there is no stack to
 * pop.
 *
 * The cost is real: no transition animations, no deep links, no hardware back
 * button for free. For a four-screen app whose middle screen is a fullscreen
 * game, that is a good trade. A fifth screen would not change it; a tab bar
 * would.
 */

import type { GameId } from '../unity/protocol';
import type { Quote, Round, Settlement } from '../api/types';

export type Phase =
  /** Waiting for persisted auth to be read. Shows a splash, never a sign-in. */
  | { name: 'booting' }
  /** Signed in. Games, balance, stake tiers. */
  | { name: 'lobby' }
  /**
   * Holding a live offer. NO MONEY HAS MOVED YET — this is the screen the brief
   * calls binding at entry, and the curve on this quote is the one that will be
   * copied onto the round.
   */
  | { name: 'payout'; gameId: GameId; quote: Quote }
  /**
   * In a round. In blitz, the stake is already debited and the seed is the
   * server's. In practice, none of that is true and no round row exists.
   */
  | { name: 'round'; gameId: GameId; mode: 'blitz'; round: Round }
  | { name: 'round'; gameId: GameId; mode: 'practice'; round: null; seed: string }
  /** Settled. The numbers here came from the server, not from the game. */
  | { name: 'result'; gameId: GameId; settlement: Settlement }
  /** A practice run ended. No money, so no settlement to show. */
  | { name: 'practiceResult'; gameId: GameId; score: number; reason: string };

export type FlowEvent =
  | { type: 'SIGNED_IN' }
  | { type: 'SIGNED_OUT' }
  | { type: 'QUOTED'; gameId: GameId; quote: Quote }
  | { type: 'ENTERED'; round: Round }
  | { type: 'PRACTICE_STARTED'; gameId: GameId; seed: string }
  | { type: 'SETTLED'; settlement: Settlement }
  | { type: 'PRACTICE_ENDED'; score: number; reason: string }
  | { type: 'BACK_TO_LOBBY' };

export const initialPhase: Phase = { name: 'booting' };

/**
 * Transitions that are not listed are not legal, and return the current phase
 * unchanged rather than throwing. A dropped event costs a tap; a thrown one in
 * a reducer takes the app down mid-round, with a stake already debited.
 */
export function reduce(phase: Phase, event: FlowEvent): Phase {
  switch (event.type) {
    case 'SIGNED_IN':
      return phase.name === 'booting' ? { name: 'lobby' } : phase;

    case 'SIGNED_OUT':
      return { name: 'booting' };

    case 'QUOTED':
      // Re-quoting from the payout screen is legal: an expired quote is
      // replaced in place rather than bouncing the player back to the lobby.
      if (phase.name !== 'lobby' && phase.name !== 'payout' && phase.name !== 'result') {
        return phase;
      }
      return { name: 'payout', gameId: event.gameId, quote: event.quote };

    case 'ENTERED':
      // Only reachable from a quote. This is the guarantee that no round exists
      // without a payout screen having been shown for it.
      if (phase.name !== 'payout') return phase;
      return {
        name: 'round',
        gameId: phase.gameId,
        mode: 'blitz',
        round: event.round,
      };

    case 'PRACTICE_STARTED':
      if (phase.name !== 'lobby' && phase.name !== 'practiceResult') return phase;
      return {
        name: 'round',
        gameId: event.gameId,
        mode: 'practice',
        round: null,
        seed: event.seed,
      };

    case 'SETTLED':
      if (phase.name !== 'round' || phase.mode !== 'blitz') return phase;
      return { name: 'result', gameId: phase.gameId, settlement: event.settlement };

    case 'PRACTICE_ENDED':
      if (phase.name !== 'round' || phase.mode !== 'practice') return phase;
      return {
        name: 'practiceResult',
        gameId: phase.gameId,
        score: event.score,
        reason: event.reason,
      };

    case 'BACK_TO_LOBBY':
      // Deliberately refused mid-round. A player cannot walk out of a paid round
      // through the UI; the only ways out are cashing out, dying, and the
      // sweeper. Allowing it here would be a refund button wearing a back arrow.
      if (phase.name === 'round' && phase.mode === 'blitz') return phase;
      return { name: 'lobby' };

    default:
      return phase;
  }
}

/** A practice seed. Client-side on purpose: nothing is being paid for. */
export function practiceSeed(): string {
  // Coerced to uint32 because the simulation's PRNG is defined over 32-bit
  // unsigned values on both sides of the bridge, and a seed outside that range
  // would generate a world Unity and the server disagree about.
  // eslint-disable-next-line no-bitwise
  return String(Math.floor(Math.random() * 0xffffffff) >>> 0);
}
