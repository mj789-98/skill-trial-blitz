/**
 * The target engine: a player's history → the payout curve they are offered.
 *
 * Every number this module reads comes from `blitz_configs.params` (JSONB), so
 * the mode can be retuned by updating a row. Nothing here is a constant in code.
 * Each parameter is documented at `describeParams()` and in DECISIONS.md.
 *
 * ── The Cash Out wrinkle ─────────────────────────────────────────────────────
 *
 * Blitz wraps Chicken Run, and Chicken Run lets the player bank at will. So a
 * score is not a measure of skill — it is
 *
 *     min(how far they could get, where they chose to stop)
 *
 * with a death hazard that zeroes them for pushing too far. That breaks the
 * obvious design. If the target ratchets on the MEAN of recent scores, a player
 * who banks early every single round produces a low, low-variance history, their
 * target drifts down to meet it, and they farm 1.0x forever at no risk.
 *
 * So the ratchet reads a high PERCENTILE of the recent window (p70 by default),
 * not the mean. A percentile tracks what the player has shown they can reach
 * when they try, and is largely unmoved by a tail of deliberate early banks.
 *
 * That alone is not enough, and a test caught why. A player who banks early in
 * THREE rounds out of four pushes p70 itself into the low tail: a player who can
 * reach 30 walked their target down to 9, at which point they collect the 3.0x
 * cap more or less on demand. Raising the percentile only moves which ratio is
 * farmable. So the target is also bracketed from below against the player's own
 * rolling personal best, which kills the family rather than the instance — every
 * version of the exploit needs the target to fall far below demonstrated
 * ability, and now none of them can.
 *
 * ── The three bounds, and which one wins ─────────────────────────────────────
 *
 * `ceiling_guard.max_target_vs_pb` stops the ratchet pushing break-even past the
 * player's own demonstrated maximum — the answer to the ceiling problem.
 * `ceiling_guard.min_target_vs_pb` stops it being farmed downwards.
 * `min_target` is an absolute floor for players with no useful history.
 *
 * They can conflict: a genuinely weak player's personal best may sit below
 * `min_target`. When they do, THE CEILING GUARD WINS — it is applied last. The
 * floors exist to protect the business from a farming strategy; the ceiling
 * exists to stop the mode from selling someone a game they cannot win. Those are
 * not comparable stakes, and a mode that quietly prices an unwinnable round is
 * the thing the brief's question 4 is actually asking about.
 */

'use strict';

const { materialiseCurve } = require('./curve');

/**
 * Human-readable documentation of every tunable. Kept beside the code that reads
 * them so the two cannot drift, and rendered into DECISIONS.md.
 */
function describeParams() {
  return {
    'cold_start.seed_target':
      'Break-even score handed to a player with no history, drawn from the ' +
      'global baseline for the game.',
    'cold_start.bootstrap_rounds':
      'How many rounds a new player spends on the capped starter terms. ' +
      'LIFETIME per (player, game) and consumed at ENTRY, so it cannot be ' +
      're-earned or farmed by abandoning rounds.',
    'cold_start.bootstrap_cap_multiplier':
      'Multiplier ceiling during bootstrap. Lower than the standard cap, so ' +
      'the unmodelled window cannot be turned into a big payout.',
    'cold_start.bootstrap_max_stake_cents':
      'Stake ceiling during bootstrap. Bounds the total value of the window.',

    'ratchet.percentile':
      'Which percentile of the recent window the target chases. Deliberately ' +
      'high (p70) rather than the mean, so deliberate early cash-outs do not ' +
      'drag the target down. See the Cash Out note above.',
    'ratchet.up_alpha':
      'Fraction of the gap closed when the player is beating their target. ' +
      'Large: targets rise quickly on good play.',
    'ratchet.down_alpha':
      'Fraction of the gap closed when the player is missing their target. ' +
      'Small: targets fall slowly on bad play. This asymmetry is the mode.',
    'ratchet.max_up_step':
      'Hard cap on how many points a target may rise in one round, so a single ' +
      'lucky run cannot spike a player out of reach.',
    'ratchet.max_down_step':
      'Hard cap on how far a target may fall in one round, bounding how fast a ' +
      'player can walk their target down on purpose.',

    'ceiling_guard.pb_window':
      'How many recent scores count towards the rolling personal best.',
    'ceiling_guard.max_target_vs_pb':
      'Break-even may never exceed this fraction of the rolling personal best. ' +
      'The answer to the ceiling problem: a player cannot be pushed past their ' +
      'own demonstrated maximum. Overrides min_target when the two conflict.',
    'ceiling_guard.min_target_vs_pb':
      'Break-even may never fall below this fraction of the rolling personal ' +
      'best. Stops a player farming their target down by deliberately banking ' +
      'early: the exploit needs the target to drop far below demonstrated ' +
      'ability, and this forbids it. Yields to max_target_vs_pb.',
    'ceiling_guard.floor_percentile':
      'Which percentile of the recent window counts as demonstrated ability for ' +
      'the floor. High but not the maximum, so one fluke run cannot spike the ' +
      'floor past the per-round step cap.',
    'ceiling_guard.idle_decay_per_day':
      'Fraction the target decays per day away, because skill fades and a ' +
      'returning player should not face a target set at their peak.',

    min_target:
      'Floor on the break-even score, so a player cannot farm the target down ' +
      'to a triviality and collect 1.0x forever at no risk. Yields to the ' +
      'ceiling guard.',
    quote_ttl_seconds:
      'How long a shown payout screen stays enterable before the profile ' +
      'behind it is considered stale.',
    round_deadline_seconds:
      'How long after entry the sweeper resolves an unfinished round.',
    stake_tiers_cents: 'The entry fees offered, in integer cents.',
    'curve.shape':
      'The payout curve in RELATIVE space (score / target), so one shape ' +
      'serves every stake tier and every player.',
    'curve.cap_multiplier': 'Hard ceiling on the multiplier.',
  };
}

