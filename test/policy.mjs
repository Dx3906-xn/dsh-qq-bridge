// policy.mjs: the four decisions made before anything is sent, and the one
// decision made before anything is read.
//
// These are the functions whose bugs are invisible in a single test message and
// obvious after a week of uptime: a group answered too eagerly, the same message
// handled twice after a reconnect, an account that sends without a gap, a
// companion that checks in forty times.
import {
  admit,
  createAutoThrottle,
  createDailyBudget,
  createDedupe,
  createRateLimiter,
  createRoomLog,
  formatRoomContext,
  GROUP_MODES,
  isSilence,
  sessionKey,
} from '../lib/policy.js';
import { messageEvent, suite } from './helpers.mjs';

const t = suite('policy');

/** A group message from somebody else. */
const group = (over = {}) => messageEvent({
  target: { kind: 'group', id: '67890', name: '学习小组' },
  sender: { id: '10001', name: '晚晚', card: '' },
  ...over,
});

// --- admit ------------------------------------------------------------------
t.check(GROUP_MODES.join(',') === 'always,mention,auto,off', 'the four modes are the documented four');

const privateAlways = admit(messageEvent({ text: '在吗' }), { groupMode: 'off', selfId: '99999' });
t.check(privateAlways.accept === true, 'a private message is answered even when groups are off');
t.check(privateAlways.text === '在吗', 'a private message is handed over unchanged');

const privateEmpty = admit(messageEvent({ text: '' }), { groupMode: 'always', selfId: '99999' });
t.check(privateEmpty.accept === false, 'an empty private message does not wake the agent');
t.check(privateEmpty.reason === 'empty', `and says why (${privateEmpty.reason})`);

const mentionMode = admit(group({ text: '今天不去上课了' }), { groupMode: 'mention', selfId: '99999' });
t.check(mentionMode.accept === false, 'mention mode ignores a group message that is not for us');
t.check(mentionMode.reason === 'not mentioned', `and names the reason (${mentionMode.reason})`);

const mentionHit = admit(group({ text: '@你 今天不去上课了', mentionsSelf: true }), { groupMode: 'mention', selfId: '99999' });
t.check(mentionHit.accept === true, 'mention mode answers when @-ed');
t.check(mentionHit.text === '今天不去上课了', `the synthesized @ marker is stripped (got "${mentionHit.text}")`);

const alwaysMode = admit(group({ text: '随便聊聊' }), { groupMode: 'always', selfId: '99999' });
t.check(alwaysMode.accept === true, 'always mode answers every group message');
t.check(alwaysMode.reason === 'group always', `and names it (${alwaysMode.reason})`);

const alwaysMentioned = admit(group({ text: '@你 在吗', mentionsSelf: true }), { groupMode: 'always', selfId: '99999' });
t.check(alwaysMentioned.text === '在吗', 'always mode strips the @ marker too');

const offMentioned = admit(group({ text: '@你 在吗', mentionsSelf: true }), { groupMode: 'off', selfId: '99999' });
t.check(offMentioned.accept === false, 'off means off even when @-ed: a mention does not overrule the operator');
t.check(offMentioned.reason === 'group mode off', `and says so (${offMentioned.reason})`);

const allowlisted = admit(group({ text: 'hi' }), { groupMode: 'always', selfId: '99999', allowedGroups: ['11111'] });
t.check(allowlisted.accept === false, 'a group outside the allowlist is ignored');
t.check(allowlisted.reason === 'group not allowed', `and names the reason (${allowlisted.reason})`);

const allowlistedHit = admit(group({ text: 'hi' }), { groupMode: 'always', selfId: '99999', allowedGroups: ['67890'] });
t.check(allowlistedHit.accept === true, 'a group on the allowlist is answered');

const emptyGroup = admit(group({ text: '' }), { groupMode: 'always', selfId: '99999' });
t.check(emptyGroup.accept === false, 'an empty group message (an image only) is not a turn');

