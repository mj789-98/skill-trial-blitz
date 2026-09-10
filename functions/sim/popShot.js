/**
 * Pop Shot — the authoritative simulation.
 *
 * The same contract as chickenRun.js, for the same reason: the server replays
 * the player's inputs against the seed it issued and computes the score itself.
 * Nothing here reads wall-clock time, and nothing here uses a float.
 *
 * ── The shot control curve ───────────────────────────────────────────────────
 *
 * The brief describes it as "tap anywhere on the screen to lift the ball higher
 * into the air and shoot it towards the basket", and separately requires that a
 * ball going out of bounds "rolls back in from the opposite side". The second
 * requirement is the one that settles the design: a ball that re-enters is a
 * ball that is never lost, so this is not a sequence of discrete shots — it is
 * ONE ball, permanently in play, that the player keeps aloft and steers through
 * the hoop again and again.
 *
 * So the control is a flap, not a charge:
 *
 *   - the ball always drifts horizontally and wraps at the court edges
 *   - gravity pulls it down every tick
 *   - a tap SETS the vertical velocity to a fixed upward value
 *
 * Setting rather than adding is the important half. Adding impulses is a power
 * meter with no display: the same tap does something different depending on
 * hidden state, and a player cannot learn it. Setting means one tap always
 * produces exactly the same arc from wherever the ball is, so the skill is
 * *when* you tap, which is a thing a player can see and get better at.
 * Alternatives tried and rejected are in DECISIONS.md.
 *
 * ── Why points bank as you score them ────────────────────────────────────────
 *
 * Chicken Run risks everything until you hold Cash Out; a death costs the whole
 * run. Pop Shot banks each basket the moment it drops. That is a deliberately
 * different tension: Chicken Run asks "do I push my luck?", Pop Shot asks "how
 * fast can I go?". A game with a clock does not need a bank mechanic, and giving
 * it one would mean a player could lose a full clock's work to a slip in the
 * last second, which is a punishment nobody enjoys twice.
 */

'use strict';

// ── Fixed step and fixed point ──────────────────────────────────────────────

/** Matches TICK_HZ in app/src/unity/protocol.ts and in chickenRun.js. */
const TICK_HZ = 50;

/** Fixed-point scale: one court unit is SUB sub-units. */
const SUB = 1000;

/**
 * Court size, in sub-units. 9x16 — portrait, matching the phone and matching
 * Chicken Run, so the Unity surface never has to be resized mid-session.
 */
const COURT_W = 9 * SUB;
const COURT_H = 16 * SUB;

const BALL_R = 340;

/** Downward acceleration per tick, in sub-units per tick per tick. */
const GRAVITY = 22;

/**
 * Vertical velocity a tap SETS (not adds). Gives an apex about 4 units above
 * wherever the ball was, roughly 0.38s later.
 */
const FLAP_VY = 420;

/** Horizontal drift. Crosses the court in about three seconds. */
const DRIFT_VX = 60;

/** Terminal velocity, so a long fall stays readable rather than becoming a blur. */
const MAX_FALL_VY = 620;

/**
 * Minimum ticks between accepted taps (100ms). Same purpose as Chicken Run's hop
 * cooldown: it does not stop a bot, it denies one a superhuman input rate, and
 * it gives the heartbeat clamp a physical bound to reason about.
 */
const TAP_COOLDOWN_TICKS = 5;

// ── The hoop ────────────────────────────────────────────────────────────────

/**
 * The two lanes the basket alternates between, in sub-units from the left.
 *
 * Measured off the reference recording: across a whole round the rim occupied
 * exactly two horizontal positions, 409 and 931 of a 1342-wide frame, which is
 * 30.5% and 69.4% of the court -- symmetric about the centre. Nine placements,
 * strictly alternating, never twice on the same side.
 */
const LANE_L = 2750;
const LANE_R = 6250;

/**
 * The band the rim's height is drawn from, and the height a round opens on.
 *
 * The rim used to be a compile-time constant, which made the basket the one
 * fixed thing in the game. In the reference it is the opposite: the basket
 * moves after every made shot and the player re-aims each time. HOOP_Y is kept
 * as the centre of the band so the average round still plays at the height
 * everything else was tuned around.
 */
