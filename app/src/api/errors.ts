/**
 * Turning a transport error back into a domain error.
 *
 * `functions/index.js` maps domain codes onto HttpsError and carries the real
 * code — plus any numbers a screen needs — in the details payload:
 *
 *   throw new HttpsError('failed-precondition', 'not enough funds', {
 *     code: 'INSUFFICIENT_BALANCE', balanceCents, requiredCents,
 *   });
 *
 * This undoes that, so screens branch on `err.code === 'INSUFFICIENT_BALANCE'`
 * rather than on a message string. Matching on messages is how a copy edit turns
 * into a production bug.
 */

/** Every domain code the backend can return. Mirrors ERROR_MAP in functions/index.js. */
export type ApiErrorCode =
  | 'INVALID_STAKE'
  | 'INVALID_STAKE_TIER'
  | 'INVALID_SCORE'
  | 'NO_SUCH_GAME'
  | 'NO_SUCH_QUOTE'
  | 'NO_SUCH_ROUND'
  | 'NO_ACTIVE_CONFIG'
  | 'BLITZ_NOT_ENABLED'
  | 'STAKE_ABOVE_BOOTSTRAP_LIMIT'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_SUPERSEDED'
  | 'ROUND_VOIDED'
  | 'INSUFFICIENT_BALANCE'
  | 'QUOTE_NOT_YOURS'
  | 'ROUND_NOT_YOURS'
  | 'NO_VALIDATOR'
  /** Not from the server: the request never got there. */
  | 'NETWORK'
  /** The server failed in a way it would not describe. */
  | 'INTERNAL';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** Present on INSUFFICIENT_BALANCE. */
  readonly balanceCents?: number;
  readonly requiredCents?: number;
  /** Present on INVALID_STAKE_TIER / STAKE_ABOVE_BOOTSTRAP_LIMIT. */
  readonly tiers?: number[];
  readonly maxStakeCents?: number;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (details) {
      this.balanceCents = numberOrUndefined(details.balanceCents);
      this.requiredCents = numberOrUndefined(details.requiredCents);
      this.maxStakeCents = numberOrUndefined(details.maxStakeCents);
      this.tiers = Array.isArray(details.tiers) ? details.tiers.map(Number) : undefined;
    }
  }

  /**
   * A line that can be shown to a player as-is.
   *
   * Deliberately not the server's message for most cases. The server writes for
   * a developer reading logs; a player who cannot afford a round needs to be
   * told what to do about it.
   */
  get playerMessage(): string {
    switch (this.code) {
      case 'INSUFFICIENT_BALANCE':
        return 'Not enough in your balance for that entry.';
      case 'QUOTE_EXPIRED':
        return 'That payout offer expired. Here is a fresh one.';
      case 'QUOTE_SUPERSEDED':
        return 'A newer payout offer replaced this one.';
      case 'STAKE_ABOVE_BOOTSTRAP_LIMIT':
        return 'Entries are capped while we learn how you play. Try a smaller one.';
      case 'BLITZ_NOT_ENABLED':
        return 'This game is practice only for now.';
      case 'NETWORK':
        return 'Cannot reach the server. Check your connection.';
      default:
        return 'Something went wrong. Nothing was charged.';
    }
  }
}

/** Anything thrown by the callable transport becomes an ApiError. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
  const details = e?.details;
  const domainCode = details?.code;

  if (typeof domainCode === 'string') {
    return new ApiError(domainCode as ApiErrorCode, e.message || domainCode, details);
  }

  // The SDK's own codes, for failures that never reached a handler.
  if (e?.code === 'functions/unavailable' || e?.code === 'functions/deadline-exceeded') {
    return new ApiError('NETWORK', e.message || 'the server is unreachable');
  }

  return new ApiError('INTERNAL', e?.message || 'unknown error');
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
