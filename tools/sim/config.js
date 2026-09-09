/**
 * Where the harness gets a config from.
 *
 * The config it measures has to be the config that will actually be served,
 * otherwise the RTP number is about a file nobody deploys. There is exactly one
 * definition of the baseline — the `$json$ ... $json$` block in
 * sql/002_seed.sql — so that is what this reads, rather than keeping a second
 * copy under tools/ that would drift on the first retune.
 *
 * Dollar-quoted strings make the extraction unambiguous: the tag is `$json$`,
 * Postgres forbids it appearing inside the body, so a regex is not a guess here.
 *
 * `--config path.json` overrides this for a config that is not in the seed yet,
 * which is how a candidate is measured before it is committed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SEED_SQL = path.join(__dirname, '..', '..', 'sql', '002_seed.sql');

/**
 * Pull a named config out of the seed file.
 *
 * @param {string} name  the blitz_configs.name to find, e.g. 'baseline-v0'
 */
function loadFromSeed(name = 'baseline-v0') {
  const sql = fs.readFileSync(SEED_SQL, 'utf8');

  // Each config is inserted as: 'game', '<name>', $json${...}$json$
  const pattern = new RegExp(
    `'${escapeRegExp(name)}'\\s*,\\s*\\$json\\$([\\s\\S]*?)\\$json\\$`
  );
  const match = pattern.exec(sql);
  if (!match) {
    throw new Error(`no config named '${name}' in ${SEED_SQL}`);
  }

  return JSON.parse(match[1]);
}

function loadFromFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Return a copy of `params` with one dotted path replaced.
 *
 * Used for sweeps — measuring the same population against cap_multiplier 2.5,
 * 3.0 and 3.5 is how "pick a number and show the numbers either side" gets
 * answered. Deep-copies rather than mutating, so a sweep cannot leak one
 * variant's value into the next.
 */
function withOverride(params, dottedPath, value) {
  const next = JSON.parse(JSON.stringify(params));
  const keys = dottedPath.split('.');
  let node = next;

  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) {
      throw new Error(`cannot set ${dottedPath}: ${key} is not an object`);
    }
    node = node[key];
  }

  const leaf = keys[keys.length - 1];
  if (!(leaf in node)) {
    // Loud on a typo. A silently-created key would produce a sweep where every
    // variant reported the same numbers, which reads as "this parameter does
    // not matter" rather than "you spelled it wrong".
    throw new Error(`cannot set ${dottedPath}: no such parameter`);
  }
  node[leaf] = value;
  return next;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { loadFromSeed, loadFromFile, withOverride, SEED_SQL };
