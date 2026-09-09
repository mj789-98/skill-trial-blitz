/**
 * The score validators, keyed by game.
 *
 * This is one of exactly TWO files in the codebase that enumerate games — the
 * other is GameHost on the Unity side. Everything else takes a gameId and does
 * not care which game it is.
 *
 * That matters most for the money path: `submit` resolves a validator from the
 * round's own game_id, so the debit, the ledger, the curve lookup and the
 * settlement are written once and work for any game. Adding a mini-game never
 * touches code that moves a balance — which is the point, since that is the code
 * least safe to keep editing.
 *
 * To add a game:
 *   1. write its simulation as a pure integer state machine, mirrored in C#
 *   2. prove the two agree with tools/parity
 *   3. add one line here
 */

'use strict';

const chickenRun = require('./chickenRun');
const popShot = require('./popShot');

/**
 * @typedef {object} Validator
 * @property {(seed: string, trace: string) => {score: number, reason: string, ticks: number}} simulate
 *   Replays a trace against a server-issued seed and returns what actually
 *   happened. Must throw on a malformed trace rather than guessing.
 * @property {number} tickHz
 */

const VALIDATORS = Object.freeze({
  chicken_run: {
    simulate: chickenRun.simulate,
    tickHz: chickenRun.TICK_HZ,
  },
  pop_shot: {
    simulate: popShot.simulate,
    tickHz: popShot.TICK_HZ,
  },
});

/**
 * @param {string} gameId
 * @returns {Validator}
 * @throws when a game has no validator — deliberately loud. A round that cannot
 *   be validated must never quietly settle on the client's word.
 */
function validatorFor(gameId) {
  const v = VALIDATORS[gameId];
  if (!v) {
    const e = new Error(`no score validator for game "${gameId}"`);
    e.code = 'NO_VALIDATOR';
    throw e;
  }
  return v;
}

/** Games that can currently be validated, and therefore that Blitz may wrap. */
function validatableGames() {
  return Object.keys(VALIDATORS);
}

module.exports = { validatorFor, validatableGames };
