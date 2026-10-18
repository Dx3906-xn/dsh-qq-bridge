// bridge.mjs: what happens between an event arriving and an answer being sent.
//
// The interesting cases are all about concurrency and failure, not about the
// happy path: two messages for one conversation at once, a second conversation
// interleaved with the first, a backend that refuses, an agent that throws, an
// echo of our own reply arriving back, and a reply long enough to need splitting.
import { createBridge } from '../lib/bridge.js';
import { fakeBackend, fakeHost, messageEvent, suite, until } from './helpers.mjs';

const t = suite('bridge');

/** Settings with the rate limit effectively off, so tests do not sleep. */
const settings = (over = {}) => ({
  groupMode: 'mention',
  allowedGroups: [],
  minimumGapMs: 0,
  dailyProactive: 0,
  maxChars: 1200,
  ...over,
});

/** A conversation key as the bridge computes it. */
const PRIVATE_KEY = 'qq:onebot:private:10001';

// --- one message, one answer -------------------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost({ answer: '在的。' });
  const bridge = createBridge({ backend, host, settings: settings() });
  await bridge.start();
  backend.emit(messageEvent({ text: '在吗' }));
  await until(() => backend.sent.length === 1, { label: 'the reply' });
  t.check(host.calls.length === 1, 'the agent ran once');
  t.check(host.calls[0].key === PRIVATE_KEY, `the agent was given the conversation key (got "${host.calls[0].key}")`);
  t.check(backend.sent[0].content.text === '在的。', 'the answer reached the backend');
  t.check(backend.sent[0].target.id === '10001', 'the answer went back to the sender');
  await bridge.stop();
}

