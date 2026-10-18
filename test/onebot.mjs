// onebot.mjs: the real backend against a fake socket.
//
// The front half of this file checks the protocol translation (which is where a
// bridge silently loses images, self-messages, or the difference between a group
// and a friend). The back half checks the failure behaviour, which is the half
// that only shows up in production: a backend that restarts, a socket that drops,
// an action that answers with a non-zero retcode.
import { createOneBotBackend } from '../lib/onebot.js';
import { createFakeServer } from './fake-onebot.mjs';
import { suite, until } from './helpers.mjs';

const t = suite('onebot');

/** A backend wired to a fresh fake server. */
function wired(over = {}) {
  const server = createFakeServer();
  const backend = createOneBotBackend({
    endpoint: 'ws://127.0.0.1:3001',
    WebSocketImpl: server.Impl,
    reconnectMinMs: 100,
    log: () => {},
    ...over,
  });
  return { server, backend };
}

/** An inbound private message as NapCat shapes it: segments in an array. */
function inboundPrivate(over = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7001,
    user_id: 10001,
    time: 1_791_000_000,
    self_id: 99999,
    sender: { user_id: 10001, nickname: '林晚', card: '' },
    message: [{ type: 'text', data: { text: '在吗' } }],
    raw_message: '在吗',
    ...over,
  };
}

/** An inbound group message. */
function inboundGroup(over = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: 67890,
    group_name: '学习小组',
    message_id: 7002,
    user_id: 10001,
    time: 1_791_000_100,
    sender: { user_id: 10001, nickname: '晚晚', card: '晚晚同学' },
    message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: ' 今天不去上课了' } }],
    ...over,
  };
}

// --- connecting -------------------------------------------------------------
{
  const { server, backend } = wired();
  const events = [];
  backend.onEvent((event) => events.push(event));
  await backend.connect();
  await until(() => backend.selfId !== '', { label: 'login info' });
  t.check(server.connected === true, 'the socket opened');
  t.check(backend.selfId === '99999', `the account id was read from the backend (got "${backend.selfId}")`);
  t.check(server.received[0]?.action === 'get_login_info', 'the first action asks who we are');
  t.check(backend.status().connected === true, 'status reports connected');

  server.push(inboundPrivate());
  await until(() => events.length === 1, { label: 'one event' });
  const event = events[0];
  t.check(event.kind === 'message', 'kind is message');
  t.check(event.target.kind === 'private' && event.target.id === '10001', `a private message targets the sender (got ${event.target.kind}:${event.target.id})`);
  t.check(event.sender.name === '林晚', `the sender name is carried (got "${event.sender.name}")`);
  t.check(event.text === '在吗', `the text is flattened (got "${event.text}")`);
  t.check(event.messageId === '7001', `the message id is a string (got "${event.messageId}")`);
  t.check(event.at === 1_791_000_000_000, 'the timestamp is seconds in, milliseconds out');
  t.check(event.mentionsSelf === false, 'a private message is not a mention');

  server.push(inboundGroup());
  await until(() => events.length === 2, { label: 'two events' });
  const group = events[1];
  t.check(group.target.kind === 'group' && group.target.id === '67890', 'a group message targets the group');
  t.check(group.target.name === '学习小组', `the group name is carried (got "${group.target.name}")`);
  t.check(group.sender.card === '晚晚同学', 'the group card is carried separately from the nickname');
  t.check(group.mentionsSelf === true, 'an @ of this account is a mention');
  t.check(group.text === '@你 今天不去上课了', `the @ survives into the text (got "${group.text}")`);
  await backend.disconnect();
}

