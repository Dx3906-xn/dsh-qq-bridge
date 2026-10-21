/**
 * The decisions that have to be made before anything is sent, kept out of the
 * transport so they can be tested without one.
 *
 * Three questions live here:
 *
 *   1. Should this group message wake the agent at all?
 *   2. Is this the same message we already handled? (Backends reconnect, and a
 *      reconnect replays.)
 *   3. Is it too soon to send to this target again?
 *
 * Each is a small function with an explicit input, because each is the kind of
 * thing that quietly goes wrong in production: a bot that answers every group
 * message is unbearable, a bot that answers the same message twice after a
 * reconnect looks broken, and a bot with no rate limit can lose the account it
 * runs on.
 *
 * @module dsh-qq-bridge/policy
 */

/**
 * Response modes for group chats.
 *
 * `mention` is the default and the reason is social, not technical: a personal
 * account that replies to every line in a group is a bot that everyone mutes. The
 * mode is a configuration value because the right answer differs per deployment —
 * a two-person group used as a shared notebook wants `always`, a busy public
 * group wants `mention`, and an account that should monitor without speaking
 * wants `off`.
 *
 * `auto` exists because both fixed answers were wrong in practice. `always`
 * answered every line, including the two people talking to each other, which is
 * exactly the behaviour that gets a bot muted. `mention` was technically silent
 * but socially deaf: it could not follow a conversation it was part of, and being
 * @-ed was the only way to exist. In `auto` the room is read, the recent context
 * is handed to the agent, and the agent decides whether this moment is one where
 * speaking is welcome — with `SILENT` as an ordinary answer.
 *
 * @typedef {'always'|'mention'|'auto'|'off'} GroupMode
 */

/** The accepted values, for schema validation and error messages. */
export const GROUP_MODES = ['always', 'mention', 'auto', 'off'];

/**
 * QQ's canned away-message marker.
 *
 * Seen in production on the first live run: the bridge answered
 * "[自动回复]你好，我现在有事不在，一会再和你联系。" as if a person had typed it. That
 * costs a full model call, and worse, an agent with memory will file the sentence
 * as something the other person said about themselves.
 *
 * Matched at the start of the text and only when it carries the bracket marker,
 * because "自动回复" is also an ordinary phrase somebody may use in a sentence
 * about their own settings.
 */
const AUTO_REPLY = /^\[自动回复\]/;

/**
 * Decide whether an inbound event should reach the agent.
 *
 * Private messages always do. Group messages follow `mode`. A message that
 * mentions this account beats every mode except `off` — including `always`, where
 * the mention marker is stripped from the text so the agent does not read `@你` as
 * something the person typed.
 *
 * @param {import('./types.js').QqEvent} event - the inbound event.
 * @param {{groupMode: GroupMode, selfId: string, allowedGroups?: readonly string[], ignoreAutoReply?: boolean}} settings - effective policy.
 * @returns {{accept: boolean, reason: string, text: string}} the decision and the text to hand the agent.
 */
