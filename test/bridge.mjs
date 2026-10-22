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

// --- a quoted picture --------------------------------------------------------
{
  // The live shape: reply to a picture, add an @, send. The quote contributes no
  // text, so without resolving it the message is empty and the model answers its
  // own reasoning. With it, the picture comes back and the turn is real.
  const backend = fakeBackend();
  backend.getQuoted = async (id) => (id === '1011000443'
    ? { text: '', images: [{ url: 'https://example/quoted.jpg' }] }
    : null);
  const host = fakeHost({ answer: '看到了。' });
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'mention' }) });
  await bridge.start();

  backend.emit(messageEvent({
    target: { kind: 'group', id: '1070071261', name: '群' },
    text: '@你',
    mentionsSelf: true,
    replyTo: '1011000443',
    messageId: 'q-1',
  }));
  await until(() => backend.sent.length === 1, { label: 'the reply to a quoted picture' });
  t.check(host.calls.length === 1, 'a bare @ that quotes a picture reaches the agent');
  t.check(host.calls[0].event.images.length === 1, `the quoted image came along (got ${host.calls[0].event.images.length})`);
  t.check(host.calls[0].event.images[0].url === 'https://example/quoted.jpg', 'and it is the one that was quoted');
  await bridge.stop();
}

{
  // A quote that cannot be resolved must not turn into a turn: an empty line is
  // still an empty line, and answering it is what leaked reasoning once.
  const backend = fakeBackend();
  backend.getQuoted = async () => null;
  const host = fakeHost();
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'mention' }) });
  await bridge.start();
  backend.emit(messageEvent({
    target: { kind: 'group', id: '1070071261', name: '群' },
    text: '@你',
    mentionsSelf: true,
    replyTo: 'missing',
    messageId: 'q-2',
  }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  t.check(host.calls.length === 0, 'an unresolvable quote with no words is not a turn');
  await bridge.stop();
}

// --- auto --------------------------------------------------------------------
// `auto` is the mode where the agent decides whether the room wants to hear from
// it. Three properties are what make that safe rather than expensive: the room's
// recent lines reach the agent, a run of short messages costs one turn rather
// than five, and saying nothing actually sends nothing.
{
  const backend = fakeBackend();
  const host = fakeHost({ answer: '在打游戏 (´-ω-`)' });
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'auto' }) });
  await bridge.start();

  const groupMessage = (text, over = {}) =>
    messageEvent({
      target: { kind: 'group', id: '1070071261', name: '群' },
      sender: { id: '10001', name: '晚晚', card: '' },
      text,
      ...over,
    });

  backend.emit(groupMessage('有人吗', { messageId: 'a-1' }));
  await until(() => backend.sent.length === 1, { label: 'the auto reply' });
  t.check(host.calls.length === 1, 'auto wakes the agent for a message not addressed to it');
  t.check(host.calls[0].event.autoContext === true, 'the turn is marked as a room transcript');
  t.check(host.calls[0].text.includes('有人吗'), 'the transcript contains what was actually said');
  t.check(host.calls[0].text.includes('SILENT'), 'and offers silence as an answer');

  // Every line is judged by default. The throttle is opt-in now, because its
  // implementation drops the message rather than deferring it — so the last thing
  // a room says before going quiet used to be the one thing never looked at.
  backend.emit(groupMessage('在打游戏吗', { messageId: 'a-2' }));
  backend.emit(groupMessage('算了 你们玩', { messageId: 'a-3' }));
  await until(() => host.calls.length === 3, { label: 'the two further judgements' });
  t.check(host.calls.length === 3, 'without the throttle, each line reaches the agent');
  t.check(
    host.calls[2].text.includes('算了 你们玩'),
    'and the last line of a burst is judged, not lost'
  );

  // A mention is not a judgement call, so it never waits for an interval.
  backend.emit(groupMessage('@你 你来不来', { messageId: 'a-4', mentionsSelf: true }));
  await until(() => host.calls.length === 4, { label: 'the reply to the mention' });
  t.check(host.calls.length === 4, 'a mention still reaches the agent');
  t.check(
    host.calls[3].text.includes('叫你'),
    'and the brief says it is addressed to her rather than to the room'
  );
  await bridge.stop();
}

{
  // The whole point of `auto`: "not now" is an answer, and it is silent.
  const backend = fakeBackend();
  const host = fakeHost({ answer: () => 'SILENT' });
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'auto' }) });
  await bridge.start();
  backend.emit(
    messageEvent({
      target: { kind: 'group', id: '1070071261', name: '群' },
      sender: { id: '10001', name: '晚晚', card: '' },
      text: '他们俩在吵架 别理',
      messageId: 's-1',
    })
  );
  await until(() => host.calls.length === 1, { label: 'the decision' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  t.check(host.calls.length === 1, 'the agent was asked');
  t.check(backend.sent.length === 0, 'and nothing was sent when it said SILENT');
  await bridge.stop();
}

{
  // A reply that merely contains the word is a reply. Swallowing it would hide a
  // real answer behind an escape hatch meant for refusals.
  const backend = fakeBackend();
  const host = fakeHost({ answer: '我不说 SILENT 那个词，但我在' });
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'auto' }) });
  await bridge.start();
  backend.emit(
    messageEvent({
      target: { kind: 'group', id: '1070071261', name: '群' },
      sender: { id: '10001', name: '晚晚', card: '' },
      text: '你在吗',
      messageId: 'w-1',
    })
  );
  await until(() => backend.sent.length === 1, { label: 'the sentence' });
  t.check(backend.sent[0].content.text.includes('但我在'), 'a sentence containing SILENT is still sent');
  await bridge.stop();
}

{
  // The names in the transcript are what make a room readable. `card` arrives as
  // an empty string far more often than as undefined, and a naive `??` fallback
  // turned every speaker into "某人".
  const backend = fakeBackend();
  const host = fakeHost({ answer: 'SILENT' });
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'auto' }) });
  await bridge.start();
  backend.emit(
    messageEvent({
      target: { kind: 'group', id: '1070071261', name: '群' },
      sender: { id: '10001', name: '不想', card: '' },
      text: '焊电路板的来',
      messageId: 'n-1',
    })
  );
  await until(() => host.calls.length === 1, { label: 'the decision' });
  t.check(host.calls[0].text.includes('不想: 焊电路板的来'), 'an empty group card falls back to the nickname');
  t.check(!host.calls[0].text.includes('某人'), 'and does not leave a placeholder speaker');
  await bridge.stop();
}

{
  // The group nickname wins when there is one, because that is what the room sees.
  const backend = fakeBackend();
  const host = fakeHost({ answer: 'SILENT' });
  const bridge = createBridge({ backend, host, settings: settings({ groupMode: 'auto' }) });
  await bridge.start();
  backend.emit(
    messageEvent({
      target: { kind: 'group', id: '1070071261', name: '群' },
      sender: { id: '10001', name: '不想', card: '工兵' },
      text: '意思更改频率了？',
      messageId: 'n-2',
    })
  );
  await until(() => host.calls.length === 1, { label: 'the decision' });
  t.check(host.calls[0].text.includes('工兵: 意思更改频率了？'), 'a group card is used when present');
  await bridge.stop();
}

t.done();
