/**
 * The only place cents become a string.
 *
 * Money is an integer number of cents everywhere else — in Postgres, in the
 * ledger, over the wire, and in every variable in this app. It becomes a
 * decimal exactly once, here, on its way to a Text node. Nothing reads a
 * formatted string back.
 */

/** 350 -> "$3.50". Negative amounts are signed, not parenthesised. */
import type { Settlement } from './types';

export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 25000 basis points -> "2.50x".
 *
 * Two decimals because the cap is 2.5x-3.5x and the interesting differences are
 * in the hundredths.
 */
export function multiplier(x: number): string {
  return `${x.toFixed(2)}x`;
}

/** Whole seconds remaining until an ISO timestamp, floored at zero. */
export function secondsUntil(isoTimestamp: string, now: number = Date.now()): number {
  const target = Date.parse(isoTimestamp);

  if (!Number.isFinite(target)) {
    // Fail closed: a timestamp we cannot read is an offer we should re-quote,
    // not one we present as valid forever.
    //
    // But say so. This exact branch hid a real bug — the server was sending a
    // Date, the callable encoder turned it into `{}`, and every quote silently
    // rendered as already expired. A safe default that stays quiet is a safe
    // default that lets a defect look like a feature.
    if (__DEV__) {
      console.warn(
        `[format] secondsUntil could not parse ${JSON.stringify(isoTimestamp)} — ` +
          'treating it as expired. The server should be sending an ISO string.'
      );
    }
    return 0;
  }

  return Math.max(0, Math.ceil((target - now) / 1000));
}

/**
 * The headline on the result screen.
 *
 * Says "Cashed out" only when the round actually ended on a cash-out. It used to
 * say it for every winning round, which is true of Chicken Run -- a Chicken Run
 * round can only win by cashing out -- and false of Pop Shot, which has no
 * cash-out at all: its rounds end when the shot clock runs out. A round the
 * sweeper settled after the app was closed has no cash-out either.
 *
 * Seen on a real Pop Shot win: "Cashed out, $1.50" over a round that nobody had
 * cashed out of. The money was right; the sentence above it was not.
 */
export function resultHeadline(
  s: Pick<Settlement, 'payoutCents' | 'stakeCents' | 'netCents' | 'endReason'>
): string {
  const net = s.netCents ?? s.payoutCents - s.stakeCents;
  if (net > 0) return s.endReason === 'cash_out' ? 'Cashed out' : 'You won';
  if (net === 0) return 'Broke even';
  return 'No payout';
}
