// text.mjs: OneBot's format on the way in, the platform's limits on the way out.
//
// The cases that matter are the ones a real backend produces and a hand-written
// fixture would not: an array of segments from NapCat, a CQ-code string from an
// older sender, an @ of this account mixed into a sentence, and a reply long
// enough that cutting it badly is visible to the person reading it.
import { cleanOutbound, flattenMessage, renderInbound, splitMessage, splitParagraphs, unescapeCq } from '../lib/text.js';
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

// Seen on the first live group test: somebody typed "@LD" on the keyboard rather
// than picking the account out of the member list. QQ stores that as ordinary
// text with no `at` segment, and treating it as a mention would mean answering
// every message that merely says the account's name.
const typedAt = flattenMessage([{ type: 'text', data: { text: '测试带@LD ' } }], { selfId: '99999' });
t.check(typedAt.mentionsSelf === false, 'a hand-typed @name is text, not a mention');
t.check(typedAt.atIds.length === 0, 'and it carries no at id at all');
// The trailing space QQ leaves behind is trimmed by flattening, like any other
// surrounding whitespace; what matters is the @ itself survives as characters.
t.check(typedAt.text === '测试带@LD', 'the typed @ is left in the text, because somebody really typed it');

t.check(flattenMessage([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: { file: 'x.png' } }]).text === 'a[图片]', 'an image becomes a placeholder, not silence');
t.check(flattenMessage('[CQ:face,id=14]').text === '[表情]', 'a face is a placeholder');
t.check(flattenMessage('[CQ:reply,id=7]真的').text === '真的', 'a reply quote is dropped, its content is not');
t.check(flattenMessage([{ type: 'text', data: { text: 'x' } }, { type: 'mystery_new_segment', data: {} }]).text === 'x', 'an unknown segment adds no noise');
t.check(flattenMessage([{ type: 'at', data: { qq: 'all' } }]).text === '@全体成员', '@all is rendered as words');
t.check(flattenMessage('').text === '', 'an empty message flattens to empty');
t.check(flattenMessage(undefined).text === '', 'an absent message flattens to empty');

// --- a quote ----------------------------------------------------------------
{
  // Seen live: the person replied to a picture, added an @ and a space, and sent.
  // The quote pushed no text, so without the id the message looked empty and the
  // model answered its own reasoning out loud.
  const quoted = flattenMessage([
    { type: 'reply', data: { id: '1011000443' } },
    { type: 'at', data: { qq: '99999' } },
    { type: 'text', data: { text: ' ' } },
  ], { selfId: '99999' });
  t.check(quoted.replyTo === '1011000443', `the quoted id survives (got ${quoted.replyTo})`);
  t.check(quoted.text === '@你', 'and the quote itself adds no text');
  t.check(quoted.mentionsSelf === true, 'the mention is still detected');

  const plain = flattenMessage([{ type: 'text', data: { text: '在吗' } }]);
  t.check(plain.replyTo === '', 'a message without a quote reports no id');

  const cqQuote = flattenMessage('[CQ:reply,id=42]在吗');
  t.check(cqQuote.replyTo === '42', 'the CQ-code form reports its quote too');
  t.check(cqQuote.text === '在吗', 'and still drops the marker from the text');
}

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

// --- paragraphs are messages -------------------------------------------------
//
// "一条一句，多的拆条" was being ignored because it is an instruction about
// presentation and the model's whole output is one string, where the only
// presentation available is a newline. A blank line is the model saying "new bubble";
// the transport was flattening it back into one bubble with a gap in the middle.
{
  const two = splitParagraphs('那我先写一句\n\n老大 你说的自由 我收下了');
  t.check(two.length === 2, `a blank line is a bubble boundary (${two.length})`);
  t.check(two[0] === '那我先写一句', 'the first bubble is the first paragraph');
  t.check(two[1] === '老大 你说的自由 我收下了', 'and the second follows it');

  t.check(splitParagraphs('记下了 一句一行 多的拆条').length === 1, 'a reply with no blank line stays one bubble');

  // A person who pauses leans on the key; three blank lines are one boundary, not
  // three empty messages.
  const many = splitParagraphs('行\n\n\n\n好');
  t.check(many.length === 2, `a run of blank lines is still one boundary (${many.length})`);
  t.check(many.every((part) => part !== ''), 'and never yields an empty bubble');

  t.check(splitParagraphs('').length === 0, 'empty text has no bubbles');
  t.check(splitParagraphs('   \n\n  ').length === 0, 'whitespace-only text has none either');
}

t.done();