// Seen live: "@LD" alone flattens to "@你", which is not empty, passes the check
// above, and then leaves nothing once the marker is stripped. The agent answered
// an empty line, and the model wrote its own reasoning out as the reply. The
// decision now happens after the marker is gone.
const bareMention = admit(group({ text: '@你', mentionsSelf: true }), { groupMode: 'mention', selfId: '99999' });
t.check(bareMention.accept === false, 'an @ with no words does not wake the agent');
t.check(bareMention.reason === 'empty after mention', `and says why (${bareMention.reason})`);

const paddedMention = admit(group({ text: '@你   ', mentionsSelf: true }), { groupMode: 'mention', selfId: '99999' });
t.check(paddedMention.accept === false, 'whitespace after the @ does not make it a message');

// A picture with no caption is still content: the image block is what the agent
// reads, so the mention is accepted and the text is simply empty.
const imageOnly = admit(
  group({ text: '@你', mentionsSelf: true, images: [{ url: 'https://example/x.jpg' }] }),
  { groupMode: 'mention', selfId: '99999' }
);
t.check(imageOnly.accept === true, 'an @ with a picture and no words is a turn');
t.check(imageOnly.text === '', 'with no text, because there was none');

const mentionWithWords = admit(group({ text: '@你 在吗', mentionsSelf: true }), { groupMode: 'mention', selfId: '99999' });
t.check(mentionWithWords.accept === true, 'an @ with words is still accepted');
t.check(mentionWithWords.text === '在吗', 'and the marker is stripped');

// --- auto -------------------------------------------------------------------
// `auto` is not "answer everything with an extra step": it accepts the message so
// the agent can read the room, and the decision to *speak* is the agent's. These
// checks pin the acceptance half; the throttling half lives below.
const autoQuiet = admit(group({ text: '今天不去上课了' }), { groupMode: 'auto', selfId: '99999' });
t.check(autoQuiet.accept === true, 'auto mode accepts a message not addressed to it, so the room can be read');
t.check(autoQuiet.reason === 'auto', `and marks it as a decision (${autoQuiet.reason})`);
t.check(autoQuiet.text === '今天不去上课了', 'the text reaches the agent unchanged');

const autoMention = admit(group({ text: '@你 在吗', mentionsSelf: true }), { groupMode: 'auto', selfId: '99999' });
t.check(autoMention.accept === true, 'auto mode accepts a mention');
t.check(autoMention.reason === 'auto mentions this account', `and separates it from a judgement call (${autoMention.reason})`);
t.check(autoMention.text === '在吗', 'the @ marker is stripped in auto too');

const autoOff = admit(group({ text: '@你 在吗', mentionsSelf: true }), { groupMode: 'off', selfId: '99999' });
t.check(autoOff.accept === false, 'auto does not soften off');

// --- isSilence --------------------------------------------------------------
// Saying nothing has to be a first-class answer, and it has to be matched as the
// whole answer: a reply that merely contains the word is a reply.
t.check(isSilence('SILENT') === true, 'the bare word is silence');
t.check(isSilence('  silent  ') === false, 'the word is case-sensitive, so a lowercase slip is still sent');
t.check(isSilence('「SILENT」') === true, 'a quoted form is still a refusal');
t.check(isSilence('SILENT。') === true, 'a trailing full stop does not make it a sentence');
t.check(isSilence('我不说了 SILENT') === false, 'a sentence containing the word is a sentence');
t.check(isSilence('') === false, 'an empty answer is not a refusal, it is a failed turn');

// --- room log ---------------------------------------------------------------
// The transcript is what makes an `auto` decision informed rather than reactive,
// so the bound and the order are both part of the contract.
const room = createRoomLog(3);
room.note('g1', 'a');
room.note('g1', 'b');
t.check(room.size('g1') === 2, 'lines accumulate');
room.note('g1', '');
t.check(room.size('g1') === 2, 'an empty line is not a line');
room.note('g1', 'c');
room.note('g1', 'd');
t.check(room.size('g1') === 3, `the log is bounded (size ${room.size('g1')})`);
t.check(room.read('g1').join(',') === 'b,c,d', `and keeps the newest, in order (${room.read('g1').join(',')})`);
t.check(room.read('g1', 2).join(',') === 'c,d', 'a shorter window takes the tail');
t.check(room.read('nobody').length === 0, 'an unknown room reads as empty rather than throwing');
room.forget('g1');
t.check(room.size('g1') === 0, 'forgetting a room empties it');

