/**
 * Chicken Run — the authoritative simulation.
 *
 * This module is the reference implementation of the game's rules. It has two
 * consumers and no others:
 *
 *   1. `blitz/submit.js`, which replays a client's input trace against the seed
 *      the server issued and derives the score itself. The score the client
 *      reports is compared, never trusted.
 *   2. `tools/sim`, the tuning harness. The harness runs THIS simulation rather
 *      than an approximation of it, so the return-to-player numbers it produces
 *      describe the game that actually ships.
 *
 * `unity/Assets/_Project/ChickenRun/Sim/` is a line-for-line port of this file
 * into C#. The two must agree exactly, and `tools/parity` asserts that they do
 * across hundreds of random seeds and traces.
 *
 * ── The rule that makes replay possible ──────────────────────────────────────
 *
 * NO FLOATING POINT. Anywhere. Not in a position, not in a speed, not in a
 * comparison. Every quantity is a 32-bit-safe integer, and all division is
 * explicit integer division.
 *
 * Floats are not merely risky here, they are disqualifying: IEEE-754 rounding
 * can differ between IL2CPP's ARM64 output and V8, and a single least-
 * significant-bit disagreement three minutes into a run puts the chicken in a
 * different lane and produces a different score. The server would then accuse an
 * honest player of cheating. Integers cannot drift.
 *
 * Sub-cell positions are therefore fixed-point in units of SUB (1000ths of a
 * cell), and the renderer — which may use all the floats it likes — interpolates
 * between whole ticks for smoothness without ever feeding a value back in.
 *
 * ── Why the world is closed-form ─────────────────────────────────────────────
 *
 * Traffic, trains and logs are pure functions of (seed, row, tick). Nothing
 * about them accumulates. That means the simulation cannot drift even in
 * principle, and the server can evaluate row 200 at tick 9000 without having
 * simulated the 8999 ticks before it. Only the chicken carries state.
 */

'use strict';

// ── Tuning constants ────────────────────────────────────────────────────────
// These are game feel, not economy. The economy lives in blitz_configs.

/** Fixed simulation step. Matches TICK_HZ in app/src/unity/protocol.ts. */
const TICK_HZ = 50;

/** Playfield width in cells. The chicken lives on columns 0..COLS-1. */
const COLS = 9;

/** Fixed-point scale: one cell is SUB sub-units. */
const SUB = 1000;

/** Length of a lane's wrap-around track, in sub-units. */
const TRACK_SUB = COLS * SUB;

/**
 * Minimum ticks between accepted inputs (120ms). Bounds how fast any client —
 * including a scripted one — can act, so a bot cannot hop faster than a hand.
 * It does not stop a bot; it just denies it superhuman input rate.
 */
const HOP_COOLDOWN_TICKS = 6;

/**
 * The idle rule, made visible in-game as a dark band creeping up the lanes
 * rather than a hidden countdown.
 *
 * Grace of 2.5s, then the line takes a row every 1.1s, starting 4 rows back.
 * A player who stops dead therefore dies about 6 seconds later.
 *
 * Why roughly 6s: the two legitimate reasons to stand still are waiting out a
 * train cycle and waiting for a gap in traffic, and both resolve inside it. It
 * has to be this tight because Chicken Run has no clock of its own — in Blitz,
 * a player who has reached a multiplier they are happy with would otherwise
 * simply stand still forever rather than risk the bank, and the round would
 * never end. The idle rule IS the ending.
 */
const IDLE_GRACE_TICKS = Math.round(2.5 * TICK_HZ); // 125
const IDLE_STEP_TICKS = Math.round(1.1 * TICK_HZ); // 55
const IDLE_LEAD_ROWS = 4;

/** Row types. */
const ROW_GRASS = 0;
const ROW_ROAD = 1;
const ROW_RAIL = 2;
const ROW_RIVER = 3;

/** Inputs. Encoded into the trace as these exact byte values. */
const ACT_FORWARD = 1;
const ACT_BACK = 2;
const ACT_LEFT = 3;
const ACT_RIGHT = 4;
const ACT_CASH_OUT = 5;

/** How a run ended. Mirrors RoundEndReason in protocol.ts. */
const END_CASH_OUT = 'cash_out';
const END_DEATH = 'death';
const END_IDLE = 'idle';
const END_ABORTED = 'aborted';

