/**
 * Tests for the flow machine.
 *
 * Almost all of these assert that something CANNOT happen. That is the point of
 * modelling the flow as a union rather than a navigation stack: the interesting
 * property is not "tapping play shows the game", it is "there is no sequence of
 * events that reaches a round without a funded entry".
 */

import { initialPhase, reduce, type Phase } from './roundFlow';
import type { Quote, Round, Settlement } from '../api/types';

const quote = { quoteId: 'q1', stakeCents: 300 } as unknown as Quote;
const round = { roundId: 'r1', seed: '12345', stakeCents: 300 } as unknown as Round;
const settlement = { roundId: 'r1', payoutCents: 420, stakeCents: 300 } as unknown as Settlement;

/** Drive the machine through a list of events from the booting state. */
function run(...events: Parameters<typeof reduce>[1][]): Phase {
  return events.reduce(reduce, initialPhase);
}

describe('the happy path', () => {
  it('goes lobby -> payout -> round -> result', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'ENTERED', round },
      { type: 'SETTLED', settlement }
    );

    expect(phase.name).toBe('result');
    expect(phase.name === 'result' && phase.settlement.payoutCents).toBe(420);
  });

  it('lets a result lead straight into a new quote', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'ENTERED', round },
      { type: 'SETTLED', settlement },
      { type: 'QUOTED', gameId: 'chicken_run', quote }
    );
    expect(phase.name).toBe('payout');
  });

  it('replaces an expired quote in place rather than bouncing to the lobby', () => {
    const fresh = { ...quote, quoteId: 'q2' } as Quote;
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'QUOTED', gameId: 'chicken_run', quote: fresh }
    );
    expect(phase.name === 'payout' && phase.quote.quoteId).toBe('q2');
  });
});

describe('what must not be reachable', () => {
  it('cannot enter a round without a quote', () => {
    const phase = run({ type: 'SIGNED_IN' }, { type: 'ENTERED', round });
    expect(phase.name).toBe('lobby');
  });

  it('cannot settle without a round', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'SETTLED', settlement }
    );
    expect(phase.name).toBe('payout');
  });

  it('cannot leave a PAID round through the back action', () => {
    // The whole reason BACK_TO_LOBBY is conditional. Letting this through would
    // be a refund button wearing a back arrow: the stake is already debited.
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'ENTERED', round },
      { type: 'BACK_TO_LOBBY' }
    );
    expect(phase.name).toBe('round');
  });

  it('CAN leave a practice round, because nothing was paid', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'PRACTICE_STARTED', gameId: 'chicken_run', seed: '7' },
      { type: 'BACK_TO_LOBBY' }
    );
    expect(phase.name).toBe('lobby');
  });

  it('does not settle a practice run as if it were paid', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'PRACTICE_STARTED', gameId: 'chicken_run', seed: '7' },
      { type: 'SETTLED', settlement }
    );
    expect(phase.name).toBe('round');
  });

  it('does not treat a paid round ending as a practice result', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'ENTERED', round },
      { type: 'PRACTICE_ENDED', score: 12, reason: 'cash_out' }
    );
    expect(phase.name).toBe('round');
  });

  it('shows nothing before auth has resolved', () => {
    // A quote arriving before SIGNED_IN would mean rendering a money screen for
    // a player we have not identified yet.
    const phase = run({ type: 'QUOTED', gameId: 'chicken_run', quote });
    expect(phase.name).toBe('booting');
  });
});

describe('signing out', () => {
  it('drops back to booting from anywhere, including mid-round', () => {
    const phase = run(
      { type: 'SIGNED_IN' },
      { type: 'QUOTED', gameId: 'chicken_run', quote },
      { type: 'ENTERED', round },
      { type: 'SIGNED_OUT' }
    );
    // The round is not abandoned by this — the server still holds it, and the
    // sweeper still settles it. The app simply stops rendering it.
    expect(phase.name).toBe('booting');
  });
});