// Her own line belongs in the transcript. Without it the brief showed twelve
// lines of other people talking and none of her answer two seconds earlier, so
// she had no way to know she had already spoken — which is how a participant
// ends up answering the same remark twice.
{
  const log = createRoomLog(6);
  log.note('g', '66: 大肥鱼今天有什么安排');
  log.noteSelf('g', '摸鱼 等饭吃', 1_000_000);
  log.note('g', '66: 会越来越肥的');
  t.check(
    log.read('g').join('|') === '66: 大肥鱼今天有什么安排|你: 摸鱼 等饭吃|66: 会越来越肥的',
    'her own line is part of the transcript, in order'
  );
  t.check(log.lastSelfAt('g') === 1_000_000, 'and the last time she spoke is recorded');
  t.check(log.selfCount('g', 1_000_000 + 60_000) === 1, 'and how often in the last hour');
  // The window rolls: an hour later she has not spoken "this hour" any more.
  t.check(log.selfCount('g', 1_000_000 + 3_600_001) === 0, 'and the count rolls off after an hour');

  // An empty line is not something she said.
  const before = log.size('g');
  log.noteSelf('g', '   ', 2_000_000);
  t.check(log.size('g') === before, 'an empty line is not recorded as hers');

  log.forget('g');
  t.check(log.lastSelfAt('g') === 0, 'forgetting a room forgets her own lines too');
}

// --- the interested-bystander line ------------------------------------------
// The brief used to give only reasons somebody else had given her to speak,
// which is the shape of an assistant. A person also speaks because they want to.
{
  const brief = formatRoomContext({ room: '1', lines: ['a: hi'], language: 'zh' });
  t.check(brief.includes('话题你感兴趣'), 'the brief allows joining because the subject interests her');
  t.check(brief.includes('我有没有话说'), 'and frames the question as whether she has something to say');
  t.check(brief.includes('别抢话'), 'while still telling her not to talk over people');
  // The "you have not spoken" line only appears when the caller reports on her,
  // because a brief rendered without that context should not claim to know.
  const first = formatRoomContext({
    room: '1',
    lines: ['a: hi'],
    language: 'zh',
    selfTalk: { sinceLast: 0, countLastHour: 0 },
  });
  t.check(first.includes('你还没在这个群说过话'), 'and says so when she has not spoken yet');

  const after = formatRoomContext({
    room: '1',
    lines: ['a: hi'],
    language: 'zh',
    selfTalk: { sinceLast: 120_000, countLastHour: 1 },
  });
  t.check(after.includes('2 分钟前'), 'or how long ago she spoke');
  const chatty = formatRoomContext({
    room: '1',
    lines: ['a: hi'],
    language: 'zh',
    selfTalk: { sinceLast: 30_000, countLastHour: 4 },
  });
  t.check(chatty.includes('已经说了 4 次'), 'and how many times this hour when it is a lot');

  // A mention is not a judgement call, so none of this guidance appears.
  const mentioned = formatRoomContext({ room: '1', lines: ['a: @你'], language: 'zh', mentioned: true });
  t.check(!mentioned.includes('话题你感兴趣'), 'a mention skips the judgement guidance entirely');
}