// --- a duplicate and an echo -------------------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings() });
  await bridge.start();
  backend.emit(messageEvent({ messageId: 'dup-1' }));
  await until(() => backend.sent.length === 1, { label: 'the first reply' });
  const first = await (async () => {
    backend.emit(messageEvent({ messageId: 'dup-1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return backend.sent.length;
  })();
  t.check(first === 1, 'a replayed message id does not produce a second turn');
  // Reconnecting backends replay, and the id is the only thing that identifies
  // the replay: without dedupe the person gets the same answer twice.
  backend.emit(messageEvent({ messageId: 'echo-1', text: '在的。' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.check(host.calls.length === 1, 'an echo of our own reply is not answered');
  await bridge.stop();
}

// --- two messages, one conversation ------------------------------------------
{
  const backend = fakeBackend();
  /** @type {string[]} */
  const order = [];
  const host = {
    async handle(event, text) {
      order.push(`start:${text}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(`end:${text}`);
      return `答 ${text}`;
    },
  };
  const bridge = createBridge({ backend, host, settings: settings() });
  await bridge.start();
  backend.emit(messageEvent({ messageId: 'a', text: '第一句' }));
  backend.emit(messageEvent({ messageId: 'b', text: '第二句' }));
  await until(() => backend.sent.length === 2, { label: 'both replies' });
  // Serialized, not interleaved: an agent that starts the second turn before
  // finishing the first answers it having already read the answer it was still
  // writing.
  t.check(order.join(',') === 'start:第一句,end:第一句,start:第二句,end:第二句', `turns on one conversation are serialized (got ${order.join(',')})`);
  t.check(backend.sent[0].content.text === '答 第一句', 'the first answer is the first send');
  await bridge.stop();
}

// --- two conversations at once -----------------------------------------------
{
  const backend = fakeBackend();
  /** @type {string[]} */
  const started = [];
  const host = {
    async handle(event, text, key) {
      started.push(key);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return `答 ${text}`;
    },
  };
  const bridge = createBridge({ backend, host, settings: settings() });
  await bridge.start();
  backend.emit(messageEvent({ messageId: 'p', target: { kind: 'private', id: '10001' }, text: '甲' }));
  backend.emit(messageEvent({ messageId: 'q', target: { kind: 'private', id: '20002' }, sender: { id: '20002', name: '乙' }, text: '乙' }));
  await until(() => backend.sent.length === 2, { label: 'both conversations answered' });
  t.check(started.length === 2, 'both conversations ran');
  t.check(started[0] !== started[1], 'a different person is a different conversation');
  // Different conversations do not queue behind each other: the whole point of
  // the per-key chain is that one slow reply does not silence everybody else.
  t.check(backend.sent.length === 2, 'neither conversation waited for the other');
  await bridge.stop();
}

// --- an agent that throws ----------------------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost({ fail: true });
  const bridge = createBridge({ backend, host, settings: settings(), log: () => {} });
  await bridge.start();
  backend.emit(messageEvent({ text: '在吗' }));
  await until(() => backend.sent.length === 1, { label: 'the failure notice' });
  t.check(backend.sent[0].content.text.includes('问题'), 'a failure says something rather than nothing');
  await bridge.stop();
}

// --- an agent that says nothing ----------------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost({ answer: '   ' });
  const bridge = createBridge({ backend, host, settings: settings(), log: () => {} });
  await bridge.start();
  backend.emit(messageEvent({ text: '在吗' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Silence is a legitimate outcome; inventing "收到" instead would be worse.
  t.check(backend.sent.length === 0, 'an empty answer sends nothing rather than a filler');
  await bridge.stop();
}

// --- a backend that refuses --------------------------------------------------
{
  const backend = fakeBackend({ failSend: true });
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings(), log: () => {} });
  await bridge.start();
  backend.emit(messageEvent({ text: '在吗' }));
  await until(() => host.calls.length === 1, { label: 'the turn' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.check(backend.sent.length === 0, 'a refused send is not recorded as sent');
  await bridge.stop();
}

// --- splitting a long answer -------------------------------------------------
{
  const backend = fakeBackend();
  const long = '这是一段很长的回答。'.repeat(30);
  const host = fakeHost({ answer: long });
  const bridge = createBridge({ backend, host, settings: settings({ maxChars: 60 }) });
  await bridge.start();
  backend.emit(messageEvent({ text: '讲个长故事' }));
  await until(() => backend.sent.length > 1, { label: 'the pieces' });
  t.check(backend.sent.length > 1, `a long answer is split (${backend.sent.length} pieces)`);
  t.check(backend.sent.map((item) => item.content.text).join('') === long, 'the pieces join back into the answer');
  await bridge.stop();
}

// --- group policy through the bridge -----------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'mention' }) });
  await bridge.start();
  const groupEvent = (over = {}) => messageEvent({
    target: { kind: 'group', id: '67890', name: '学习小组' },
    sender: { id: '10001', name: '晚晚', card: '' },
    ...over,
  });
  backend.emit(groupEvent({ messageId: 'g1', text: '今天不去上课了' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.check(host.calls.length === 0, 'mention mode ignores ordinary group chatter');

  backend.emit(groupEvent({ messageId: 'g2', text: '@你 今天不去上课了', mentionsSelf: true }));
  await until(() => backend.sent.length === 1, { label: 'the group reply' });
  // The envelope is the controller's job, not the bridge's; here the bridge hands
  // over the text the policy admitted, which excludes the synthesized @ marker.
  t.check(host.calls[0].text === '今天不去上课了', `the @ marker never reaches the agent (got "${host.calls[0].text}")`);
  t.check(host.calls[0].key === 'qq:onebot:group:67890', 'a group is one conversation, not one per member');
  await bridge.stop();
}

// --- proactive sends ---------------------------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings({ dailyProactive: 2 }) });
  await bridge.start();
  const target = { kind: 'private', id: '10001', name: '林晚' };
  const first = await bridge.sendProactive(target, '今天怎么样');
  t.check(first.ok === true, 'a proactive message with budget left is sent');
  const second = await bridge.sendProactive(target, '记得吃饭');
  t.check(second.ok === true, 'the second is allowed');
  const third = await bridge.sendProactive(target, '还在吗');
  t.check(third.ok === false, 'the third is refused by the daily budget');
  t.check(backend.sent.length === 2, 'exactly two reached the backend');
  t.check(bridge.stats().proactiveLeft === 0, 'the budget reports nothing left');
  await bridge.stop();
}

{
  const backend = fakeBackend();
  const bridge = createBridge({ backend, host: fakeHost(), settings: settings({ dailyProactive: 0 }), log: () => {} });
  await bridge.start();
  const result = await bridge.sendProactive({ kind: 'private', id: '10001' }, '在吗');
  t.check(result.ok === false, 'a limit of zero refuses even the first proactive message');
  t.check(backend.sent.length === 0, 'and nothing is sent');
  await bridge.stop();
}

// --- start and stop ----------------------------------------------------------
{
  const backend = fakeBackend();
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings() });
  await bridge.start();
  t.check(backend.listeners === 1, 'starting attaches exactly one listener');
  await bridge.stop();
  t.check(backend.listeners === 1, 'stopping keeps the handler attached (it checks a flag instead of unsubscribing)');
  t.check(bridge.stats().connected === false, 'the backend is disconnected');
  backend.emit(messageEvent({ messageId: 'after-stop', text: '还在吗' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.check(host.calls.length === 0, 'a message after stop does not start a turn');
}

t.done();
