// socket.mjs: the whole stack over a real socket, with a fake agent.
//
// The unit suites each test one seam. This one checks the seams together: a real
// `WebSocket` handshake, a real frame codec, the real backend, the real policy and
// queueing, and back out through the same socket. The only thing replaced is the
// model, because a test that needs a model is a test that costs money and fails
// when somebody else's API does.
import { createBridge } from '../lib/bridge.js';
import { createOneBotBackend } from '../lib/onebot.js';
import { renderInbound } from '../lib/text.js';
import { startFakeOneBot, waitFor } from './fake-onebot-server.mjs';
import { fakeHost, suite } from './helpers.mjs';

const t = suite('socket');

/**
 * Wrap a fake host the way the plugin mounts it.
 *
 * The bridge hands the host the admitted text; adding the "who said this, and
 * where" envelope is the controller's job (see `lib/index.js`). Reproducing that
 * one line here is the point: it is the difference between an agent that knows it
 * is in a group and one that thinks a stranger is talking to it privately.
 *
 * @param {any} host - the fake host.
 * @returns {any} a host the bridge can drive.
 */
function envelope(host) {
  return {
    calls: host.calls,
    handle: (event, text, key) => host.handle(event, renderInbound({ ...event, text }, { language: 'zh' }), key),
  };
}

const settings = (over = {}) => ({
  groupMode: 'mention',
  allowedGroups: [],
  minimumGapMs: 0,
  dailyProactive: 0,
  maxChars: 1200,
  ...over,
});

// --- a private conversation, end to end --------------------------------------
{
  const bot = await startFakeOneBot({ selfId: '99999' });
  const backend = createOneBotBackend({ endpoint: bot.endpoint, log: () => {} });
  const host = envelope(fakeHost({ answer: '在的，怎么了？' }));
  const bridge = createBridge({ backend, host, settings: settings(), log: () => {} });
  await bridge.start();
  await waitFor(() => backend.selfId === '99999', { label: 'the login info' });
  t.check(backend.selfId === '99999', 'the account id crossed a real socket');
  t.check(bot.actions[0]?.action === 'get_login_info', 'the handshake asked who we are');

  bot.inbound('private', { text: '在吗', name: '林晚' });
  await waitFor(() => bot.sent.length === 1, { label: 'the reply' });
  t.check(host.calls.length === 1, 'the agent ran once');
  t.check(host.calls[0].text === '林晚：在吗', `the agent saw the envelope, not the raw text (got "${host.calls[0].text}")`);
  t.check(bot.sent[0].kind === 'private', 'the reply went out as a private message');
  t.check(bot.sent[0].id === '10001', 'to the person who wrote');
  t.check(bot.sent[0].text === '在的，怎么了？', 'with the agent’s words');
  t.check(bot.actions.some((item) => item.action === 'send_private_msg'), 'through send_private_msg');

  // The same socket, a second message: the connection is reused rather than
  // reopened, which is what keeps a long conversation from reconnecting per turn.
  bot.inbound('private', { text: '没什么，就是想问问' });
  await waitFor(() => bot.sent.length === 2, { label: 'the second reply' });
  t.check(bot.clients().length === 1, 'the second turn reused the same socket');
  await bridge.stop();
  await bot.close();
}

// --- a group, mentioned -------------------------------------------------------
{
  const bot = await startFakeOneBot();
  const backend = createOneBotBackend({ endpoint: bot.endpoint, log: () => {} });
  const host = envelope(fakeHost({ answer: '那就别去了。' }));
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'mention' }), log: () => {} });
  await bridge.start();
  await waitFor(() => backend.selfId === '99999', { label: 'the login info' });

  bot.inbound('group', { text: '今天不去上课了', name: '晚晚', groupName: '学习小组' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  t.check(bot.sent.length === 0, 'group chatter without a mention is not answered');

  bot.inbound('group', { text: '今天不去上课了', name: '晚晚', atMe: true });
  await waitFor(() => bot.sent.length === 1, { label: 'the group reply' });
  t.check(bot.sent[0].kind === 'group', 'the reply went to the group');
  t.check(bot.sent[0].id === '67890', 'and to the right group');
  t.check(host.calls[0].text.includes('[群 学习小组]'), `the agent was told where it is (got "${host.calls[0].text}")`);
  t.check(host.calls[0].text.includes('晚晚'), 'and who spoke');
  t.check(!host.calls[0].text.includes('@你'), 'the synthesized mention marker was removed before the agent saw it');
  await bridge.stop();
  await bot.close();
}

// --- a backend that refuses ---------------------------------------------------
{
  const bot = await startFakeOneBot();
  const backend = createOneBotBackend({ endpoint: bot.endpoint, log: () => {} });
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings(), log: () => {} });
  await bridge.start();
  await waitFor(() => backend.selfId === '99999', { label: 'the login info' });
  bot.failNext('send_private_msg', { retcode: 100, wording: '账号被风控' });
  bot.inbound('private', { text: '在吗' });
  await waitFor(() => host.calls.length === 1, { label: 'the turn' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  t.check(bot.sent.length === 0, 'a refused send delivered nothing');
  // The turn still happened: the model answered, the transport said no. Those are
  // different failures and only one of them is the model's problem.
  t.check(host.calls.length === 1, 'the turn was not repeated because of a transport failure');
  await bridge.stop();
  await bot.close();
}

// --- a backend that is not there ----------------------------------------------
{
  // The bridge must survive a backend that is down at boot: the harness should
  // start, the agent should still be usable, and only sending notices.
  const backend = createOneBotBackend({ endpoint: 'ws://127.0.0.1:1', reconnectMinMs: 100, log: () => {} });
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings(), log: () => {} });
  await bridge.start();
  t.check(bridge.stats().connected === false, 'a bridge with no backend reports disconnected rather than failing');
  const result = await bridge.sendProactive({ kind: 'private', id: '10001' }, '在吗');
  t.check(result.ok === false, 'a proactive send with no backend fails instead of hanging');
  await bridge.stop();
}

// --- a long answer over a real socket ----------------------------------------
{
  const bot = await startFakeOneBot();
  const backend = createOneBotBackend({ endpoint: bot.endpoint, log: () => {} });
  const long = '这句话有点长。'.repeat(40);
  const host = fakeHost({ answer: long });
  const bridge = createBridge({ backend, host, settings: settings({ maxChars: 80 }), log: () => {} });
  await bridge.start();
  await waitFor(() => backend.selfId === '99999', { label: 'the login info' });
  bot.inbound('private', { text: '说说看' });
  await waitFor(() => bot.sent.length > 1, { label: 'the pieces' });
  t.check(bot.sent.map((item) => item.text).join('') === long, 'the pieces reassemble into the answer on the far side of the socket');
  await bridge.stop();
  await bot.close();
}

t.done();