// --- auto throttle ----------------------------------------------------------
// Two ceilings preventing two different things: the interval lets a room finish a
// thought, the hourly cap lets a chatty room stay cheap.
let autoClock = 1_000_000;
const autoGuard = createAutoThrottle({ minIntervalMs: 45_000, maxPerHour: 2 }, () => autoClock);
t.check(autoGuard.allow('g1') === true, 'the first decision in a room is allowed');
autoGuard.note('g1');
t.check(autoGuard.allow('g1') === false, 'an immediate second decision is not');
t.check(autoGuard.wait('g1') === 45_000, `and reports the wait (${autoGuard.wait('g1')})`);
t.check(autoGuard.allow('g1', { urgent: true }) === true, 'a mention never waits');
autoClock += 45_000;
t.check(autoGuard.allow('g1') === true, 'after the interval it is allowed again');
autoGuard.note('g1');
t.check(autoGuard.allow('g1') === false, 'the hourly cap stops the third');
t.check(autoGuard.remaining('g1') === 0, `and reports nothing left (${autoGuard.remaining('g1')})`);
t.check(autoGuard.allow('g1', { urgent: true }) === true, 'a mention still gets through the hourly cap');
t.check(autoGuard.allow('g2') === true, 'the ceiling is per room, not global');
autoClock += 3_600_001;
t.check(autoGuard.allow('g1') === true, 'the window rolls off rather than resetting on a clock boundary');

// --- room context -----------------------------------------------------------
const rendered = formatRoomContext({
  room: '67890',
  lines: ['晚晚: 有人吗', '小明: 在打游戏'],
  mentioned: false,
});
t.check(rendered.includes('67890'), 'the rendered context names the room');
t.check(rendered.includes('晚晚: 有人吗'), 'it quotes the lines rather than summarising them');
t.check(rendered.includes('SILENT'), 'and offers silence as an answer');
const renderedMention = formatRoomContext({
  room: '67890',
  lines: ['晚晚: @你 在吗'],
  mentioned: true,
});
t.check(renderedMention.includes('叫你'), 'a mention is framed as addressed to her');
t.check(renderedMention !== rendered, 'the two framings are different');
const renderedEmpty = formatRoomContext({ room: '1', lines: [] });
t.check(typeof renderedEmpty === 'string' && renderedEmpty.length > 0, 'an empty transcript still renders a usable brief');

// A transcript that only forbids reading it as addressed gets silence even when
// the room is discussing her. The guidance has to name the case where joining is
// correct, or `auto` degenerates into `mention`.
t.check(rendered.includes('聊你'), 'the brief names talking-about-her as a reason to join');
t.check(/他.*她.*指你|指你/.test(rendered), 'and says a pronoun can mean her');
t.check(rendered.includes('SILENT'), 'while still offering silence for unrelated chatter');

// What the room calls her is what turns "let's give him an avatar" into a line
// about her. Without the alias the pronoun has no antecedent.
const named = formatRoomContext({
  room: '67890',
  lines: ['不想: @LD 在吗'],
  selfNames: ['大肥鱼', 'LD'],
});
t.check(named.includes('LD'), 'the alias hint names what the room calls her');
t.check(named.includes('大肥鱼'), 'including the full name');
const unnamed = formatRoomContext({ room: '67890', lines: ['x'], selfNames: [] });
t.check(!unnamed.includes('叫你'), 'an empty alias list adds no dangling hint');

// --- dedupe -----------------------------------------------------------------
// The capacity has a floor of 16 on purpose (a caller that asks for 4 gets 16),
// so the bound is proved at the floor rather than at 4.
const dedupe = createDedupe(16);
t.check(dedupe.seen('a') === false, 'an unseen id is unseen');
dedupe.remember('a');
t.check(dedupe.seen('a') === true, 'a remembered id is seen');
t.check(dedupe.seen('') === false, 'the empty id is never treated as a duplicate');
dedupe.remember('');
t.check(dedupe.size() === 1, 'remembering the empty id adds nothing');

for (let i = 0; i < 20; i += 1) dedupe.remember(`id-${i}`);
t.check(dedupe.size() === 16, `the set is bounded at its floor (size ${dedupe.size()})`);
t.check(dedupe.seen('a') === false, 'the oldest id is the one dropped');
t.check(dedupe.seen('id-19') === true, 'the newest id is still there');
const floored = createDedupe(4);
for (let i = 0; i < 20; i += 1) floored.remember(`x-${i}`);
t.check(floored.size() === 16, `a capacity below the floor is raised to it, not honoured (size ${floored.size()})`);