/** Defaults for anything a config omits, so a partial config cannot crash a quote. */
const DEFAULTS = {
  min_target: 5,
  ratchet: {
    percentile: 0.7,
    up_alpha: 0.45,
    down_alpha: 0.08,
    max_up_step: 4,
    max_down_step: 2,
  },
  ceiling_guard: {
    pb_window: 20,
    max_target_vs_pb: 0.92,
    min_target_vs_pb: 0.45,
    floor_percentile: 0.9,
    idle_decay_per_day: 0.04,
  },
  cold_start: {
    seed_target: 12,
    bootstrap_rounds: 3,
    bootstrap_cap_multiplier: 1.5,
    bootstrap_max_stake_cents: 100,
  },
};

function cfg(params, path, fallbackRoot = DEFAULTS) {
  const parts = path.split('.');
  let v = params;
  let d = fallbackRoot;
  for (const p of parts) {
    v = v == null ? undefined : v[p];
    d = d == null ? undefined : d[p];
  }
  return v === undefined || v === null ? d : v;
}

/**
 * An empty profile for a player who has never played this game.
 * Mirrors the column defaults in `blitz_profiles`.
 */
function emptyProfile(playerId, gameId, params) {
  return {
    player_id: playerId,
    game_id: gameId,
    rounds_played: 0,
    bootstrap_used: 0,
    target_score: cfg(params, 'cold_start.seed_target'),
    ewma_score: null,
    best_score: null,
    recent_scores: [],
    last_played_at: null,
  };
}

/**
 * Nearest-rank percentile of an array of integers.
 * Integer-indexed and exact; no interpolation, so no float creeps in.
 */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** Rolling personal best over the guard window. */
function rollingBest(recentScores, window) {
  const slice = recentScores.slice(0, window);
  return slice.length ? Math.max(...slice) : null;
}

/**
 * Resolve the break-even target to offer this player right now.
 *
 * Pure: it does not mutate the profile. The profile only changes at settlement,
 * via `advanceProfile`.
 *
 * @returns {{targetScore: number, capMultiplier: number, maxStakeCents: number|null,
 *            bootstrap: boolean, reasons: string[]}}
 *   `reasons` records which rules bound the result, and is stored on the quote's
 *   profile_snapshot so "why did this player get this curve?" is answerable later.
 */
