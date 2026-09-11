/**
 * The typed client. The only file in the app that names an endpoint.
 *
 * Screens call `api.quote(...)`, never `httpsCallable(...)`. That keeps the
 * server's surface in one place, and it is what makes the retry policy below
 * a property of the API rather than something each screen reinvents.
 *
 * ── The client never sends a playerId ────────────────────────────────────────
 *
 * Identity comes from the auth token, which the SDK attaches. There is no
 * `playerId` field in any request here, because the server would ignore it: it
 * reads `request.auth.uid`. Sending one would only imply it mattered.
 */

import { httpsCallableFromURL } from 'firebase/functions';

import { functionUrl } from './config';
import { functions } from './firebase';
import { toApiError } from './errors';
import type { GameId } from '../unity/protocol';
import type { Game, Heartbeat, Profile, Quote, Round, Settlement } from './types';

/** One callable, typed, with transport errors normalised to ApiError. */
function callable<Req extends object, Res>(name: string) {
  return async (data?: Req): Promise<Res> => {
    try {
      // By URL, not by name. Calling by name makes the SDK derive the URL
      // from a region it has misparsed on React Native; see functionUrl.
      const fn = httpsCallableFromURL<Req, Res>(functions(), functionUrl(name));
      const result = await fn((data ?? {}) as Req);
      return result.data;
    } catch (err) {
      throw toApiError(err);
    }
  };
}

const raw = {
  ping: callable<{}, { ok: boolean; database: string; roundTripMs: number }>('ping'),
  listGames: callable<{}, { games: Game[] }>('listGames'),
  getProfile: callable<{}, Profile>('getProfile'),
  blitzQuote: callable<{ gameId: GameId; stakeCents: number }, Quote>('blitzQuote'),
  blitzEnter: callable<{ quoteId: string }, Round>('blitzEnter'),
  blitzHeartbeat: callable<{ roundId: string; score: number; tick: number }, Heartbeat>(
    'blitzHeartbeat'
  ),
  blitzSubmit: callable<{ roundId: string; score: number; trace: string }, Settlement>(
    'blitzSubmit'
  ),
  mockDeposit: callable<
    { amountCents: number; idempotencyKey: string },
    { balanceCents: number; applied: boolean }
  >('mockDeposit'),
};

export const api = {
  ping: raw.ping,

  async games(): Promise<Game[]> {
    return (await raw.listGames()).games;
  },

  profile: raw.getProfile,

  quote(gameId: GameId, stakeCents: number): Promise<Quote> {
    return raw.blitzQuote({ gameId, stakeCents });
  },

  enter(quoteId: string): Promise<Round> {
    return raw.blitzEnter({ quoteId });
  },

  /**
   * Tell the server how far the player has got.
   *
   * Fire-and-forget on purpose. This runs while a round is in progress, and a
   * dropped packet must not interrupt play or surface an error over the game.
   * A missed heartbeat costs the player nothing extra: the next one carries the
   * same information, because the server only ever raises the stored score.
   */
  heartbeat(roundId: string, score: number, tick: number): void {
    raw.blitzHeartbeat({ roundId, score, tick }).catch(() => {
      // Intentionally swallowed. See above.
    });
  },

  /**
   * Submit the run and get the settled result.
   *
   * Retried, because this is the one call where giving up costs the player their
   * stake. Retrying is only safe because settlement is idempotent on
   * `payout:<roundId>` — the dangerous case is a request that SUCCEEDED and
   * whose response was lost, and there the retry returns the same settlement
   * with `alreadySettled: true` rather than paying twice.
   *
   * Bounded at four attempts. Past that the sweeper is the backstop: the round
   * has a deadline, and something on a timer will settle it at the acknowledged
   * heartbeat whether or not this device ever comes back.
   */
  async submit(roundId: string, score: number, trace: string): Promise<Settlement> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await raw.blitzSubmit({ roundId, score, trace });
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        // A refusal is an answer. Only retry when the failure was the transport.
        if (code !== 'NETWORK' && code !== 'INTERNAL') throw err;
        await delay(400 * 2 ** attempt);
      }
    }
    throw lastError;
  },

  deposit(amountCents: number, idempotencyKey: string) {
    return raw.mockDeposit({ amountCents, idempotencyKey });
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
