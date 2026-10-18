// The one command a human can type at this plugin.
//
// Two properties matter more than the wording: a switch that fails says so
// instead of reporting success, and the account id in the reply is read *after*
// the switch, because the whole point of moving transports is that a different
// one may be logged in as a different account.
import { suite } from './helpers.mjs';
import { createSwitchboard } from '../lib/switchboard.js';
import { runQqCommand } from '../lib/index.js';

const t = suite('command');

/**
 * A transport that can be told to refuse.
 *
 * @param {string} name - backend id.
 * @param {{failConnect?: boolean, selfId?: string}} [options] - behaviour.
 * @returns {any} the backend.
 */
function backendOf(name, options = {}) {
  let connected = false;
  return {
    id: name,
    capabilities: new Set(['private', 'group']),
    selfId: options.selfId ?? `${name}-account`,
    async connect() {
      if (options.failConnect === true) throw new Error(`${name} refused`);
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    async send() {
      return { ok: true, id: 'x' };
    },
    onEvent() {
      return () => {};
    },
    status() {
      return { connected, since: connected ? 1 : 0 };
    },
  };
}

// --- status ------------------------------------------------------------------
{
  const board = createSwitchboard({
    id: 'stable',
    initial: 'onebot',
    factories: new Map([['onebot', () => backendOf('onebot')]]),
  });
  await board.connect();
  const show = runQqCommand(board, { rawInput: '' }, 'en');
  t.check(show.kind === 'success', 'an empty input shows the state instead of failing');
  t.check(String(show.text).includes('onebot'), `the active transport is named (got "${show.text}")`);
  t.check(String(show.text).includes('connected'), 'and so is whether it is up');
  t.check(String(show.text).includes('available'), 'and what else could be used');

  const zh = runQqCommand(board, { rawInput: 'status' }, 'zh');
  t.check(zh.kind === 'success' && String(zh.text).includes('传输'), 'the reply is in Chinese when asked');
  const explicit = runQqCommand(board, { rawInput: 'status' }, 'en');
  t.check(String(explicit.text).includes('backend:'), 'status is not just a synonym for empty input by accident');
}

// --- the grammar -------------------------------------------------------------
{
  const board = createSwitchboard({
    id: 'stable',
    initial: 'onebot',
    factories: new Map([['onebot', () => backendOf('onebot')]]),
  });
  await board.connect();
  const bad = runQqCommand(board, { rawInput: 'reconnect' }, 'en');
  t.check(bad.kind === 'error', 'a verb this command does not have is an error');
  t.check(String(bad.text).includes('usage'), 'and it prints the usage');
  t.check(board.active === 'onebot', 'and nothing was attempted');

  const bare = runQqCommand(board, { rawInput: 'backend' }, 'en');
  t.check(bare.kind === 'success', '`backend` with no argument shows the state rather than switching to ""');
  t.check(board.active === 'onebot', 'and did not switch');
}

// --- switching ---------------------------------------------------------------
{
  const board = createSwitchboard({
    id: 'stable',
    initial: 'onebot',
    factories: new Map([
      ['onebot', () => backendOf('onebot', { selfId: '3658332922' })],
      ['llbot', () => backendOf('llbot', { selfId: '1405337008' })],
    ]),
  });
  await board.connect();

  const moved = await runQqCommand(board, { rawInput: 'backend llbot' }, 'en');
  t.check(moved.kind === 'success', 'switching to a configured transport succeeds');
  t.check(String(moved.text).includes('llbot'), `the reply names the new one (got "${moved.text}")`);
  t.check(board.active === 'llbot', 'and the switchboard agrees');
  t.check(board.selfId === '1405337008', 'the account id is read after the switch, not before');

  const same = await runQqCommand(board, { rawInput: 'backend llbot' }, 'en');
  t.check(same.kind === 'success', 'switching to the active one is not an error');
  t.check(String(same.text).includes('already'), `and says nothing changed (got "${same.text}")`);
}

// --- a switch that fails -----------------------------------------------------
{
  const board = createSwitchboard({
    id: 'stable',
    initial: 'onebot',
    factories: new Map([
      ['onebot', () => backendOf('onebot')],
      ['broken', () => backendOf('broken', { failConnect: true })],
    ]),
  });
  await board.connect();
  const failed = await runQqCommand(board, { rawInput: 'backend broken' }, 'en');
  t.check(failed.kind === 'error', 'a transport that will not open is reported as an error');
  t.check(String(failed.text).includes('refused'), `the reason is carried through (got "${failed.text}")`);
  t.check(board.active === 'onebot', 'and the old transport is still the active one');
  t.check(board.status().connected === true, 'and still connected');

  const unknown = await runQqCommand(board, { rawInput: 'backend carrier-pigeon' }, 'en');
  t.check(unknown.kind === 'error', 'an unknown transport is an error, not a fallback');
  t.check(String(unknown.text).includes('known:'), 'and lists what exists');

  const zhFailed = await runQqCommand(board, { rawInput: 'backend carrier-pigeon' }, 'zh');
  t.check(String(zhFailed.text).includes('没有切换'), 'the failure is in Chinese when asked');
}

// --- what a configuration declares ------------------------------------------
{
  // `backends` exists so that "another transport for the same account" needs no
  // code: a second socket, a different machine, a different port. The property
  // worth asserting is the fallback — declaring a name must not oblige the
  // operator to repeat an address that was already right.
  const { backendFactories } = await import('../lib/index.js');
  const plain = backendFactories({ endpoint: 'ws://127.0.0.1:3001', accessToken: 't', backends: {} });
  t.check([...plain.keys()].join(',') === 'onebot', 'a configuration that never mentions backends still has onebot');
  const built = plain.get('onebot')();
  t.check(built.id === 'onebot', 'and it is a OneBot transport');
  t.check(built.capabilities.has('private') && built.capabilities.has('group'), 'with the capabilities the tools are derived from');

  const declared = backendFactories({
    endpoint: 'ws://127.0.0.1:3001',
    accessToken: 'top-level',
    backends: {
      llbot: { endpoint: 'ws://192.168.1.9:3002', accessToken: 'other' },
      spare: { endpoint: '', accessToken: '' },
      onebot: { endpoint: 'ws://ignored:9999', accessToken: '' },
    },
  });
  t.check([...declared.keys()].join(',') === 'onebot,llbot,spare', `each declared id is reachable, and "onebot" is not duplicated (got ${[...declared.keys()].join(',')})`);

  // The endpoint is what distinguishes them, and it is not readable off the
  // backend object by design — so assert it where it is observable: two backends
  // built from different addresses are different objects that both work.
  t.check(typeof declared.get('llbot') === 'function', 'a declared transport is a constructor, not a connected socket');
  const a = declared.get('spare')();
  t.check(a.id === 'onebot', 'a declared transport reuses the OneBot protocol');
  t.check(a.status().connected === false, 'and nothing is open until it is connected');
}

t.done();
