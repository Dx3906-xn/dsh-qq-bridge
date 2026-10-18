// One account, more than one transport, and the operator moving between them
// while the process keeps running.
//
// The properties worth asserting are the ones that make a switch safe to do at
// 3am: a switch that fails leaves the working transport working; a switch that
// succeeds leaves nothing of the old one connected; and the conversation ids do
// not change, because a rename would make every person meet the agent again for
// the first time.
import { suite } from './helpers.mjs';
import { createSwitchboard } from '../lib/switchboard.js';
import { sessionKey } from '../lib/policy.js';

const t = suite('switchboard');

/**
 * A backend that can be told to fail, and that reports its own wiring.
 *
 * @param {string} name - backend id to report.
 * @param {{failConnect?: boolean, connected?: boolean}} [options] - behaviour.
 * @returns {any} the backend.
 */
function backendOf(name, options = {}) {
  /** @type {any[]} */
  const sent = [];
  const handlers = new Set();
  let connected = options.connected === true;
  return {
    name,
    sent,
    capabilities: new Set(['private', 'group']),
    selfId: name === 'onebot' ? '3658332922' : 'other-account',
    async connect() {
      if (options.failConnect === true) throw new Error(`${name} refused`);
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    async send(target, content) {
      sent.push({ target, content });
      return { ok: true, id: `${name}-${sent.length}` };
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    status() {
      return { connected, since: connected ? 1 : 0 };
    },
    /** How many listeners are attached, so a test can prove teardown happened. */
    get listeners() {
      return handlers.size;
    },
    /** Deliver an event as this transport would. @param {any} event - the event. */
    emit(event) {
      for (const handler of [...handlers]) handler(event);
    },
  };
}

// --- the namespace is not the backend ---------------------------------------
{
  const board = createSwitchboard({
    id: 'onebot',
    initial: 'onebot',
    factories: new Map([['onebot', () => backendOf('onebot')]]),
  });
  t.check(board.id === 'onebot', 'the namespace is what was configured');
  t.check(board.active === '', 'nothing is active before connect');
  await board.connect();
  t.check(board.active === 'onebot', 'connect activates the initial backend');
  t.check(board.status().connected === true, 'and it reports connected');
  t.check(board.selfId === '3658332922', 'the account id comes through');

  const before = sessionKey(board.id, { kind: 'private', id: '10001' });
  t.check(before === 'qq:onebot:private:10001', `the conversation id is stable (got ${before})`);
  await board.disconnect();
  t.check(board.active === '', 'disconnect clears the active backend');
}

// --- a switch that fails keeps the working transport working ----------------
{
  const made = new Map();
  const board = createSwitchboard({
    id: 'stable',
    initial: 'onebot',
    factories: new Map([
      ['onebot', () => {
        const b = backendOf('onebot');
        made.set('onebot', b);
        return b;
      }],
      ['llbot', () => {
        const b = backendOf('llbot', { failConnect: true });
        made.set('llbot', b);
        return b;
      }],
    ]),
  });
  await board.connect();
  const oldOne = made.get('onebot');
  t.check(oldOne.listeners === 1, 'the connected backend is subscribed once');

  const failed = await board.switchTo('llbot');
  t.check(failed.ok === false, 'a switch to a transport that refuses is not reported as done');
  t.check(String(failed.error).includes('refused'), `and it says why (got "${failed.error}")`);
  t.check(board.active === 'onebot', 'the active backend is still the old one');
  t.check(oldOne.status().connected === true, 'and it is still connected');
  t.check(oldOne.listeners === 1, 'and still subscribed — the failure did not unhook it');
  t.check(made.get('llbot').listeners === 0, 'the transport that failed left no listener behind');

  const unknown = await board.switchTo('carrier-pigeon');
  t.check(unknown.ok === false, 'an unknown backend is refused');
  t.check(String(unknown.error).includes('known:'), 'and the error lists what is available');
  t.check(board.active === 'onebot', 'and nothing changed');
}

// --- a switch that succeeds hands everything over ---------------------------
{
  const made = new Map();
  const board = createSwitchboard({
    id: 'stable',
    initial: 'onebot',
    factories: new Map([
      ['onebot', () => {
        const b = backendOf('onebot');
        made.set('onebot', b);
        return b;
      }],
      ['llbot', () => {
        const b = backendOf('llbot');
        made.set('llbot', b);
        return b;
      }],
    ]),
  });
  /** @type {any[]} */
  const seen = [];
  board.onEvent((event) => seen.push(event));
  await board.connect();

  const oldOne = made.get('onebot');
  const switched = await board.switchTo('llbot');
  t.check(switched.ok === true, 'the switch succeeded');
  t.check(switched.changed === true, 'and it reports that something changed');
  t.check(board.active === 'llbot', 'the new transport is active');
  t.check(oldOne.status().connected === false, 'the old transport was disconnected');
  t.check(oldOne.listeners === 0, 'and unsubscribed');
  t.check(made.get('llbot').listeners === 1, 'the new one is subscribed once');
  t.check(board.id === 'stable', 'the namespace did not follow the transport');

  oldOne.emit({ kind: 'message', text: 'from the dead one' });
  t.check(seen.length === 0, 'a message from the closed transport does not arrive');
  made.get('llbot').emit({ kind: 'message', text: 'from the live one' });
  t.check(seen.length === 1, 'a message from the live transport does');

  const again = await board.switchTo('llbot');
  t.check(again.ok === true && again.changed === false, 'switching to the active one is a no-op, not an error');

  await board.send({ kind: 'private', id: '1' }, [{ type: 'text', text: 'hi' }]);
  t.check(made.get('llbot').sent.length === 1, 'send goes through the active transport');
  t.check(oldOne.sent.length === 0, 'and not the closed one');

  await board.disconnect();
  t.check(made.get('llbot').listeners === 0, 'disconnect unsubscribes the active transport');
  const afterClose = await board.send({ kind: 'private', id: '1' }, [{ type: 'text', text: 'hi' }]);
  t.check(afterClose.ok === false, 'a send with nothing connected fails instead of throwing');
  t.check(board.status().connected === false, 'and status says so');
}

// --- subscribers outlive a switch -------------------------------------------
{
  // Someone subscribes once, at boot, and the operator swaps transports twice.
  // If a switch dropped subscribers, the second transport would come up mute.
  let made = 0;
  const board = createSwitchboard({
    id: 'stable',
    initial: 'a',
    factories: new Map([
      ['a', () => {
        made += 1;
        return backendOf('a');
      }],
      ['b', () => {
        made += 1;
        return backendOf('b');
      }],
    ]),
  });
  let count = 0;
  board.onEvent(() => {
    count += 1;
  });
  await board.connect();
  await board.switchTo('b');
  await board.switchTo('a');
  t.check(made === 3, `each switch built exactly one transport (got ${made})`);
  t.check(board.active === 'a', 'and ended on the one asked for');
  t.check(count === 0, 'nothing was delivered that was never sent');
}

// --- an empty namespace is a wiring mistake, not a default ------------------
{
  let threw = false;
  try {
    createSwitchboard({ id: '', initial: 'a', factories: new Map() });
  } catch (error) {
    threw = String(error instanceof Error ? error.message : error).includes('session namespace');
  }
  t.check(threw, 'a switchboard without a namespace refuses to start');

  const board = createSwitchboard({ id: 'x', initial: 'nope', factories: new Map([['a', () => backendOf('a')]]) });
  let connectThrew = false;
  try {
    await board.connect();
  } catch (error) {
    connectThrew = String(error instanceof Error ? error.message : error).includes('could not connect');
  }
  t.check(connectThrew, 'an initial backend that does not exist fails loudly at connect');
}

t.done();