export function admit(event, settings) {
  const text = String(event.text ?? '');
  if (settings.ignoreAutoReply !== false && AUTO_REPLY.test(text)) {
    // Not the same as a duplicate: the message really arrived, nobody is waiting
    // for an answer to it. Dropping it here also keeps it out of the agent's
    // memory, where it would read as a claim about the person.
    return { accept: false, reason: 'auto reply', text };
  }
  if (event.target.kind === 'private') {
    return { accept: text !== '', reason: text === '' ? 'empty' : 'private', text };
  }

  const allowed = settings.allowedGroups ?? [];
  if (allowed.length > 0 && !allowed.includes(String(event.target.id))) {
    return { accept: false, reason: 'group not allowed', text };
  }

  const mode = settings.groupMode;
  if (mode === 'off') {
    // An @ still wins over `off`? No. `off` means this account does not speak in
    // groups; a mention is not a reason to override an operator's decision.
    return { accept: false, reason: 'group mode off', text };
  }
  if (mode === 'mention' && !event.mentionsSelf) {
    // Not an error: most group traffic is other people talking to each other,
    // and the bridge seeing it is not the bridge acting on it.
    return { accept: false, reason: 'not mentioned', text };
  }
  if (text === '') return { accept: false, reason: 'empty', text };

  // The @ marker was synthesized by the transport (`@你`), not typed by anyone.
  // Leaving it in teaches the model that people address it in the third person.
  const cleaned = text.replace(/^@你\s*/, '').replace(/^@全体成员\s*/, '').trim();
  // Empty *after* the marker is stripped is a different message from empty
  // before: "@LD" alone flattens to "@你", passes the check above, and then leaves
  // nothing. A model asked to answer nothing writes its own reasoning out as the
  // reply, which is how a thinking trace reached a real group chat. An image with
  // no caption is still content, so only the truly empty case is dropped.
  if (cleaned === '' && (event.images?.length ?? 0) === 0) {
    return { accept: false, reason: 'empty after mention', text: cleaned };
  }
  if (mode === 'auto') {
    // Accepted either way, because in `auto` the *presence* of a message is not
    // the decision — the agent's own reading of the room is. The reason tells the
    // caller which question it still has to ask: a mention never needs one.
    return { accept: true, reason: event.mentionsSelf ? 'auto mentions this account' : 'auto', text: cleaned };
  }
  return { accept: true, reason: mode === 'always' ? 'group always' : 'mentioned', text: cleaned };
}

/**
 * The word that means "I read the room and I am not saying anything".
 *
 * Matching is on the whole answer, not on containment: a reply that mentions the
 * word in a sentence is a sentence, and treating it as a refusal would swallow a
 * real message. The uppercase spelling is deliberate — it is improbable enough to
 * survive a model that likes to explain itself.
 */
export const SILENT = 'SILENT';

/**
 * Whether an answer is a refusal to speak rather than something to send.
 *
 * @param {string} answer - the model's text.
 * @returns {boolean} whether to stay quiet.
 */
