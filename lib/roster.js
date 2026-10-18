/**
 * The conversations this bridge has seen, remembered across restarts.
 *
 * Why a file and not a Map: the whole point of a proactive message is that it is
 * not triggered by an inbound one. An agent that restarts and loses the list of
 * conversations it has talked in can only wait to be spoken to first — which is
 * exactly the behaviour a companion is supposed to be able to break.
 *
 * What is stored is deliberately thin: the conversation key, its kind, the
 * platform id and the display name last seen. No message text, no stats, nothing
 * that would make this a second copy of the transcript. A roster that grew
 * content would become something else that has to be kept consistent with the
 * session log.
 *
 * @module dsh-qq-bridge/roster
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How many conversations the roster keeps; oldest-touched are dropped. */
const MAX_ENTRIES = 200;

/**
 * Load the roster from disk.
 *
 * A missing or unreadable file is an empty roster, not an error: this is a
 * convenience cache, and refusing to start because it was truncated would make a
 * harmless write failure look like a broken deployment.
 *
 * @param {string} path - the JSON file.
 * @param {(message: string, detail?: unknown) => void} [log] - diagnostic sink.
 * @returns {Map<string, import('./types.js').QqTarget>} key → target.
 */
export function loadRoster(path, log = () => {}) {
  /** @type {Map<string, import('./types.js').QqTarget>} */
  const out = new Map();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(`qq-bridge: ignoring an unreadable conversation list at ${path}`, error);
    return out;
  }
  const entries = Array.isArray(parsed?.conversations) ? parsed.conversations : [];
  for (const entry of entries) {
    const kind = entry?.kind;
    const id = String(entry?.id ?? '');
    const key = String(entry?.key ?? '');
    if ((kind !== 'private' && kind !== 'group') || id === '' || key === '') continue;
    out.set(key, {
      kind,
      id,
      ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
    });
  }
  return out;
}

/**
 * Write the roster back to disk, trimmed to the most recently touched entries.
 *
 * `order` is the caller's recency list; entries it does not name are kept at the
 * end, so a roster loaded from disk does not lose conversations merely because
 * this process has not seen them yet.
 *
 * @param {string} path - the JSON file.
 * @param {Map<string, import('./types.js').QqTarget>} roster - key → target.
 * @param {readonly string[]} [order] - keys, most recent first.
 * @param {(message: string, detail?: unknown) => void} [log] - diagnostic sink.
 * @returns {void}
 */
export function saveRoster(path, roster, order = [], log = () => {}) {
  const ordered = [];
  const seen = new Set();
  for (const key of order) {
    if (!roster.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  for (const key of roster.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  const conversations = ordered.slice(0, MAX_ENTRIES).map((key) => {
    const target = roster.get(key);
    return {
      key,
      kind: target.kind,
      id: target.id,
      ...(target.name === undefined ? {} : { name: target.name }),
    };
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`, 'utf8');
  } catch (error) {
    // A roster that cannot be written costs a restart some memory of who to
    // talk to; it does not cost the conversation in progress anything.
    log(`qq-bridge: could not write the conversation list to ${path}`, error);
  }
}