const HOOP_Y = 9500;
const HOOP_Y_SPREAD = 1000;
const HOOP_Y_MIN = HOOP_Y - HOOP_Y_SPREAD;
const HOOP_Y_MAX = HOOP_Y + HOOP_Y_SPREAD;

/** Half the rim opening. The ball (radius 340) has room but not much. */
const RIM_HALF = 900;

/** Rim posts, modelled as small circles at each end of the opening. */
const POST_R = 90;

/** Backboard: a vertical wall just outside the far post. */
const BOARD_THICK = 90;
const BOARD_H = 2400;

/** Floor bounce, as a percentage of incoming speed. */
const FLOOR_RESTITUTION = 55;
const RIM_RESTITUTION = 70;
// No BOARD_RESTITUTION. The backboard does not bounce the ball -- it is a
// sensor that disqualifies a swish. See collideBoard.

/** Where the ball rests. */
const FLOOR_Y = BALL_R;

// ── Clock ───────────────────────────────────────────────────────────────────

/**
 * The shot clock does not start until the first basket — the brief asks for
 * this explicitly, and it is a kindness: a player who has not scored yet is
 * still learning the arc, and starting a countdown on them punishes exactly the
 * moment they most need to experiment.
 */
const START_CLOCK_TICKS = 15 * TICK_HZ;
/**
 * What a basket buys back on the clock.
 *
 * This was +3s per basket with +1s more for a swish, and at those numbers the
 * game had no end. A basket cycle costs as little as a second when the ball is
 * played from height, so scoring PAID more clock than it spent: the shot clock
 * climbed instead of falling and the round ran until the hour-long hard stop.
 * A score with no ceiling is a payout with no ceiling, which is the one thing a
 * staked mode cannot have.
 *
 * The reference is not doing anything different in kind. Its round shows nine
 * baskets across about forty-four seconds -- one every 4.4s -- against roughly
 * the same +3s, so there the reward is comfortably less than the cycle costs
 * and the clock still drains. Our game simply lets a good player score far
 * faster than theirs does, and the honest lever is what a basket pays rather
 * than how quickly one can be taken.
 *
 * Measured, not guessed. The bar is that the round has to end under the BEST
 * strategy available, not the average one -- playing from height beats hovering
 * at the rim, because a long fall buys enough sideways travel to reach a hoop
 * on the far side without ever dropping below it. Swept against both:
 *
 *     per basket   hover (realistic)      play-high (best)
 *     +3.0s        2.2 / 4.0 / 6.3 / 7.3  0.8 / 19.8 / 93.5 / 42.4
 *     +1.5s        2.0 / 3.6 / 4.8 / 5.0  0.5 / 13.3 / 66.6 / 13.9
 *     +1.0s        2.0 / 3.3 / 4.0 / 4.3  0.6 /  8.9 / 27.9 / 10.7
 *
 * +1s. The round now ends under either strategy, and playing well still pays
 * -- it is meant to -- it simply no longer pays forever.
 */
const BASKET_TIME_TICKS = 1 * TICK_HZ;
const SWISH_BONUS_TICKS = TICK_HZ / 2;
const MAX_CLOCK_TICKS = 30 * TICK_HZ;

/**
 * A round where the player never scores has no clock, so it needs its own
 * bound or it runs forever.
 */
const NO_BASKET_LIMIT_TICKS = 60 * TICK_HZ;

/**
 * The buzzer-beater window. See DECISIONS for the precise rule; this is the
 * hard stop that keeps it from being farmable by simply never letting the ball
 * come down.
 */
const BUZZER_GRACE_TICKS = 3 * TICK_HZ;

/** Points. A swish is worth more, per the brief. */
const POINTS_BASKET = 2;
const POINTS_SWISH = 3;

/** Inputs. Encoded into the trace as these exact byte values. */
const ACT_TAP = 1;

/** How a run ended. 'time' is Pop Shot's own; the others mirror protocol.ts. */
const END_TIME = 'time';
const END_ABORTED = 'aborted';

/** Safety valve so a malicious trace cannot make the server simulate forever. */
const MAX_TICKS = 60 * 60 * TICK_HZ;