function resolveTarget(profile, params, now = new Date()) {
  const reasons = [];

  const bootstrapRounds = cfg(params, 'cold_start.bootstrap_rounds');
  const isBootstrap = (profile.bootstrap_used || 0) < bootstrapRounds;

  if (isBootstrap) {
    // No history worth modelling. Use the game's global baseline and cap both
    // the multiplier and the stake, so an unmodelled player cannot be worth much
    // to farm. The allowance is lifetime and consumed at entry (see
    // consumeBootstrap), so it cannot be re-earned by abandoning rounds.
    reasons.push(
      `bootstrap round ${(profile.bootstrap_used || 0) + 1}/${bootstrapRounds}`
    );
    return {
      targetScore: Math.max(1, Math.round(cfg(params, 'cold_start.seed_target'))),
      capMultiplier: cfg(params, 'cold_start.bootstrap_cap_multiplier'),
      maxStakeCents: cfg(params, 'cold_start.bootstrap_max_stake_cents'),
      bootstrap: true,
      reasons,
    };
  }

  let target = Number(profile.target_score);
  if (!Number.isFinite(target) || target <= 0) {
    target = cfg(params, 'cold_start.seed_target');
    reasons.push('profile target was unusable; fell back to the seed target');
  }

  // Time away decays the target: skill fades, and a player returning after a
  // month should not be met with the target set at their peak.
  const decayPerDay = cfg(params, 'ceiling_guard.idle_decay_per_day');
  if (profile.last_played_at && decayPerDay > 0) {
    const days = Math.floor(
      (now.getTime() - new Date(profile.last_played_at).getTime()) / 86_400_000
    );
    if (days >= 1) {
      const before = target;
      target = target * Math.pow(1 - decayPerDay, days);
      reasons.push(
        `idle decay: ${days}d away took the target ${before.toFixed(1)} → ${target.toFixed(1)}`
      );
    }
  }

  const applied = applyBounds(target, profile, params);
  reasons.push(...applied.reasons);

  return {
    targetScore: applied.target,
    capMultiplier: cfg(params, 'curve.cap_multiplier', { curve: { cap_multiplier: 3.0 } }),
    maxStakeCents: null,
    bootstrap: false,
    reasons,
  };
}

/**
 * Apply the ceiling guard and the floor, in that order of precedence.
 *
 * The ceiling guard wins a conflict. See the header note: the floor protects
 * revenue, the ceiling stops the mode selling an unwinnable round, and those are
 * not comparable stakes.
 */
function applyBounds(target, profile, params) {
  const reasons = [];
  let t = target;

  const minTarget = cfg(params, 'min_target');
  if (t < minTarget) {
    reasons.push(`floored at min_target ${minTarget} (was ${t.toFixed(1)})`);
    t = minTarget;
  }

  const window = cfg(params, 'ceiling_guard.pb_window');
  const maxVsPb = cfg(params, 'ceiling_guard.max_target_vs_pb');
  const minVsPb = cfg(params, 'ceiling_guard.min_target_vs_pb');
  const pb = rollingBest(profile.recent_scores || [], window);

  if (pb !== null && pb > 0) {
    // Floor the target against demonstrated ability, not just against a constant.
    //
    // Without this, the percentile ratchet is farmable. A player who can reach 30
    // but deliberately banks 3 in three rounds out of four pushes the p70 of the
    // window down into the low tail, and the target walks all the way to
    // min_target. Their break-even then sits at 5 while they can score 30 at
    // will, so they collect the 3.0x cap more or less on demand.
    //
    // Raising the percentile would paper over that one pattern and simply move
    // the farmable ratio; bracketing the target against the player's own rolling
    // personal best kills the whole family of them, because the exploit needs the
    // target to fall far below what the player has recently proved they can do,
    // and now it cannot.
    // The floor reads a high percentile of the window, NOT its maximum.
    //
    // A test caught why: using the max, a single fluke run of 400 dragged the
    // floor to 180 and spiked the target straight past max_up_step, which is
    // exactly the "one lucky run prices you out" failure the step cap exists to
    // prevent. The ceiling can safely use the max — a rise there is still
    // rate-limited to max_up_step per round, and the outlier ages out of the
    // window long before the target could climb to meet it. A floor is applied
    // in one jump, so it has to be robust rather than merely rate-limited.
    const demonstrated = percentile(
      (profile.recent_scores || []).slice(0, window),
      cfg(params, 'ceiling_guard.floor_percentile')
    );
    const pbFloor = (demonstrated || 0) * minVsPb;
    if (t < pbFloor) {
      reasons.push(
        `PB floor: raised to ${minVsPb} x demonstrated ${demonstrated} = ` +
          `${pbFloor.toFixed(1)} (was ${t.toFixed(1)})`
      );
      t = pbFloor;
    }

    // Applied LAST so it wins over both floors. See the header note on precedence.
    const ceiling = pb * maxVsPb;
    if (t > ceiling) {
      reasons.push(
        `ceiling guard: capped at ${maxVsPb} x rolling PB ${pb} = ${ceiling.toFixed(1)} ` +
          `(was ${t.toFixed(1)})`
      );
      t = ceiling;
    }
  }

  // The curve cannot materialise a break-even below 1 (see curve.js), so this is
  // a hard floor regardless of everything above.
  const rounded = Math.max(1, Math.round(t));
  return { target: rounded, reasons };
}

