// policy.mjs: the four decisions made before anything is sent, and the one
// decision made before anything is read.
//
// These are the functions whose bugs are invisible in a single test message and
// obvious after a week of uptime: a group answered too eagerly, the same message
// handled twice after a reconnect, an account that sends without a gap, a
// companion that checks in forty times.
import { admit, createDailyBudget, createDedupe, createRateLimiter, GROUP_MODES, sessionKey } from '../lib/policy.js';
import { messageEvent, suite } from './helpers.mjs';

const t = suite('policy');

/** A group message from somebody else. */
const group = (over = {}) => messageEvent({
  target: { kind: 'group', id: '67890', name: '学习小组' },
  sender: { id: '10001', name: '晚晚', card: '' },
  ...over,
});

// --- admit ------------------------------------------------------------------
t.check(GROUP_MODES.join(',') === 'always,mention,off', 'the three modes are the documented three');

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