// ── Deterministic pseudo-randomness ─────────────────────────────────────────

/** Same generator as chickenRun.js, for the same reason: integer ops only. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

/** Accepts the seed as a decimal string, because that is how it travels. */
function parseSeed(seed) {
  const n = typeof seed === 'number' ? seed : Number.parseInt(String(seed), 10);
  if (!Number.isFinite(n)) throw new Error(`seed is not a number: ${seed}`);
  return n >>> 0;
}

/**
 * Integer square root. Exact, and identical in C# — which a float sqrt is not
 * guaranteed to be. Used for the rim bounce normal.
 */
function isqrt(n) {
  if (n <= 0) return 0;
  let x = n;
  let y = ((x + 1) / 2) | 0;
  while (y < x) {
    x = y;
    y = ((x + ((n / x) | 0)) / 2) | 0;
  }
  return x;
}

/** Floor division that behaves the same for negatives in C# and JS. */
function floorDiv(a, b) {
  const q = Math.trunc(a / b);
  return a % b !== 0 && (a < 0) !== (b < 0) ? q - 1 : q;
}

// ── The world, derived from the seed ────────────────────────────────────────

/**
 * Where the hoop stands for the nth placement of a round.
 *
 * n is the number of baskets already made, so n=0 is where the round opens.
 *
 * ── Why this is a pure function of (seed, n) ─────────────────────────────────
 *
 * The obvious implementation is a generator advanced on each basket, with its
 * state living in State. That would work and it would be wrong here: the
 * server replays a trace to decide what a round paid, so every value the
 * simulation uses has to be reconstructible from the seed alone. A pure
 * function of (seed, n) is reconstructible by construction, needs nothing
 * carried in the state, and is trivially identical in C# — a generator would
 * mean keeping two RNG cursors in step across two languages for the length of
 * a round.
 *
 * ── The side alternates, the height does not ────────────────────────────────
 *
 * Strict alternation is what the reference does, and it is not arbitrary: it
 * guarantees the next basket is always a real crossing of the court rather
 * than sometimes a tap-in where the ball already is. Only which side it STARTS
 * on comes from the seed. The height is drawn per placement, so the player
 * re-reads the shot each time instead of learning one arc.
 */
function hoopPlacement(seed, n) {
  // A distinct stream per placement. Mixing n in through a multiply-and-xor
  // rather than calling next() n times keeps this O(1) and, more importantly,
  // keeps it a function rather than a cursor.
  const rng = mulberry32((seed ^ 0x9e3779b9) + Math.imul(n, 0x85ebca6b));
  const startLeft = (mulberry32(seed ^ 0x27d4eb2f)() & 1) === 0;
  const left = startLeft === (n % 2 === 0);
  return {
    x: left ? LANE_L : LANE_R,
    y: HOOP_Y_MIN + (rng() % (HOOP_Y_MAX - HOOP_Y_MIN + 1)),
  };
}

/**
 * Which way the ball drifts.
 *
 * Derived from where the basket is, not from the seed, because the brief is
 * specific about the wrap:
 *
 *   "If the ball goes out of bounds, it rolls back in from the side of the
 *    court OPPOSITE the basket."
 *
 * The ball only ever leaves by the edge it is drifting towards, so the only way
 * to guarantee it re-enters opposite the basket is to send it out on the
 * basket's own side. Drift towards the basket, wrap in from the far side.
 *
 * This was a random mirror per seed, which satisfied that sentence in about
 * half of all rounds and quietly contradicted it in the rest. It also made
 * those rounds worse to play: the ball spawned on the far side and drifted
 * AWAY from the hoop, so the first approach was a lap of the court rather than
 * a run at the basket.
 *
 * Now that the basket moves, "opposite the basket" is no longer a fact about
 * the round -- it is a fact about the moment. So this takes the hoop's CURRENT
 * position rather than the seed, and the drift is re-aimed whenever the hoop
 * is placed. The rule in the brief holds continuously instead of holding once.
 */
function driftDir(hx) {
  return hx * 2 >= COURT_W ? 1 : -1;
}

