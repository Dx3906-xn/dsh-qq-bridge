// text.mjs: OneBot's format on the way in, the platform's limits on the way out.
//
// The cases that matter are the ones a real backend produces and a hand-written
// fixture would not: an array of segments from NapCat, a CQ-code string from an
// older sender, an @ of this account mixed into a sentence, and a reply long
// enough that cutting it badly is visible to the person reading it.
import { cleanOutbound, flattenMessage, renderInbound, splitMessage, unescapeCq } from '../lib/text.js';
import { messageEvent, suite } from './helpers.mjs';

const t = suite('text');

// --- escapes ----------------------------------------------------------------
t.check(unescapeCq('&#91;图片&#93;') === '[图片]', 'bracket escapes decode');
t.check(unescapeCq('a&#44;b') === 'a,b', 'comma escape decodes');
t.check(unescapeCq('a&amp;b') === 'a&b', 'ampersand decodes');
// The order in CQ_UNESCAPE is the contract: '&amp;' is last, so an escaped
// bracket written as '&amp;#91;' decodes to the literal text '&#91;' and does not
// become a bracket. Decoding ampersand first would turn a message about HTML into
// a message containing markup.
t.check(unescapeCq('a&amp;#91;') === 'a&#91;', 'ampersand last keeps an escaped escape literal');
t.check(unescapeCq('&amp;amp;') === '&amp;', 'a double-escaped ampersand decodes once');

// --- segments ---------------------------------------------------------------
const arrayForm = flattenMessage([
  { type: 'at', data: { qq: '99999', name: '大肥鱼' } },
  { type: 'text', data: { text: ' 你还记得我吗' } },
], { selfId: '99999' });
t.check(arrayForm.text === '@你 你还记得我吗', `array form flattens (got "${arrayForm.text}")`);
t.check(arrayForm.mentionsSelf === true, 'an @ of this account is detected');
t.check(arrayForm.atIds.includes('99999'), 'the mentioned id is reported');

const cqForm = flattenMessage('[CQ:at,qq=99999] 在吗', { selfId: '99999' });
t.check(cqForm.text === '@你 在吗', `CQ-code form flattens (got "${cqForm.text}")`);
t.check(cqForm.mentionsSelf === true, 'CQ-code @ is detected too');

const other = flattenMessage([{ type: 'at', data: { qq: '12345', name: '小明' } }, { type: 'text', data: { text: ' 走' } }], { selfId: '99999' });
t.check(other.mentionsSelf === false, "an @ of somebody else is not a mention of me");
t.check(other.text === '@小明 走', 'the other person keeps their name');

t.check(flattenMessage([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: { file: 'x.png' } }]).text === 'a[图片]', 'an image becomes a placeholder, not silence');
t.check(flattenMessage('[CQ:face,id=14]').text === '[表情]', 'a face is a placeholder');
t.check(flattenMessage('[CQ:reply,id=7]真的').text === '真的', 'a reply quote is dropped, its content is not');
t.check(flattenMessage([{ type: 'text', data: { text: 'x' } }, { type: 'mystery_new_segment', data: {} }]).text === 'x', 'an unknown segment adds no noise');
t.check(flattenMessage([{ type: 'at', data: { qq: 'all' } }]).text === '@全体成员', '@all is rendered as words');
t.check(flattenMessage('').text === '', 'an empty message flattens to empty');
t.check(flattenMessage(undefined).text === '', 'an absent message flattens to empty');

// --- splitting --------------------------------------------------------------
const long = '第一句话。第二句话！第三句话？'.repeat(20);
const pieces = splitMessage(long, 60);
t.check(pieces.length > 1, `a long message is split (${pieces.length} pieces)`);
t.check(pieces.join('') === long, 'nothing is dropped or duplicated by splitting');
t.check(pieces.every((piece) => piece.length <= 60), 'no piece exceeds the limit');

const marked = '甲乙丙丁戊';
const markedPieces = splitMessage(`甲，${marked}`, 4);
t.check(markedPieces.join('').replace(/\s/g, '') === `甲，${marked}`, 'a split at a comma comma stays in the text');

const noBoundary = 'a'.repeat(500);
const hard = splitMessage(noBoundary, 100);
t.check(hard.every((piece) => piece.length <= 100), 'text with no boundary is cut at the limit');
t.check(hard.join('') === noBoundary, 'hard cutting loses nothing');

const emoji = `😀${'字'.repeat(200)}`;
const emojiPieces = splitMessage(emoji, 50);
t.check(emojiPieces.join('') === emoji, 'a surrogate pair survives cutting');
t.check(splitMessage('   ', 10).length === 0, 'whitespace-only text becomes no pieces');
t.check(splitMessage('短', 10).length === 1, 'short text is one piece');

// --- rendering --------------------------------------------------------------
const groupEvent = messageEvent({
  target: { kind: 'group', id: '67890', name: '学习小组' },
  sender: { id: '10001', name: '晚晚', card: '晚晚同学' },
  text: '今天不去上课了',
});
const groupLine = renderInbound(groupEvent, { language: 'zh' });
t.check(groupLine === '[群 学习小组] 晚晚同学（10001）：今天不去上课了', `group line names sender and group (got "${groupLine}")`);
t.check(/群/.test(groupLine) && /10001/.test(groupLine), 'the group line carries the id, not just the name');

const privateLine = renderInbound(messageEvent({ text: '在吗' }), { language: 'zh' });
t.check(privateLine === '林晚：在吗', `private line is one-to-one (got "${privateLine}")`);

const englishGroup = renderInbound(groupEvent, { language: 'en' });
t.check(/group/.test(englishGroup) && /\d{5}/.test(englishGroup), 'the English envelope names the group and the id');

// --- outbound cleaning ------------------------------------------------------
t.check(cleanOutbound('a\u0000b') === 'ab', 'control characters are stripped');
t.check(cleanOutbound('a\r\nb') === 'a\nb', 'CRLF becomes LF');
t.check(cleanOutbound('a\n\n\n\nb') === 'a\n\nb', 'runs of blank lines collapse');
t.check(cleanOutbound('  在的。  ') === '在的。', 'surrounding whitespace goes');
t.check(cleanOutbound('不许说脏话') === '不许说脏话', 'content is not censored');

t.done();
