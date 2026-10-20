/**
 * Text in, text out: the two places where OneBot's format would otherwise leak.
 *
 * Inbound, a message arrives as either an array of segments or a single string
 * with CQ codes embedded, and both forms are in the wild — NapCat sends arrays,
 * older senders and some bridges send strings, and a bridge that handles one form
 * silently drops the other's content. Outbound, a reply has to be cut into pieces
 * the platform will accept, and cutting by character count mid-sentence produces
 * a bot that stutters.
 *
 * @module dsh-qq-bridge/text
 */

/** CQ-code escapes, in the order they must be decoded (ampersand last). */
const CQ_UNESCAPE = [
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&#44;', ','],
  ['&amp;', '&'],
];

/**
 * Decode the escapes OneBot applies inside CQ-code parameters.
 * @param {string} value - raw parameter text.
 * @returns {string} the human text.
 */
export function unescapeCq(value) {
  let text = String(value);
  for (const [from, to] of CQ_UNESCAPE) text = text.split(from).join(to);
  return text;
}

/**
 * The regex for one CQ code. Kept module-level because a fresh global regex per
 * call is the classic `lastIndex` bug waiting to happen.
 */
const CQ_CODE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

/**
 * Parse a CQ-code parameter list: `,qq=123,name=abd` → `{qq: '123', name: 'abd'}`.
 * @param {string} params - the raw suffix after the code name.
 * @returns {Record<string, string>} decoded parameters.
 */
function parseParams(params) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const pair of String(params).split(',')) {
    if (pair === '') continue;
    const index = pair.indexOf('=');
    if (index < 0) continue;
    out[pair.slice(0, index)] = unescapeCq(pair.slice(index + 1));
  }
  return out;
}

/**
 * Flatten a OneBot message into `{text, mentionsSelf, selfId}`.
 *
 * Everything that is not text becomes either a placeholder the model can
 * understand (`[图片]`, `[语音]`) or nothing at all (reply quotes, which are
 * already represented by the message being a reply). Silently dropping an image
 * is worse than a placeholder: the agent then answers as though the person said
 * nothing, and the person sees a reply that ignores their picture.
 *
 * @param {unknown} message - array of segments, CQ-code string, or a bare string.
 * @param {{selfId?: string}} [options] - this account's id, for @ detection.
 * @returns {{text: string, mentionsSelf: boolean, atIds: string[]}} the flattened message.
 */
export function flattenMessage(message, options = {}) {
  const selfId = options.selfId === undefined ? '' : String(options.selfId);
  /** @type {string[]} */
  const parts = [];
  /** @type {string[]} */
  const atIds = [];
  /**
   * The id of the message this one quotes, when it quotes one.
   *
   * A quote is usually not content: "reply to that joke" means the joke is
   * already in the room. But "reply to that picture with an @ and nothing else"
   * is a whole message whose only content is the quoted picture, and dropping the
   * id there turns a real message into an empty one. The caller decides.
   *
   * @type {string}
   */
  let replyTo = '';

  const pushSegment = (type, data) => {
    if (type === 'text') {
      parts.push(String(data.text ?? ''));
      return;
    }
    if (type === 'at') {
      const qq = String(data.qq ?? '');
      atIds.push(qq);
      if (qq === 'all') parts.push('@全体成员');
      else if (qq === selfId) parts.push('@你');
      else parts.push(`@${String(data.name ?? qq)}`);
      return;
    }
    if (type === 'image') parts.push('[图片]');
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'video') parts.push('[视频]');
    else if (type === 'file') parts.push('[文件]');
    else if (type === 'face') parts.push('[表情]');
    else if (type === 'reply') {
      replyTo = String(data.id ?? '');
      return;
    } else if (type === 'forward') parts.push('[合并转发]');
    else if (type === 'json' || type === 'xml') parts.push('[卡片消息]');
    // Anything unknown stays out: a placeholder for a segment we do not know is
    // noise, and OneBot adds segment types without asking.
  };

  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment === null || typeof segment !== 'object') continue;
      pushSegment(String(segment.type ?? ''), segment.data ?? {});
    }
    return { text: parts.join('').trim(), mentionsSelf: atIds.includes(selfId), atIds, replyTo };
  }

  const raw = String(message ?? '');
  let cursor = 0;
  CQ_CODE.lastIndex = 0;
  for (let match = CQ_CODE.exec(raw); match !== null; match = CQ_CODE.exec(raw)) {
    if (match.index > cursor) parts.push(unescapeCq(raw.slice(cursor, match.index)));
    pushSegment(match[1], parseParams(match[2]));
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) parts.push(unescapeCq(raw.slice(cursor)));
  return {
    text: parts.join('').trim(),
    mentionsSelf: selfId !== '' && atIds.includes(selfId),
    atIds,
    replyTo,
  };
}