// ── State ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} State
 * @property {number} seed
 * @property {number} tick
 * @property {number} x        ball centre, sub-units from the left
 * @property {number} y        ball centre, sub-units above the floor
 * @property {number} vx
 * @property {number} vy
 * @property {number} points
 * @property {number} baskets
 * @property {number} swishes
 * @property {number} clockTicks
 * @property {boolean} clockRunning   false until the first basket
 * @property {number} buzzerTicks     ticks spent at clock zero with a live ball
 * @property {boolean} touchedRim     since the last floor contact
 * @property {boolean} touchedBoard   since the last floor contact
 * @property {number} lastTapTick
 * @property {number} hoopX     current basket centre, re-placed on each basket
 * @property {number} hoopY     current rim height, re-placed on each basket
 * @property {string|null} reason
 */

function createState(seed) {
  const s = parseSeed(seed);
  const start = hoopPlacement(s, 0);
  const dir = driftDir(start.x);
  return {
    seed: s,
    tick: 0,
    // Start on the opposite side from the hoop, so the first approach is a
    // real crossing rather than a gift.
    x: dir > 0 ? SUB : COURT_W - SUB,
    y: FLOOR_Y,
    vx: DRIFT_VX * dir,
    vy: 0,
    points: 0,
    baskets: 0,
    swishes: 0,
    clockTicks: START_CLOCK_TICKS,
    clockRunning: false,
    buzzerTicks: 0,
    touchedRim: false,
    touchedBoard: false,
    lastTapTick: -TAP_COOLDOWN_TICKS,
    hoopX: start.x,
    hoopY: start.y,
    reason: null,
  };
}

/**
 * The backboard's x: always OUTBOARD, so the rim opens into the court.
 *
 * This used to be unconditionally +x, which was correct only because the hoop
 * never left the right-hand half. On the left lane a +x board would stand
 * between the rim and the court -- the ball would hit the back of the
 * backboard on every approach, and the basket would face the wall.
 *
 * The reference is unambiguous here: in every frame the mounting arm is on the
 * outside and the rim faces the middle of the court.
 */
function boardX(state) {
  return state.hoopX * 2 >= COURT_W
    ? state.hoopX + RIM_HALF + BOARD_THICK
    : state.hoopX - RIM_HALF - BOARD_THICK;
}

// ── One tick ────────────────────────────────────────────────────────────────

/**
 * Advance the simulation one tick.
 *
 * @param {State} state
 * @param {number[]} actions  inputs issued on this tick
 * @returns {string|null} the end reason, or null if the round continues
 */
function step(state, actions) {
  if (state.reason !== null) return state.reason;

  // ── 1. Input ──────────────────────────────────────────────────────────────
  for (let i = 0; i < actions.length; i++) {
    if (actions[i] !== ACT_TAP) continue;
    if (state.tick - state.lastTapTick < TAP_COOLDOWN_TICKS) continue;
    // SET, not add. See the header note on the control curve.
    state.vy = FLAP_VY;
    state.lastTapTick = state.tick;
  }

  // ── 2. Integrate ─────────────────────────────────────────────────────────
  const prevY = state.y;

  state.vy -= GRAVITY;
  if (state.vy < -MAX_FALL_VY) state.vy = -MAX_FALL_VY;

  state.x += state.vx;
  state.y += state.vy;

  // ── 3. Out of bounds: roll back in from the opposite side ────────────────
  // The brief asks for this explicitly. A toroidal wrap is the version that
  // keeps ONE ball permanently in play, which is what the whole control scheme
  // rests on.
  let wrapped = false;
  if (state.x > COURT_W) {
    state.x -= COURT_W;
    wrapped = true;
  } else if (state.x < 0) {
    state.x += COURT_W;
    wrapped = true;
  }

  // ── 4. Floor and ceiling ─────────────────────────────────────────────────
  if (state.y <= FLOOR_Y) {
    state.y = FLOOR_Y;
    if (state.vy < 0) state.vy = floorDiv(-state.vy * FLOOR_RESTITUTION, 100);
    // A new flight begins: whether this one was clean is decided from here.
    state.touchedRim = false;
    state.touchedBoard = false;
  }
  const ceiling = COURT_H - BALL_R;
  if (state.y >= ceiling) {
    state.y = ceiling;
    if (state.vy > 0) state.vy = floorDiv(-state.vy, 2);
  }

  // ── 5. The hoop ──────────────────────────────────────────────────────────
  // Collisions first, then scoring: a ball that clipped the rim on the way in
  // still counts, but it is no longer a swish.
  collideRim(state);
  collideBoard(state);

  // Scoring is a downward crossing of the rim plane, inside the opening.
  // Downward specifically — a ball punched up through the hoop from below is
  // not a basket in any basketball anyone plays.
  if (!wrapped && prevY > state.hoopY && state.y <= state.hoopY) {
    const dx = state.x - state.hoopX;
    const clearance = RIM_HALF - BALL_R;
    if (dx >= -clearance && dx <= clearance) {
      score(state);
    }
  }

  // ── 6. Clock ─────────────────────────────────────────────────────────────
  if (state.clockRunning && state.clockTicks > 0) {
    state.clockTicks--;
  }

  state.tick++;

  // ── 7. Endings ───────────────────────────────────────────────────────────
  const ended = checkEnd(state);
  if (ended !== null) state.reason = ended;
  return state.reason;
}

