// What survives a restart, and what deliberately does not.
//
// The roster is the only state this plugin keeps on disk. It exists so a
// proactive message is possible after a restart, so the properties worth
// asserting are the ones that make it safe to keep: it holds no message text, it
// survives a truncated file, it is bounded, and the order it writes is the order
// the caller last touched.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite } from './helpers.mjs';
import { loadRoster, saveRoster } from '../lib/roster.js';

const t = suite('roster');
const dir = mkdtempSync(join(tmpdir(), 'qqb-roster-'));
const file = join(dir, 'conversations.json');

/**
 * @param {string} key - conversation key.
 * @param {string} kind - 'private' or 'group'.
 * @param {string} id - platform id.
 * @param {string} [name] - display name.
 * @returns {[string, any]} an entry for a Map.
 */
const entry = (key, kind, id, name) => [key, { kind, id, ...(name === undefined ? {} : { name }) }];

// --- round trip --------------------------------------------------------------
{
  const roster = new Map([
    entry('qq:onebot:private:10001', 'private', '10001', '林晚'),
    entry('qq:onebot:group:67890', 'group', '67890', '学习小组'),
  ]);
  saveRoster(file, roster, ['qq:onebot:group:67890', 'qq:onebot:private:10001']);
  const back = loadRoster(file);
  t.check(back.size === 2, `both conversations came back (got ${back.size})`);
  t.check(back.get('qq:onebot:private:10001')?.name === '林晚', 'the name survived');
  t.check(back.get('qq:onebot:group:67890')?.kind === 'group', 'the kind survived');

  const raw = readFileSync(file, 'utf8');
  t.check(raw.includes('"version": 1'), 'the file carries a version');
  t.check(!raw.includes('今天'), 'nothing said in the conversation is stored');
  t.check(!raw.includes('message'), 'and no message text under any key');
}

// --- ordering ----------------------------------------------------------------
{
  const roster = new Map([
    entry('qq:onebot:private:1', 'private', '1', 'A'),
    entry('qq:onebot:private:2', 'private', '2', 'B'),
    entry('qq:onebot:private:3', 'private', '3', 'C'),
  ]);
  saveRoster(file, roster, ['qq:onebot:private:2']);
  const back = loadRoster(file);
  t.check([...back.keys()][0] === 'qq:onebot:private:2', 'the most recently touched conversation is written first');
  t.check(back.size === 3, 'conversations the order does not name are kept, not dropped');
}

// --- a file that is not a roster --------------------------------------------
{
  writeFileSync(file, '{ this is not json', 'utf8');
  const warnings = [];
  const back = loadRoster(file, (message) => warnings.push(message));
  t.check(back.size === 0, 'a truncated file loads as an empty roster instead of throwing');
  t.check(warnings.length === 1, 'and it says so once');

  writeFileSync(file, JSON.stringify({ version: 1, conversations: [{ key: 'x', kind: 'nonsense', id: '1' }, { key: 'y', kind: 'private', id: '2' }, { kind: 'private', id: '' }] }), 'utf8');
  const filtered = loadRoster(file);
  t.check(filtered.size === 1, `malformed entries are dropped, the good one kept (got ${filtered.size})`);
  t.check(filtered.has('y'), 'and it is the well-formed one');

  const missing = loadRoster(join(dir, 'nope.json'), () => {
    throw new Error('a missing file must not warn');
  });
  t.check(missing.size === 0, 'a missing file is an empty roster and not a warning');
}

// --- bounds ------------------------------------------------------------------
{
  const big = new Map();
  for (let index = 0; index < 260; index += 1) {
    big.set(`qq:onebot:private:${index}`, { kind: 'private', id: String(index), name: `P${index}` });
  }
  saveRoster(file, big);
  const back = loadRoster(file);
  t.check(back.size === 200, `the roster is bounded at 200 entries (got ${back.size})`);
  t.check(back.has('qq:onebot:private:0'), 'the oldest of the first 200 is kept');
  t.check(!back.has('qq:onebot:private:259'), 'the newest beyond the bound is dropped when there is no recency order');
}

// --- a directory that cannot be written -------------------------------------
{
  // A regular file where a directory would have to be: this is the one shape of
  // write failure `mkdirSync(recursive)` cannot fix, so it is the one to assert on.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory', 'utf8');
  const warnings = [];
  saveRoster(join(blocker, 'inner.json'), new Map([entry('k', 'private', '1')]), [], (message) => warnings.push(message));
  t.check(warnings.length === 1, 'an unwritable path warns rather than throwing at the caller');
}

rmSync(dir, { recursive: true, force: true });
t.done();