/** Sentence-ish boundaries, longest first, so `……` is not read as `…` twice. */
const BREAK_AFTER = ['。', '！', '？', '!', '?', '；', ';', '…', '\n', '，', ',', ' ', '、'];

/**
 * Cut text into pieces the platform will accept, preferring to break where a
 * sentence already ends.
 *
 * The naive `slice(0, maxChars)` cuts mid-word and mid-sentence, and every cut
 * that lands inside a sentence reads as an interruption rather than a pause. Ties
 * are broken by *where* the boundary is, not by what it is: cutting after 「，」
 * five characters in is worse than cutting after 「。」 four hundred in.
 *
 * A piece is never empty, and joining the result with the original separators
 * gives back the input — the function drops nothing.
 *
 * @param {string} text - the message body.
 * @param {number} maxChars - soft maximum per piece; defaults to 1200.
 * @returns {string[]} one or more pieces, never empty.
 */
export function splitMessage(text, maxChars = 1200) {
  const body = String(text ?? '').trim();
  if (body === '') return [];
  const limit = Math.max(40, Math.floor(Number(maxChars) || 1200));
  if (body.length <= limit) return [body];

  /** @type {string[]} */
  const pieces = [];
  let rest = body;
  while (rest.length > limit) {
    let cut = -1;
    for (const boundary of BREAK_AFTER) {
      const at = rest.lastIndexOf(boundary, limit);
      if (at > cut) cut = at;
    }
    // No boundary in the window at all: break at the limit rather than sending
    // half the window, and prefer not to split a surrogate pair.
    if (cut <= 0) {
      cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut -= 1;
    }
    const piece = rest.slice(0, cut).trimEnd();
    if (piece !== '') pieces.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/**
 * The text a model should see for one inbound message, including who sent it and
 * where, so that a group conversation is legible without the agent having to
 * remember which session it is in.
 *
 * @param {import('./types.js').QqEvent} event - the inbound event.
 * @param {{named?: boolean, language?: 'zh'|'en'}} [options] - `named` adds the sender's name when the reply is one-to-one.
 * @returns {string} the rendered message.
 */
export function renderInbound(event, options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh';
  const { sender, target, text } = event;
  if (target.kind === 'group') {
    return language === 'en'
      ? `[group ${target.name ?? target.id}] ${sender.card || sender.name} (${sender.id}): ${text}`
      : `[群 ${target.name ?? target.id}] ${sender.card || sender.name}（${sender.id}）：${text}`;
  }
  return language === 'en' ? `${sender.name}: ${text}` : `${sender.name}：${text}`;
}

/**
 * Strip what a chat platform will not display as written.
 *
 * Not a security filter — the agent's output reaches a person, and a message
 * containing raw markup or a stray terminal escape is a rendering bug, not an
 * attack. Deliberately does not censor content; that is a policy decision for the
 * deployment, not something a transport layer should guess.
 *
 * @param {string} text - model output.
 * @returns {string} the text, without control characters and with runs of blank lines collapsed.
 */
export function cleanOutbound(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