function score(state) {
  const clean = !state.touchedRim && !state.touchedBoard;

  state.baskets++;
  if (clean) {
    state.swishes++;
    state.points += POINTS_SWISH;
  } else {
    state.points += POINTS_BASKET;
  }

  // Each basket buys time. This is what makes the mode a chase rather than a
  // countdown: a player who keeps scoring keeps playing.
  let add = BASKET_TIME_TICKS + (clean ? SWISH_BONUS_TICKS : 0);
  state.clockTicks += add;
  if (state.clockTicks > MAX_CLOCK_TICKS) state.clockTicks = MAX_CLOCK_TICKS;

  // The first basket is what starts the clock.
  state.clockRunning = true;

  // A basket also resets the buzzer window: the shot landed, so the round is
  // alive again.
  state.buzzerTicks = 0;

  // ── The basket moves ──────────────────────────────────────────────────────
  //
  // One relocation per BASKET, not per point. A clean shot is worth more but
  // it is still one shot, and in the reference a CLEAN moved the hoop exactly
  // once -- eight relocations across a nine-point round.
  //
  // Placed from the basket count, which has already been incremented, so the
  // nth basket puts the hoop in placement n. Nothing is stored but the result:
  // replaying the same trace reconstructs the same placements from the seed.
  const next = hoopPlacement(state.seed, state.baskets);
  state.hoopX = next.x;
  state.hoopY = next.y;

  // Re-aim the drift at the new basket.
  //
  // Without this the ball keeps travelling away from the hoop it now has to
  // reach, and every basket is followed by a full lap of the court -- the
  // exact failure the fixed drift direction was introduced to remove, brought
  // back by a hoop that moves. It also keeps the brief's wrap rule true: the
  // ball leaves on the basket's side and returns from the far one.
  state.vx = DRIFT_VX * driftDir(state.hoopX);
}

/**
 * When the round ends.
 *
 * ── The buzzer-beater rule, stated precisely ─────────────────────────────────
 *
 * The brief notes its own description is circular: a buzzer-beater is a shot
 * made as the clock expires, but a made basket adds time, so the clock has both
 * expired and not expired. This is the resolution:
 *
 *   The clock reaching zero does not end the round. It opens a RESOLUTION
 *   WINDOW. The round ends at the first tick where the clock is at zero AND the
 *   ball is at or below rim height. A basket scored during that window is a
 *   buzzer-beater: it scores, it adds its time, and play continues.
 *
 * So "expired" means "expired and the ball has come down", and the circularity
 * disappears — the clock is not the thing that ends the round, the ball is.
 *
 * The window is capped at BUZZER_GRACE_TICKS regardless, because the control
 * scheme lets a player keep the ball above rim height indefinitely by tapping,
 * and without the cap "never let it fall" would be an unbeatable strategy for
 * an infinite round.
 */