// --- rate limiter -----------------------------------------------------------
let clock = 1_000_000;
const now = () => clock;
const limiter = createRateLimiter(3000, now);
t.check(limiter.ready('k') === true, 'a target never sent to is ready');
t.check(limiter.wait('k') === 0, 'and needs no wait');
limiter.mark('k');
t.check(limiter.ready('k') === false, 'a target just sent to is not ready');
t.check(limiter.wait('k') === 3000, `and waits the full gap (${limiter.wait('k')}ms)`);
t.check(limiter.ready('other') === true, 'the gap is per target, not global');
clock += 2999;
t.check(limiter.ready('k') === false, 'still not ready one millisecond early');
clock += 1;
t.check(limiter.ready('k') === true, 'ready again exactly at the gap');
limiter.reset();
t.check(limiter.ready('k') === true, 'reset clears it');

// --- daily budget -----------------------------------------------------------
let day = new Date(2026, 9, 19, 9, 0, 0).getTime();
const budgetClock = () => day;
const budget = createDailyBudget(2, budgetClock);
t.check(budget.remaining() === 2, 'a fresh day has the full allowance');
t.check(budget.spend() === true, 'the first message is allowed');
t.check(budget.spend() === true, 'the second is allowed');
t.check(budget.spend() === false, 'the third is refused');
t.check(budget.remaining() === 0, 'the allowance is spent');
day = new Date(2026, 9, 20, 0, 1, 0).getTime();
t.check(budget.remaining() === 2, 'a new local day restores the allowance');
t.check(budget.spend() === true, 'and the send is allowed again');

const disabled = createDailyBudget(0, budgetClock);
t.check(disabled.spend() === false, 'a limit of zero refuses every proactive message');
t.check(disabled.allow() === false, 'and reports nothing allowed');
t.check(disabled.remaining() === 0, 'with nothing remaining');

// --- session key ------------------------------------------------------------
const key = sessionKey('onebot', { kind: 'private', id: '10001' });
t.check(key === 'qq:onebot:private:10001', `the key is readable (got "${key}")`);
t.check(sessionKey('onebot', { kind: 'group', id: '10001' }) !== key, 'a group and a friend with the same id are different conversations');
t.check(sessionKey('gui', { kind: 'private', id: '10001' }) !== key, 'two backends do not share a conversation');
// The separator is what makes this safe: without encoding, an id containing a
// colon could forge the kind segment and land a private message in a group.
t.check(sessionKey('onebot', { kind: 'private', id: 'a:group:67890' }) === 'qq:onebot:private:a%3Agroup%3A67890', 'an id containing the separator cannot forge another key');

// --- away messages ----------------------------------------------------------
// Seen on the first live run: the bridge answered a canned "[自动回复]" and paid
// for a full model call, and the sentence would have been filed in memory as
// something the person said about themselves.
const away = '[自动回复]你好，我现在有事不在，一会再和你联系。';
const awayDecision = admit(messageEvent({ text: away }), { groupMode: 'mention', selfId: '', ignoreAutoReply: true });
t.check(awayDecision.accept === false, 'a canned away-message does not wake the agent');
t.check(awayDecision.reason === 'auto reply', `and says why (got "${awayDecision.reason}")`);
t.check(
  admit(messageEvent({ text: away }), { groupMode: 'mention', selfId: '', ignoreAutoReply: false }).accept === true,
  'the filter can be turned off by the operator',
);
t.check(
  admit(messageEvent({ text: '我跟朋友说我开了自动回复，结果被他笑了一天' }), { groupMode: 'mention', selfId: '', ignoreAutoReply: true }).accept === true,
  'the phrase in the middle of a sentence is just a sentence',
);
t.check(
  admit(messageEvent({ text: '你好，我现在有事不在，一会再和你联系。' }), { groupMode: 'mention', selfId: '', ignoreAutoReply: true }).accept === true,
  'and the marker is what identifies it, not the wording alone',
);
t.check(
  admit(messageEvent({ text: away, target: { kind: 'group', id: '67890' } }), { groupMode: 'always', selfId: '', ignoreAutoReply: true }).accept === false,
  'a group with always does not answer an away-message either',
);

t.done();
