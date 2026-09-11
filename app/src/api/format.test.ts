/**
 * Tests for the one place cents become a string.
 *
 * Worth testing precisely because it looks trivial. `(cents / 100).toFixed(2)`
 * is the obvious implementation and it is wrong for negative amounts in a way
 * nobody notices until a refund renders as "-$3.5" or "$-3.50".
 */

import { money, multiplier, resultHeadline, secondsUntil } from './format';

describe('money', () => {
  it('formats whole and part amounts', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(5)).toBe('$0.05');
    expect(money(350)).toBe('$3.50');
    expect(money(100000)).toBe('$1000.00');
  });

  it('puts the sign before the currency symbol', () => {
    expect(money(-300)).toBe('-$3.00');
    expect(money(-5)).toBe('-$0.05');
  });

  it('pads the cents', () => {
    // The failure this guards: 305 rendering as "$3.5".
    expect(money(305)).toBe('$3.05');
    expect(money(310)).toBe('$3.10');
  });
});

describe('multiplier', () => {
  it('always shows two decimals', () => {
    expect(multiplier(1)).toBe('1.00x');
    expect(multiplier(2.5)).toBe('2.50x');
    expect(multiplier(1.234)).toBe('1.23x');
  });
});

describe('secondsUntil', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('counts down and floors at zero', () => {
    expect(secondsUntil('2026-01-01T00:03:00.000Z', now)).toBe(180);
    expect(secondsUntil('2025-12-31T23:59:00.000Z', now)).toBe(0);
  });

  it('rounds up, so the last second is still shown as 1', () => {
    // A quote with 400ms left is still live. Flooring would show "0s" over a
    // button that still works, which reads as a broken screen.
    expect(secondsUntil('2026-01-01T00:00:00.400Z', now)).toBe(1);
  });

  it('treats an unparseable timestamp as expired', () => {
    // Fail closed: an offer we cannot date is one we should re-quote, not one
    // we should present as valid forever.
    expect(secondsUntil('not a date', now)).toBe(0);
  });
});

describe('resultHeadline', () => {
  const round = (payoutCents: number, endReason: string | null, stakeCents = 100) => ({
    payoutCents,
    stakeCents,
    endReason,
  });

  it('says "Cashed out" for a Chicken Run win, which can only be a cash-out', () => {
    expect(resultHeadline(round(162, 'cash_out'))).toBe('Cashed out');
  });

  it('never says "Cashed out" for a Pop Shot win: Pop Shot has no cash-out', () => {
    // The bug this pins: a Pop Shot round that ended on the shot clock was
    // headlined "Cashed out".
    expect(resultHeadline(round(150, 'time'))).toBe('You won');
  });

  it('never says "Cashed out" for a round the sweeper settled', () => {
    expect(resultHeadline(round(150, null))).toBe('You won');
    expect(resultHeadline(round(150, undefined as unknown as null))).toBe('You won');
  });

  it('reports break-even and loss by the money, whatever ended the round', () => {
    expect(resultHeadline(round(100, 'cash_out'))).toBe('Broke even');
    expect(resultHeadline(round(100, 'time'))).toBe('Broke even');
    expect(resultHeadline(round(0, 'death'))).toBe('No payout');
    expect(resultHeadline(round(35, 'time'))).toBe('No payout');
  });

  it('trusts the server net over its own arithmetic when both are present', () => {
    expect(resultHeadline({ payoutCents: 150, stakeCents: 100, netCents: 0, endReason: 'time' })).toBe(
      'Broke even'
    );
  });
});