function checkEnd(state) {
  if (state.tick >= MAX_TICKS) return END_TIME;

  if (!state.clockRunning) {
    // No basket yet, so no clock. Bounded separately or the round never ends.
    return state.tick >= NO_BASKET_LIMIT_TICKS ? END_TIME : null;
  }

  if (state.clockTicks > 0) return null;

  // Clock is at zero. The ball decides.
  const live = state.y > state.hoopY;
  if (!live) return END_TIME;

  state.buzzerTicks++;
  return state.buzzerTicks >= BUZZER_GRACE_TICKS ? END_TIME : null;
}

/** True while the round is in its buzzer window. The renderer slows time on this. */
function inBuzzerWindow(state) {
  return state.clockRunning && state.clockTicks === 0 && state.reason === null;
}

// ── Collisions ──────────────────────────────────────────────────────────────

/**
 * Bounce off either rim post.
 *
 * The posts are circles, so this is a proper reflection about the contact
 * normal rather than a flat velocity flip — a rim shot that rattles in is the
 * single most satisfying thing that happens in this game, and flipping the sign
 * of vy would turn every one of them into the same bounce.
 *
 * The normal is normalised with an INTEGER square root. A float sqrt would be
 * the obvious choice and is not guaranteed identical across C# on ARM and V8,
 * which for a replayed score is the difference between a payout and a dispute.
 */
function collideRim(state) {
  const posts = [state.hoopX - RIM_HALF, state.hoopX + RIM_HALF];

  for (let i = 0; i < posts.length; i++) {
    const nx = state.x - posts[i];
    const ny = state.y - state.hoopY;
    const reach = BALL_R + POST_R;
    const distSq = nx * nx + ny * ny;
    if (distSq >= reach * reach) continue;

    // ── Vertical only. The drift is not ours to change ──────────────────────
    //
    // This used to be a full 2D reflection, v' = v - 2(v.n)n, which is correct
    // physics and the wrong game. Horizontal travel here is not momentum, it is
    // a conveyor: the ball crosses the court at a constant rate and wraps, and
    // the ONLY thing that may change its direction is the basket moving to the
    // other lane. A rim that reversed the drift meant the ball turned round in
    // mid-court for a reason the player had no way to predict, and it broke the
    // brief's wrap rule too -- a ball sent back the way it came leaves by the
    // edge OPPOSITE the basket and returns on the basket's own side.
    //
    // So a post deflects the ball up or down and takes the swish away. It does
    // not touch vx, and it does not move the ball sideways: pushing x out of
    // the overlap would be a horizontal shove by another name, and against a
    // constant drift it would simply be re-entered next tick.
    //
    // The ball is lifted clear along y instead, by exactly the amount that
    // clears a circle of radius `reach` at this horizontal offset. Same
    // no-sticking guarantee as the old push-out, along the one axis a post is
    // allowed to move the ball on.
    const clearY = isqrt(reach * reach - nx * nx);

    if (ny >= 0) {
      state.y = state.hoopY + clearY;
      // Only reverse a ball actually falling into the post. A ball already on
      // its way up has been dealt with and must not be kicked twice.
      if (state.vy < 0) state.vy = floorDiv(-state.vy * RIM_RESTITUTION, 100);
    } else {
      state.y = state.hoopY - clearY;
      if (state.vy > 0) state.vy = floorDiv(-state.vy * RIM_RESTITUTION, 100);
    }

    state.touchedRim = true;
  }
}

/**
 * Graze the backboard.
 *
 * A sensor, not a wall. It marks the ball as having touched the board -- which
 * is what disqualifies a swish, per the brief -- and does nothing else.
 *
 * It used to reverse vx, which is what a backboard does in a game where the
 * ball has horizontal momentum. This one does not: the drift is a conveyor and
 * only the basket moving may change its direction. A board that bounced the
 * ball back was the same defect as the rim reflection, one step further out --
 * and more confusing, because the board sits OUTBOARD of the rim, so it fired
 * after the ball had already missed and sent it back across the court under
 * its own authority.
 *
 * The ball passes it and carries on to the edge, where it wraps, which is what
 * the reference does: the ball crosses the full width of the court over and
 * over and never turns round in open play.
 */
function collideBoard(state) {
  const bx = boardX(state);
  if (state.y < state.hoopY || state.y > state.hoopY + BOARD_H) return;

  const near = state.x + BALL_R > bx - BOARD_THICK && state.x - BALL_R < bx + BOARD_THICK;
  if (!near) return;

  state.touchedBoard = true;
}