/**
 * Build the payout curve to show a player, and the terms attached to it.
 *
 * This is what `blitz/quote.js` calls. The returned `curve` is what gets frozen
 * onto the quote and later copied onto the round.
 */
function buildQuote(profile, params, { stakeCents, now = new Date() } = {}) {
  const resolved = resolveTarget(profile, params, now);

  if (
    resolved.maxStakeCents !== null &&
    Number.isInteger(stakeCents) &&
    stakeCents > resolved.maxStakeCents
  ) {
    const err = new Error(
      `stake ${stakeCents}c exceeds the bootstrap limit of ${resolved.maxStakeCents}c`
    );
    err.code = 'STAKE_ABOVE_BOOTSTRAP_LIMIT';
    err.maxStakeCents = resolved.maxStakeCents;
    throw err;
  }

  const shape = cfg(params, 'curve.shape', { curve: { shape: null } });
  if (!Array.isArray(shape)) {
    throw new Error('config is missing curve.shape');
  }

  const curve = materialiseCurve(shape, resolved.targetScore, resolved.capMultiplier);

  return {
    curve,
    targetScore: resolved.targetScore,
    capMultiplier: resolved.capMultiplier,
    bootstrap: resolved.bootstrap,
    maxStakeCents: resolved.maxStakeCents,
    // Stored on the quote so a curve can be explained months later.
    profileSnapshot: {
      rounds_played: profile.rounds_played || 0,
      bootstrap_used: profile.bootstrap_used || 0,
      target_score: profile.target_score,
      best_score: profile.best_score,
      recent_scores: (profile.recent_scores || []).slice(0, 20),
      last_played_at: profile.last_played_at,
      resolved_target: resolved.targetScore,
      reasons: resolved.reasons,
    },
  };
}

/**
 * Consume one bootstrap allowance. Called at ENTRY, inside the same transaction
 * that debits the stake.
 *
 * Charging it at entry rather than settlement is the anti-farm: a player cannot
 * spend the capped-but-friendly starter rounds, abandon the ones going badly,
 * and still have the allowance left.
 */
function consumeBootstrap(profile, params) {
  const bootstrapRounds = cfg(params, 'cold_start.bootstrap_rounds');
  if ((profile.bootstrap_used || 0) >= bootstrapRounds) return profile.bootstrap_used || 0;
  return (profile.bootstrap_used || 0) + 1;
}

/**
 * Fold a settled round's score into the profile, producing the state the NEXT
 * round will be quoted from.
 *
 * Pure: returns a new profile object rather than mutating.
 */
function advanceProfile(profile, score, params, now = new Date()) {
  if (!Number.isInteger(score) || score < 0) {
    throw new Error(`score must be a non-negative integer, got ${score}`);
  }

  const window = cfg(params, 'ceiling_guard.pb_window');
  const recent = [score, ...(profile.recent_scores || [])].slice(0, window);

  // The percentile of the recent window, not the mean. See the header note.
  const observed = percentile(recent, cfg(params, 'ratchet.percentile'));

  let target = Number(profile.target_score);
  if (!Number.isFinite(target) || target <= 0) target = cfg(params, 'cold_start.seed_target');

  if (observed !== null) {
    const gap = observed - target;
    // Fast up, slow down. This asymmetry is the mode: targets chase good play
    // quickly and forgive bad play grudgingly.
    const alpha = gap > 0 ? cfg(params, 'ratchet.up_alpha') : cfg(params, 'ratchet.down_alpha');
    let step = gap * alpha;

    const maxUp = cfg(params, 'ratchet.max_up_step');
    const maxDown = cfg(params, 'ratchet.max_down_step');
    if (step > maxUp) step = maxUp;
    if (step < -maxDown) step = -maxDown;

    target += step;
  }

  const next = {
    ...profile,
    rounds_played: (profile.rounds_played || 0) + 1,
    recent_scores: recent,
    best_score: Math.max(profile.best_score || 0, score),
    last_played_at: now.toISOString(),
  };

  // Bound the stored target the same way a quote would, so what is persisted is
  // already sane and a later read cannot be surprised by it.
  next.target_score = applyBounds(target, next, params).target;

  // Kept for observability and the harness; the ratchet itself uses the
  // percentile, not this.
  const prevEwma = Number(profile.ewma_score);
  next.ewma_score = Number.isFinite(prevEwma) ? prevEwma * 0.8 + score * 0.2 : score;

  return next;
}

module.exports = {
  DEFAULTS,
  describeParams,
  emptyProfile,
  percentile,
  rollingBest,
  resolveTarget,
  applyBounds,
  buildQuote,
  consumeBootstrap,
  advanceProfile,
};