// --- what is not a conversation ----------------------------------------------
{
  const { server, backend } = wired();
  const events = [];
  backend.onEvent((event) => events.push(event));
  await backend.connect();
  // Our own message looped back: answering it is the bot talking to itself.
  server.push(inboundPrivate({ user_id: 99999, sender: { user_id: 99999, nickname: '自己' } }));
  // A notice and a request are not messages, and a transport that forwards them
  // hands the model a lever it must never pull.
  server.push({ post_type: 'notice', notice_type: 'group_increase', group_id: 67890, user_id: 10001 });
  server.push({ post_type: 'request', request_type: 'friend', user_id: 10001 });
  // A message with no sender id cannot be answered to anybody.
  server.push(inboundPrivate({ user_id: undefined, sender: {} }));
  // A truncated frame is dropped rather than crashing the listener.
  server.push('{not json');
  server.push(inboundPrivate({ message_id: 7003, message_type: 'guild', message: [] }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.check(events.length === 0, `none of those became an event (got ${events.length})`);
  await backend.disconnect();
}

// --- sending -----------------------------------------------------------------
{
  const { server, backend } = wired();
  await backend.connect();
  await until(() => backend.selfId !== '', { label: 'login info' });

  const toPrivate = await backend.send({ kind: 'private', id: '10001' }, { text: '在的。' });
  t.check(toPrivate.ok === true, 'a private send succeeds');
  const privateAction = server.received.find((item) => item.action === 'send_private_msg');
  t.check(privateAction !== undefined, 'it used send_private_msg');
  t.check(privateAction.params.user_id === 10001, 'the user id is a number on the wire, not a string');
  t.check(privateAction.params.message === '在的。', 'the text is the message body');
  t.check(toPrivate.id === '', `the message id comes back when the backend gives one (got "${toPrivate.id}")`);

  server.replies.push({ message_id: 8001 });
  const withReply = await backend.send({ kind: 'private', id: '10001' }, { text: '嗯' });
  t.check(withReply.id === '8001', `the backend message id is reported (got "${withReply.id}")`);

  const toGroup = await backend.send({ kind: 'group', id: '67890' }, { text: '大家好' });
  t.check(toGroup.ok === true, 'a group send succeeds');
  const groupAction = server.received.find((item) => item.action === 'send_group_msg');
  t.check(groupAction !== undefined, 'it used send_group_msg');
  t.check(groupAction.params.group_id === 67890, 'the group id is on the wire');

  await backend.disconnect();
}

// --- a backend that says no --------------------------------------------------
{
  const { server, backend } = wired();
  await backend.connect();
  await until(() => backend.selfId !== '', { label: 'login info' });
  server.replies.push({ retcode: 100, wording: '账号被风控' });
  const failed = await backend.send({ kind: 'private', id: '10001' }, { text: '在的。' });
  // OneBot reports failure in-band. Reading only `data` and ignoring `retcode`
  // is how a bridge believes it delivered a message nobody received.
  t.check(failed.ok === false, 'a non-zero retcode is a failed send');
  t.check(String(failed.error).includes('风控'), `the backend's wording is surfaced (got "${failed.error}")`);

  await backend.disconnect();
  const afterClose = await backend.send({ kind: 'private', id: '10001' }, { text: '还在吗' });
  t.check(afterClose.ok === false, 'sending while disconnected fails rather than hanging');
  t.check(String(afterClose.error).includes('not connected'), `and says the reason (got "${afterClose.error}")`);
}

// --- the timeout path --------------------------------------------------------
{
  const server = createFakeServer();
  const backend = createOneBotBackend({
    endpoint: 'ws://127.0.0.1:3001',
    WebSocketImpl: server.Impl,
    callTimeoutMs: 40,
    log: () => {},
  });
  await backend.connect();
  // A backend that accepts the frame and never answers: the call must give up
  // instead of leaving the turn waiting forever.
  server.replies.push(undefined);
  const original = server.Impl.prototype.send;
  server.Impl.prototype.send = function swallow(frame) {
    receivedPush(server, frame);
  };
  function receivedPush(target, frame) {
    target.received.push(JSON.parse(frame));
  }
  const pendingSend = await backend.send({ kind: 'private', id: '10001' }, { text: '在吗' });
  server.Impl.prototype.send = original;
  t.check(pendingSend.ok === false, 'an unanswered action times out');
  t.check(String(pendingSend.error).includes('timed out'), `and says so (got "${pendingSend.error}")`);
  await backend.disconnect();
}

// --- reconnecting ------------------------------------------------------------
{
  const { server, backend } = wired({ reconnectMinMs: 30 });
  await backend.connect();
  await until(() => backend.selfId !== '', { label: 'login info' });
  const before = server.attempts;
  // A backend restarting mid-conversation: the socket closes and the bridge must
  // come back without an operator doing anything.
  server.sockets[server.sockets.length - 1].close(1006);
  t.check(backend.status().connected === false, 'a dropped socket reports disconnected');
  await until(() => server.attempts > before, { label: 'a reconnect attempt', timeoutMs: 2000 });
  t.check(server.attempts > before, `the backend reconnected by itself (${server.attempts} attempts)`);
  await until(() => backend.status().connected === true, { label: 'the new socket', timeoutMs: 2000 });
  t.check(backend.status().connected === true, 'and is connected again');
  await backend.disconnect();
  const settled = server.attempts;
  await new Promise((resolve) => setTimeout(resolve, 120));
  t.check(server.attempts === settled, 'after an explicit disconnect it stops reconnecting');
}

// --- the teardown settles everything ----------------------------------------
{
  const { server, backend } = wired();
  await backend.connect();
  await until(() => backend.selfId !== '', { label: 'login info' });
  server.replies.push(undefined);
  const inflight = backend.send({ kind: 'private', id: '10001' }, { text: '在吗' });
  await backend.disconnect();
  const result = await inflight;
  t.check(result.ok === false, 'an in-flight send is failed by disconnecting, not left pending');
}

t.done();