// ── Score ───────────────────────────────────────────────────────────────────

/**
 * What the round is worth.
 *
 * Unlike Chicken Run there is no cash-out and no zeroing: points bank as they
 * are scored, so an aborted round is worth what was already made. See the
 * header note.
 */
function scoreFor(state) {
  return state.points;
}

// ── Trace encoding ──────────────────────────────────────────────────────────
// Identical format to chickenRun.js: three bytes per input, a uint16 tick delta
// then the action byte. Shared format, separate simulations.

function encodeTrace(events) {
  const buf = Buffer.alloc(events.length * 3);
  let prev = 0;
  let o = 0;
  for (const e of events) {
    const delta = e.tick - prev;
    if (delta < 0) throw new Error('trace events must be ordered by tick');
    if (delta > 0xffff) throw new Error('gap between inputs exceeds uint16');
    buf.writeUInt16LE(delta, o);
    buf.writeUInt8(e.action, o + 2);
    prev = e.tick;
    o += 3;
  }
  return buf.toString('base64');
}

/** Parses hostile input. Throws on anything malformed rather than guessing. */
function decodeTrace(b64) {
  if (typeof b64 !== 'string') throw new Error('trace must be a string');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length % 3 !== 0) throw new Error('trace length is not a multiple of 3');

  const events = [];
  let tick = 0;
  for (let o = 0; o < buf.length; o += 3) {
    tick += buf.readUInt16LE(o);
    const action = buf.readUInt8(o + 2);
    if (action !== ACT_TAP) throw new Error(`unknown action byte ${action}`);
    if (tick > MAX_TICKS) throw new Error('trace extends beyond the tick limit');
    events.push({ tick, action });
  }
  return events;
}

// ── Replay ──────────────────────────────────────────────────────────────────

/**
 * Replay a trace against a seed. This is what the server pays on.
 *
 * @returns {{score: number, reason: string, ticks: number, baskets: number,
 *            swishes: number, inputs: number}}
 */
function simulate(seed, traceB64) {
  const events = decodeTrace(traceB64);
  const state = createState(seed);

  let next = 0;
  const pending = [];

  while (state.reason === null && state.tick < MAX_TICKS) {
    pending.length = 0;
    while (next < events.length && events[next].tick === state.tick) {
      pending.push(events[next].action);
      next++;
    }
    step(state, pending);
  }

  const reason = state.reason ?? END_ABORTED;
  return {
    score: scoreFor(state),
    reason,
    ticks: state.tick,
    baskets: state.baskets,
    swishes: state.swishes,
    inputs: events.length,
  };
}

module.exports = {
  // constants shared with the C# port and the harness
  TICK_HZ,
  SUB,
  COURT_W,
  COURT_H,
  BALL_R,
  GRAVITY,
  FLAP_VY,
  DRIFT_VX,
  MAX_FALL_VY,
  TAP_COOLDOWN_TICKS,
  HOOP_Y,
  HOOP_Y_MIN,
  HOOP_Y_MAX,
  LANE_L,
  LANE_R,
  RIM_HALF,
  POST_R,
  BOARD_THICK,
  BOARD_H,
  FLOOR_Y,
  START_CLOCK_TICKS,
  BASKET_TIME_TICKS,
  SWISH_BONUS_TICKS,
  MAX_CLOCK_TICKS,
  NO_BASKET_LIMIT_TICKS,
  BUZZER_GRACE_TICKS,
  POINTS_BASKET,
  POINTS_SWISH,
  ACT_TAP,
  END_TIME,
  END_ABORTED,
  MAX_TICKS,

  // world queries, used by the renderer and the parity test
  mulberry32,
  parseSeed,
  isqrt,
  floorDiv,
  hoopPlacement,
  driftDir,
  boardX,
  inBuzzerWindow,

  // trace + replay
  encodeTrace,
  decodeTrace,
  simulate,

  // stepping interface — the client drives these directly, so live play and
  // server replay run the same code rather than two implementations.
  createState,
  step,
  scoreFor,
};