export function isSilence(answer) {
  const trimmed = String(answer ?? '').trim();
  if (trimmed === '') return false;
  return /^[\s"'“”「」『』`*]*SILENT[\s"'“”「」『』`*。.!！]*$/u.test(trimmed);
}

/**
 * A bounded per-room transcript, newest last.
 *
 * The reason this exists rather than "let the model read its own history": in
 * `auto` most lines never reach the agent, so its history would be a transcript
 * with the boring parts cut out and the seams invisible. This keeps what was
 * actually said, so a decision made two minutes and four messages later still has
 * the four messages.
 *
 * @param {number} capacity - how many lines one room keeps.
 * @returns {{note: (room: string, line: string) => void, read: (room: string, limit?: number) => string[], forget: (room: string) => void, size: (room: string) => number}} the buffer.
 */
export function createRoomLog(capacity) {
  const limit = Math.max(1, Math.floor(Number(capacity) || 12));
  /** @type {Map<string, string[]>} */
  const rooms = new Map();
  return {
    note(room, line) {
      const text = String(line ?? '').trim();
      if (text === '') return;
      const existing = rooms.get(room);
      if (existing === undefined) rooms.set(room, [text]);
      else {
        existing.push(text);
        while (existing.length > limit) existing.shift();
      }
    },
    read(room, count) {
      const lines = rooms.get(room) ?? [];
      const take = Math.max(1, Math.floor(Number(count) || limit));
      return lines.slice(-take);
    },
    forget(room) {
      rooms.delete(room);
    },
    size(room) {
      return (rooms.get(room) ?? []).length;
    },
  };
}

/**
 * Format one room's recent lines as the text the agent is asked to judge.
 *
 * Three things are load-bearing here and each fixes a real failure:
 *
 *   - **The transcript is quoted, not paraphrased.** A model deciding whether a
 *     room wants to hear from it needs the actual lines, in order, with who said
 *     them. A summary is a second model's opinion about what mattered.
 *   - **It is told these are not messages addressed to it.** Without this the
 *     agent reads a room's chatter as a sequence of things said to it, which is
 *     how a group bot ends up answering a conversation between two other people.
 *   - **Saying nothing is presented as an equal answer.** A brief that only
 *     offers "reply" makes silence a failure, and the agent will fill the gap.
 *
 * @param {object} input - what to render.
 * @param {string} input.room - the group id, for the header.
 * @param {readonly string[]} input.lines - the recent transcript, oldest first.
 * @param {boolean} [input.mentioned] - whether the last line addressed this account.
 * @param {'zh'|'en'} [input.language] - which language to render in.
 * @returns {string} the text to hand the agent.
 */
export function formatRoomContext(input) {
  const zh = (input.language ?? 'zh') !== 'en';
  const lines = Array.isArray(input.lines) ? input.lines.filter((line) => String(line ?? '').trim() !== '') : [];
  const body = lines.join('\n');
  if (zh) {
    const head = `【群里刚才的对话】（群 ${input.room}，从旧到新）\n${body}`;
    const tail =
      input.mentioned === true
        ? '最后这句是在叫你。回一句，别答成客服。'
        : '这些是群里的人在互相说话，不是他单独对你说的。\n想接就接一句，像群里随口一说；不想说话就只回 SILENT，不要解释。';
    return `${head}\n\n${tail}`;
  }
  const head = `[The group's last few lines] (group ${input.room}, oldest first)\n${body}`;
  const tail =
    input.mentioned === true
      ? 'The last line is addressed to you. Answer it, and do not sound like a help desk.'
      : 'These are people in the room talking to each other, not to you.\nJoin in with one line if you want; if you would rather not, reply with only SILENT and nothing else.';
  return `${head}\n\n${tail}`;
}

/**
 * Whether `auto` may spend a model call on this room right now.
 *
 * Two ceilings, because they prevent different things. The interval stops a run
 * of short messages from becoming a run of turns — the room finishes its thought
 * before she is asked about it. The hourly cap stops a busy room from turning
 * into a busy model: without it, "decide for yourself" on a chatty group is the
 * most expensive feature in the bridge.
 *
 * A mention bypasses both. Being addressed is not a decision to make.
 *
 * @param {{minIntervalMs?: number, maxPerHour?: number}} limits - the ceilings.
 * @param {() => number} [now] - clock, injectable for tests.
 * @returns {{allow: (room: string, options?: {urgent?: boolean}) => boolean, wait: (room: string) => number, note: (room: string) => void, remaining: (room: string) => number}} the throttle.
 */
export function createAutoThrottle(limits, now = Date.now) {
  const gap = Math.max(0, Number(limits?.minIntervalMs) || 0);
  const cap = Math.max(0, Math.floor(Number(limits?.maxPerHour) || 0));
  /** @type {Map<string, {last: number, stamps: number[]}>} */
  const rooms = new Map();
  const prune = (state) => {
    const floor = now() - 3_600_000;
    state.stamps = state.stamps.filter((at) => at > floor);
  };
  return {
    allow(room, options = {}) {
      if (options.urgent === true) return true;
      const state = rooms.get(room) ?? { last: 0, stamps: [] };
      prune(state);
      if (cap > 0 && state.stamps.length >= cap) return false;
      return state.last === 0 || now() - state.last >= gap;
    },
    wait(room) {
      const state = rooms.get(room);
      if (state === undefined || state.last === 0) return 0;
      return Math.max(0, gap - (now() - state.last));
    },
    note(room) {
      const state = rooms.get(room) ?? { last: 0, stamps: [] };
      prune(state);
      state.last = now();
      state.stamps.push(state.last);
      rooms.set(room, state);
    },
    remaining(room) {
      if (cap === 0) return Number.POSITIVE_INFINITY;
      const state = rooms.get(room) ?? { last: 0, stamps: [] };
      prune(state);
      return Math.max(0, cap - state.stamps.length);
    },
  };
}

/**
 * A bounded set for "have I already handled this".
 *
 * Bounded because an unbounded one is a memory leak that only shows up after a
 * week of uptime, and insertion-ordered because the oldest entry is exactly the
 * one that should go.
 *
 * @param {number} capacity - how many recent ids to remember; defaults to 512.
 * @returns {{seen: (id: string) => boolean, remember: (id: string) => void, size: () => number}} the set.
 */
export function createDedupe(capacity = 512) {
  /** @type {Set<string>} */
  const seen = new Set();
  const limit = Math.max(16, Math.floor(Number(capacity) || 512));
  return {
    seen: (id) => id !== '' && seen.has(id),
    remember: (id) => {
      if (id === '') return;
      if (seen.has(id)) return;
      seen.add(id);
      // Sets iterate in insertion order, so the first value is the oldest.
      while (seen.size > limit) {
        const oldest = seen.values().next();
        if (oldest.done === true) break;
        seen.delete(oldest.value);
      }
    },
    size: () => seen.size,
  };
}

/**
 * Per-target spacing, because OneBot backends answer with an error or, worse,
 * silently drop messages sent faster than they like — and an account that looks
 * like it is flooding is an account that gets restricted.
 *
 * This is a clock, not a queue: it answers "may I send now" and "when may I",
 * leaving the waiting to the caller which can also decide to give up.
 *
 * @param {number} minimumMs - minimum gap between sends to one target.
 * @param {() => number} [now] - clock, injectable for tests.
 * @returns {{ready: (key: string) => boolean, wait: (key: string) => number, mark: (key: string) => void, reset: () => void}} the limiter.
 */
export function createRateLimiter(minimumMs, now = Date.now) {
  /** @type {Map<string, number>} */
  const last = new Map();
  const gap = Math.max(0, Math.floor(Number(minimumMs) || 0));
  return {
    ready(key) {
      const at = last.get(key);
      return at === undefined || now() - at >= gap;
    },
    wait(key) {
      const at = last.get(key);
      if (at === undefined) return 0;
      return Math.max(0, gap - (now() - at));
    },
    mark(key) {
      last.set(key, now());
    },
    reset() {
      last.clear();
    },
  };
}

/**
 * How many proactive messages this account may still send today.
 *
 * A daily budget exists because the failure it prevents is not technical: an
 * agent with memory and a channel can decide, on its own, to check in with
 * somebody forty times. Resets at local midnight, and is per-day rather than
 * rolling because "today's allowance" is what an operator can reason about.
 *
 * @param {number} limit - maximum proactive messages per local day.
 * @param {() => number} [now] - clock, injectable for tests.
 * @returns {{allow: () => boolean, spend: () => boolean, remaining: () => number}} the budget.
 */
export function createDailyBudget(limit, now = Date.now) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  let day = '';
  let used = 0;
  const currentDay = () => {
    const date = new Date(now());
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  };
  return {
    allow() {
      if (cap === 0) return false;
      if (currentDay() !== day) return true;
      return used < cap;
    },
    spend() {
      const today = currentDay();
      if (today !== day) {
        day = today;
        used = 0;
      }
      if (used >= cap) return false;
      used += 1;
      return true;
    },
    remaining() {
      if (cap === 0) return 0;
      if (currentDay() !== day) return cap;
      return Math.max(0, cap - used);
    },
  };
}

/**
 * The session key for one conversation.
 *
 * One session per conversation, not per message: the agent's context window is
 * the conversation, and creating a session per message would throw away every
 * thing said before. Group vs private is part of the key because a group and a
 * friend can share a numeric id, and merging them would put a private
 * conversation into a group's history.
 *
 * Components are URI-encoded so that a `:` inside an id cannot forge a different
 * key — the separator is the thing that makes the parts unambiguous.
 *
 * @param {string} backendId - which backend produced the event.
 * @param {import('./types.js').QqTarget} target - the conversation.
 * @returns {string} a stable, readable session id.
 */
export function sessionKey(backendId, target) {
  return ['qq', backendId, target.kind, String(target.id)].map((part) => encodeURIComponent(part)).join(':');
}