/** Safety valve so a malicious trace cannot make the server simulate forever. */
const MAX_TICKS = 60 * 60 * TICK_HZ; // one hour of simulated time

// ── Deterministic pseudo-randomness ─────────────────────────────────────────

/**
 * mulberry32. Chosen because it is a handful of integer ops with no float
 * anywhere, which makes porting it to C# exact rather than approximate.
 *
 * All arithmetic is forced back into uint32 with `>>> 0` after every step; C#
 * gets the same by using `uint`.
 */
function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Mix a seed with a row index so each row's contents are independent. */
function rowSeed(seedUint32, row) {
  let h = (seedUint32 ^ Math.imul(row + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform integer in [0, n). Modulo bias is irrelevant at these tiny n. */
function below(rng, n) {
  return rng() % n;
}

/** Parse the server's seed string into a uint32. */
function parseSeed(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  if (typeof seed !== 'string' || !/^[0-9]+$/.test(seed)) {
    throw new Error(`seed must be a decimal string, got ${JSON.stringify(seed)}`);
  }
  return Number(seed) >>> 0;
}

// ── The world: pure functions of (seed, row) ────────────────────────────────

/**
 * The type of a row.
 *
 * Rows 0..2 are always grass so a run never opens with an unavoidable hazard —
 * a player must never die to a world they had no chance to read.
 *
 * Difficulty ramps by row: early rows favour roads (readable, forgiving), and
 * rivers and rails become more common further out. That ramp is what makes the
 * cash-out decision tighten as a run goes on, which is the whole tension of the
 * mode.
 */
function rowTypeAt(seedUint32, row) {
  if (row <= 2) return ROW_GRASS;

  const rng = mulberry32(rowSeed(seedUint32, row));
  const roll = below(rng, 100);

  // Difficulty band, capped so the far field stays playable rather than lethal.
  const depth = Math.min(row, 120);

  // Grass thins out from 34% to 20%; river and rail take the difference.
  const grassPct = 34 - Math.floor((depth * 14) / 120);
  const roadPct = 34 - Math.floor((depth * 6) / 120);
  const railPct = 12 + Math.floor((depth * 8) / 120);
  // River gets the remainder, so the four always sum to exactly 100.

  if (roll < grassPct) return ROW_GRASS;
  if (roll < grassPct + roadPct) return ROW_ROAD;
  if (roll < grassPct + roadPct + railPct) return ROW_RAIL;
  return ROW_RIVER;
}

/**
 * Static obstacles on a grass row, as a bitmask over columns.
 *
 * A hop into an obstacle is REFUSED, not fatal — the reference game blocks the
 * move rather than killing for it. That matters for feel: obstacles are terrain
 * to route around, and only vehicles, trains and water kill.
 *
 * At most COLS-2 columns are ever blocked, so a grass row can never wall the
 * player in completely.
 */
function grassObstacleMask(seedUint32, row) {
  if (row === 0) return 0;
  const rng = mulberry32(rowSeed(seedUint32, row) ^ 0x5bf03635);
  const count = below(rng, Math.min(COLS - 2, 4) + 1); // 0..4
  let mask = 0;
  for (let i = 0; i < count; i++) {
    mask |= 1 << below(rng, COLS);
  }
  return mask;
}

/**
 * The moving contents of a lane — cars on a road, logs on a river.
 *
 * Returned as parameters, not positions: every body on the lane sits at
 *   pos_i(tick) = (offset + i*gap + dir*speed*tick) mod TRACK_SUB
 * which is closed-form, so nothing accumulates and nothing can drift.
 */
function laneTraffic(seedUint32, row, kind) {
  const rng = mulberry32(rowSeed(seedUint32, row) ^ (kind === ROW_ROAD ? 0x1b873593 : 0xcc9e2d51));

  const dir = below(rng, 2) === 0 ? 1 : -1;

  if (kind === ROW_ROAD) {
    const count = 2 + below(rng, 3); // 2..4 vehicles
    return {
      dir,
      count,
      // 40..110 sub-units/tick — about 2 to 5.5 cells a second.
      speed: 40 + below(rng, 71),
      gap: Math.floor(TRACK_SUB / count),
      offset: below(rng, TRACK_SUB),
      // Vehicles are 1 or 2 cells long (car vs. truck).
      lengthSub: (1 + below(rng, 2)) * SUB,
    };
  }

  // River: logs, which are platforms rather than hazards.
  const count = 2 + below(rng, 2); // 2..3 logs
  return {
    dir,
    count,
    // Logs are slower than cars, so being carried is survivable.
    speed: 20 + below(rng, 41),
    gap: Math.floor(TRACK_SUB / count),
    offset: below(rng, TRACK_SUB),
    lengthSub: (2 + below(rng, 2)) * SUB, // 2..3 cells long
  };
}

/** Position of body `i` on a lane at `tick`, in sub-units, wrapped. */
function bodyPos(lane, i, tick) {
  const raw = lane.offset + i * lane.gap + lane.dir * lane.speed * tick;
  // JS % keeps the sign of the dividend; force a non-negative result.
  return ((raw % TRACK_SUB) + TRACK_SUB) % TRACK_SUB;
}

/**
 * Whether the span [pos, pos+len) — wrapped — covers sub-position `p`.
 */
function spanCovers(pos, lengthSub, p) {
  const end = pos + lengthSub;
  if (end <= TRACK_SUB) return p >= pos && p < end;
  // Wrapped span.
  return p >= pos || p < end - TRACK_SUB;
}

/**
 * Rail timing. A train sweeps the row periodically, and the crossing signal
 * flashes during the warning window so the hazard is always announced before it
 * arrives — the player must be able to read it, or the death is unfair.
 */
function railSchedule(seedUint32, row) {
  const rng = mulberry32(rowSeed(seedUint32, row) ^ 0x27d4eb2f);
  return {
    // 4.0s .. 7.5s between trains.
    periodTicks: 200 + below(rng, 176),
    // Phase, so adjacent rails do not fire in lockstep.
    phaseTicks: below(rng, 200),
    // The train occupies the row for 0.5s.
    occupyTicks: 25,
    // 1.4s of flashing signal before it arrives.
    warnTicks: 70,
  };
}

/** Is a train physically on this row right now? */
function trainPresent(sched, tick) {
  const t = (((tick + sched.phaseTicks) % sched.periodTicks) + sched.periodTicks) % sched.periodTicks;
  return t < sched.occupyTicks;
}

/** Is the crossing signal flashing? Exposed so the renderer and the sim agree. */
function trainWarning(sched, tick) {
  const t = (((tick + sched.phaseTicks) % sched.periodTicks) + sched.periodTicks) % sched.periodTicks;
  return t >= sched.periodTicks - sched.warnTicks || t < sched.occupyTicks;
}

// ── Trace encoding ──────────────────────────────────────────────────────────
//
// Three bytes per input: a uint16 tick delta since the previous input, then the
// action byte. A full run is a few hundred bytes, small enough to post without
// thought and small enough to store on every round for later audit.

/** @param {Array<{tick: number, action: number}>} events */
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

/**
 * Decode a base64 trace.
 *
 * This parses hostile input: the trace arrives from a client that may be
 * modified. It throws on anything malformed rather than guessing, and the caller
 * treats a throw as a failed validation, not a server error.
 */
function decodeTrace(b64) {
  if (typeof b64 !== 'string') throw new Error('trace must be a string');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length % 3 !== 0) throw new Error('trace length is not a multiple of 3');

  const events = [];
  let tick = 0;
  for (let o = 0; o < buf.length; o += 3) {
    tick += buf.readUInt16LE(o);
    const action = buf.readUInt8(o + 2);
    if (action < ACT_FORWARD || action > ACT_CASH_OUT) {
      throw new Error(`trace contains unknown action ${action}`);
    }
    if (tick > MAX_TICKS) throw new Error('trace exceeds the maximum round length');
    events.push({ tick, action });
  }
  return events;
}

// ── The simulation ──────────────────────────────────────────────────────────
//
// Exposed as a STEPPING state machine rather than only a batch replay.
//
// The client has to advance the world one tick at a time as the player plays,
// while the server replays a finished trace in one go. Those are the same rules,
// so they must not be two implementations — a second stepper is exactly the
// drift the parity harness exists to catch. `simulate()` below is a thin loop
// over `step()`, and the client drives `step()` directly.

/** Fresh run state for a seed. The only thing in the game that accumulates. */
function createState(seed) {
  return {
    seed: parseSeed(seed),
    tick: 0,
    row: 0,
    colSub: Math.floor(COLS / 2) * SUB, // centre column
    furthestRow: 0,
    lastAdvanceTick: 0, // when the idle line was last pushed back
    lastInputTick: -HOP_COOLDOWN_TICKS,
    reason: null,
  };
}

/**
 * Advance exactly one tick.
 *
 * `actions` are the inputs issued ON this tick, in order. Inputs refused by the
 * cooldown are still consumed — the client records every input it sends, and the
 * server must reject the same ones, or the two would diverge.
 *
 * Returns the end reason if the run finished on this tick, else null.
 *
 * NOTE: when a run ends, `tick` is deliberately NOT advanced, so `state.tick` is
 * the tick the run ended on. The batch replay depends on that, and so does the
 * heartbeat the client reports.
 */
function step(state, actions) {
  if (state.reason) return state.reason;

  // ── 1. Inputs ─────────────────────────────────────────────────────────────
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    if (state.tick - state.lastInputTick < HOP_COOLDOWN_TICKS) continue; // rate limited
    state.lastInputTick = state.tick;

    if (action === ACT_CASH_OUT) {
      state.reason = END_CASH_OUT;
      return state.reason;
    }

    const col = Math.floor(state.colSub / SUB);
    let nextRow = state.row;
    let nextCol = col;

    if (action === ACT_FORWARD) nextRow = state.row + 1;
    else if (action === ACT_BACK) nextRow = state.row - 1;
    else if (action === ACT_LEFT) nextCol = col - 1;
    else if (action === ACT_RIGHT) nextCol = col + 1;

    // Off the board sideways, or behind the start: refuse, do not kill.
    if (nextCol < 0 || nextCol >= COLS || nextRow < 0) continue;

    // Terrain blocks the hop rather than killing.
    if (
      rowTypeAt(state.seed, nextRow) === ROW_GRASS &&
      (grassObstacleMask(state.seed, nextRow) & (1 << nextCol)) !== 0
    ) {
      continue;
    }

    state.row = nextRow;
    state.colSub = nextCol * SUB;

    // Score is furthest row REACHED, so retreating to dodge never costs points.
    // Only forward progress resets the idle line — otherwise a player could hop
    // side to side forever and never be pushed.
    if (state.row > state.furthestRow) {
      state.furthestRow = state.row;
      state.lastAdvanceTick = state.tick;
    }
  }

  // ── 2. Being carried by a log ─────────────────────────────────────────────
  const kind = rowTypeAt(state.seed, state.row);
  if (kind === ROW_RIVER) {
    const lane = laneTraffic(state.seed, state.row, ROW_RIVER);
    if (logUnder(lane, state.colSub, state.tick) < 0) {
      state.reason = END_DEATH; // fell in the water
      return state.reason;
    }
    state.colSub += lane.dir * lane.speed;
    if (state.colSub < 0 || state.colSub >= TRACK_SUB) {
      state.reason = END_DEATH; // carried off the edge of the world
      return state.reason;
    }
  }

  // ── 3. Hazards ────────────────────────────────────────────────────────────
  if (kind === ROW_ROAD) {
    const lane = laneTraffic(state.seed, state.row, ROW_ROAD);
    if (vehicleUnder(lane, state.colSub, state.tick)) {
      state.reason = END_DEATH;
      return state.reason;
    }
  } else if (kind === ROW_RAIL) {
    if (trainPresent(railSchedule(state.seed, state.row), state.tick)) {
      state.reason = END_DEATH;
      return state.reason;
    }
  }

  // ── 4. The idle line ──────────────────────────────────────────────────────
  if (state.tick - state.lastAdvanceTick > IDLE_GRACE_TICKS) {
    const advanced = Math.floor(
      (state.tick - state.lastAdvanceTick - IDLE_GRACE_TICKS) / IDLE_STEP_TICKS
    );
    const lineRow = state.furthestRow - IDLE_LEAD_ROWS + advanced;
    if (state.row <= lineRow) {
      state.reason = END_IDLE;
      return state.reason;
    }
  }

  state.tick++;
  return null;
}

/**
 * Which row the advancing kill line occupies at a given tick.
 *
 * Exposed so the renderer draws the shadow band exactly where the simulation
 * will kill — the idle rule is made visible in-game rather than being a hidden
 * countdown, and a band drawn anywhere else would be a lie.
 */
function idleLineRow(state) {
  if (state.tick - state.lastAdvanceTick <= IDLE_GRACE_TICKS) {
    return state.furthestRow - IDLE_LEAD_ROWS;
  }
  const advanced = Math.floor(
    (state.tick - state.lastAdvanceTick - IDLE_GRACE_TICKS) / IDLE_STEP_TICKS
  );
  return state.furthestRow - IDLE_LEAD_ROWS + advanced;
}

/** The score a run would bank if it ended right now. Zero unless cashed out. */
function scoreFor(state) {
  return state.reason === END_CASH_OUT ? state.furthestRow : 0;
}

/**
 * Replay a finished run.
 *
 * @param {string|number} seed  The seed the SERVER issued for this round.
 * @param {string} traceB64     The client's input trace.
 * @returns {{
 *   score: number, reason: string, ticks: number,
 *   furthestRow: number, inputs: number
 * }}
 */
function simulate(seed, traceB64) {
  const events = decodeTrace(traceB64);
  const state = createState(seed);

  const lastEventTick = events.length ? events[events.length - 1].tick : 0;
  // Simulate a moment past the final input so a hop into traffic still resolves:
  // ending the run the instant the trace ends would let a player escape a car by
  // simply not sending anything else.
  const endTick = Math.min(lastEventTick + HOP_COOLDOWN_TICKS, MAX_TICKS);

  let ei = 0;
  const actions = [];

  while (state.tick <= endTick && !state.reason) {
    actions.length = 0;
    while (ei < events.length && events[ei].tick === state.tick) {
      actions.push(events[ei].action);
      ei++;
    }
    step(state, actions);
  }

  // A trace that simply stops without cashing out is an abandoned run. It is
  // NOT a cash-out: banking is a deliberate act, and letting silence bank a
  // score would hand the player a risk-free exit.
  const reason = state.reason || END_ABORTED;

  return {
    // The rule from the brief: you score 0 if you die. Only a deliberate
    // cash-out banks anything.
    score: reason === END_CASH_OUT ? state.furthestRow : 0,
    reason,
    ticks: state.tick,
    furthestRow: state.furthestRow,
    inputs: events.length,
  };
}


/** Index of the log under `colSub` at `tick`, or -1 if there is only water. */
function logUnder(lane, colSub, tick) {
  const p = ((colSub % TRACK_SUB) + TRACK_SUB) % TRACK_SUB;
  for (let i = 0; i < lane.count; i++) {
    if (spanCovers(bodyPos(lane, i, tick), lane.lengthSub, p)) return i;
  }
  return -1;
}

/** Is a vehicle occupying the chicken's cell? */
function vehicleUnder(lane, colSub, tick) {
  // The chicken is a point at the centre of its cell. Using the centre rather
  // than the whole cell means a near-miss reads as a near-miss instead of a
  // death, which is what makes the game feel fair rather than twitchy.
  const p = (Math.floor(colSub / SUB) * SUB + SUB / 2) % TRACK_SUB;
  for (let i = 0; i < lane.count; i++) {
    if (spanCovers(bodyPos(lane, i, tick), lane.lengthSub, p)) return true;
  }
  return false;
}

module.exports = {
  // constants shared with the C# port and the harness
  TICK_HZ,
  COLS,
  SUB,
  TRACK_SUB,
  HOP_COOLDOWN_TICKS,
  IDLE_GRACE_TICKS,
  IDLE_STEP_TICKS,
  IDLE_LEAD_ROWS,
  ROW_GRASS,
  ROW_ROAD,
  ROW_RAIL,
  ROW_RIVER,
  ACT_FORWARD,
  ACT_BACK,
  ACT_LEFT,
  ACT_RIGHT,
  ACT_CASH_OUT,
  END_CASH_OUT,
  END_DEATH,
  END_IDLE,
  END_ABORTED,
  MAX_TICKS,

  // world queries (the renderer and the parity test use these too)
  mulberry32,
  rowSeed,
  parseSeed,
  rowTypeAt,
  grassObstacleMask,
  laneTraffic,
  bodyPos,
  railSchedule,
  trainPresent,
  trainWarning,

  // trace + replay
  encodeTrace,
  decodeTrace,
  simulate,

  // stepping interface — the client drives these directly, so live play and
  // server replay run the same code rather than two implementations.
  createState,
  step,
  idleLineRow,
  scoreFor,
};
