/**
 * The tools, and the reason there are only three of them.
 *
 * An agent woken by external messages faces a different threat model than one a
 * developer types into: it reads text written by strangers, and every tool it has
 * is a lever that text can pull. So this plugin offers three verbs, all of them
 * narrow:
 *
 *   - `qq_send`: one text message to one conversation the bridge already knows;
 *   - `qq_whoami`: this account's identity and which conversations are live;
 *   - `qq_history`: a short window of the current conversation, from the log.
 *
 * What is deliberately absent: a tool to choose an arbitrary target, to list
 * groups, to change `groupMode`, to read another conversation, or to accept friend
 * requests. A prompt injection can therefore at most make the agent send text to
 * somebody who is already in the room — the same power the reply path has.
 *
 * Every tool is registered only when the backend reports the capability it needs,
 * so a backend that cannot send proactively cannot be asked to.
 *
 * @module dsh-qq-bridge/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderInbound } from './text.js';

/** How much history `qq_history` will return at most. */
const MAX_HISTORY = 40;

/**
 * Render a target as the agent sees it: `私聊 林晚(12345)` or `群 学习小组(67890)`.
 *
 * @param {import('./types.js').QqTarget} target - the conversation.
 * @param {'zh'|'en'} [language] - language for the label.
 * @returns {string} one line.
 */
export function describeTarget(target, language = 'zh') {
  const label = target.kind === 'group'
    ? (language === 'en' ? 'group' : '群')
    : (language === 'en' ? 'private' : '私聊');
  // The id goes in brackets right after the name. Putting a space before the
  // bracket makes the id read as a separate word, and this string ends up in
  // `qq_whoami` output, which is what the model copies back into `qq_send`.
  const name = target.name === undefined || target.name === '' ? '' : `${target.name}`;
  return name === '' ? `${label} (${target.id})` : `${label} ${name}(${target.id})`;
}

/**
 * Read the last few turns of one session as chat lines.
 *
 * Only user and assistant text is reproduced: tool calls, reasoning and system
 * notices are the harness's own machinery, and showing them to a model that asked
 * for "what was said" answers a different question than the one asked.
 *
 * @param {any} session - a live session.
 * @param {number} limit - maximum lines.
 * @param {'zh'|'en'} [language] - language for the speaker labels.
 * @returns {string[]} the lines, oldest first.
 */
export function recentLines(session, limit, language = 'zh') {
  /** @type {string[]} */
  const lines = [];
  const start = Math.max(0, session.seq - 400);
  for (let seq = start; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const message = event.data.message ?? event.data;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks
      .filter((/** @type {any} */ block) => block.type === 'text')
      .map((/** @type {any} */ block) => String(block.text))
      .join('')
      .trim();
    if (text === '') continue;
    const who = event.type === 'user/message'
      ? (language === 'en' ? 'them' : '对方')
      : (language === 'en' ? 'you' : '我');
    lines.push(`${who}: ${text}`);
  }
  return lines.slice(-Math.max(1, Math.min(MAX_HISTORY, limit)));
}

/**
 * Register the bridge's tools on a context.
 *
 * @param {any} ctx - the agent-scoped context to register on.
 * @param {object} deps - what the tools act on.
 * @param {() => any} deps.getBridge - resolves the bridge lazily.
 * @param {import('./types.js').QqBackend} deps.backend - for capabilities and identity.
 * @param {'zh'|'en'} deps.language - prompt and label language.
 * @param {Map<string, import('./types.js').QqTarget>} deps.targets - conversation key → target, for `qq_send`.
 * @param {any} [deps.agent] - the agent these tools were scoped to.
 * @param {(message: string, detail?: unknown) => void} [deps.log] - diagnostic sink.
 * @returns {string[]} the names actually registered.
 */
export function registerTools(ctx, deps) {
  const { backend, language } = deps;
  // Resolved on use, not captured: the bridge is created after the host that
  // registers these tools, and a closure over a `let` that is still empty at
  // registration time would hand the tool `undefined`.
  const getBridge = deps.getBridge;
  /** @type {string[]} */
  const registered = [];
  const zh = language !== 'en';

  ctx.tools.register(defineTool({
    name: 'qq_whoami',
    description: zh
      ? '查看这个 QQ 账号是谁、当前连着哪些会话。不确定自己在哪个群或跟谁说话时调用。'
      : 'Show which QQ account this is and which conversations are currently live. Use when you are unsure where you are or who you are talking to.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selfId: { type: 'string' },
          connected: { type: 'boolean' },
          backend: { type: 'string' },
          conversations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string' },
                where: { type: 'string' },
              },
            },
          },
          proactiveLeft: { type: 'number' },
        },
      },
      render: (args, value) => {
        const lines = [
          `${zh ? `账号 ${value.selfId || '（未知）'}，${value.connected ? '已连接' : '未连接'}` : `account ${value.selfId || '(unknown)'}, ${value.connected ? 'connected' : 'disconnected'}`}${value.backend === '' ? '' : zh ? `（经 ${value.backend}）` : ` (via ${value.backend})`}`,
        ];
        if (value.conversations.length === 0) lines.push(zh ? '当前没有活跃会话' : 'no live conversations');
        for (const item of value.conversations) lines.push(`- ${item.key} → ${item.where}`);
        lines.push(zh ? `今天还能主动发 ${value.proactiveLeft} 条` : `${value.proactiveLeft} proactive messages left today`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      const stats = getBridge().stats();
      const conversations = [...(deps.targets ?? new Map()).entries()].slice(0, 20).map(([key, target]) => ({
        key,
        where: describeTarget(target, language),
      }));
      return {
        selfId: String(backend.selfId ?? ''),
        connected: stats.connected === true,
        backend: String(backend.active ?? backend.id ?? ''),
        conversations,
        proactiveLeft: Number(stats.proactiveLeft ?? 0),
      };
    },
  }));
  registered.push('qq_whoami');

  if (backend.capabilities.has('private') || backend.capabilities.has('group')) {
    ctx.tools.register(defineTool({
      name: 'qq_send',
      description: zh
        ? '主动给一个已经聊过的会话发一条消息。只在确实有话要说、而不是为了确认自己还在线时使用；同一天不要反复打扰同一个人。'
        : 'Send a message to a conversation you have already talked in. Use it when you actually have something to say, not to confirm you are still online, and do not keep pinging the same person in one day.',
      parameters: {
        where: {
          type: 'string',
          required: true,
          description: zh
            ? '会话标识，形如 private:12345 或 group:67890，可省略前缀后只用号码。'
            : 'Conversation key like private:12345 or group:67890; the id alone is accepted when unambiguous.',
        },
        text: {
          type: 'string',
          required: true,
          description: zh ? '要说的内容，一两句话。' : 'What to say, one or two sentences.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            sent: { type: 'number' },
            error: { type: 'string' },
            // The reader-shaped half. `ok` is for the model's own branching; these
            // are what it actually reads back, and they exist because a bare "sent"
            // leaves the one question worth asking unanswered: did anything arrive?
            to: { type: 'string' },
            where: { type: 'string' },
            occurredAt: { type: 'string' },
            detail: { type: 'string' },
          },
        },
        render: (args, value) => {
          if (value.ok === true) {
            return [{ type: 'text', text: value.detail ?? (zh ? `已发送 ${value.sent} 条` : `sent ${value.sent}`) }];
          }
          return [{ type: 'text', text: value.detail ?? (zh ? `没有发出去：${value.error}` : `not sent: ${value.error}`) }];
        },
      },
      async execute(args) {
        const where = String(args.where).trim();
        const target = resolveTarget(deps.targets ?? new Map(), where);
        if (target === undefined) {
          // Not "sent": a tool that reports success for a message nobody received
          // is the worst possible answer, because the agent then believes the
          // person was told.
          deps.log?.(`qq-bridge: qq_send had no target for "${where}"`);
          return {
            ok: false,
            sent: 0,
            error: 'no conversation with that name; ask through a reply instead',
            to: '',
            where: '',
            occurredAt: new Date().toISOString(),
            detail: zh
              ? `没发出去：没有叫「${where}」的会话。先用 qq_whoami 看看都有哪些，或者直接回他。`
              : `not sent: there is no conversation called "${where}". Try qq_whoami, or just reply to them.`,
          };
        }
        const result = await getBridge().sendProactive(target, String(args.text));
        const ok = result.ok === true;
        const sentAt = new Date().toISOString();
        // The description of where it went, not the key: she wrote a number, and
        // reading "qq:onebot:private:12345" back to her is noise. "私聊 ㅤ不想"
        // answers the question she asked.
        const place = describeTarget(target, language);
        const pieces = Number(result.sent ?? 0);
        const detail = ok
          ? zh
            ? `已经发到${place}了${pieces > 1 ? `（分 ${pieces} 条）` : ''}。`
            : `Delivered to ${place}${pieces > 1 ? ` in ${pieces} parts` : ''}.`
          : zh
            ? `没发出去（${place}）：${result.error ?? '原因不明'}`
            : `not delivered (${place}): ${result.error ?? 'unknown reason'}`;
        // A failed proactive send is the one thing here that must be loud: the
        // agent has decided to say something and the person will never hear it.
        if (!ok) deps.log?.(`qq-bridge: qq_send to ${place} failed: ${result.error ?? 'unknown'}`);
        return {
          ok,
          sent: pieces,
          error: String(result.error ?? ''),
          to: String(target.id ?? ''),
          where: place,
          occurredAt: sentAt,
          detail,
        };
      },
    }));
    registered.push('qq_send');
  }

  ctx.tools.register(defineTool({
    name: 'qq_history',
    description: zh
      ? '读回当前会话最近说过的话。想确认对方之前怎么说的、或者怕自己记错时使用。'
      : 'Read back the most recent lines of the current conversation. Use it to check what was actually said rather than trusting your memory of it.',
    parameters: {
      limit: { type: 'number', description: zh ? '最多几行，默认 12，最多 40。' : 'How many lines, default 12, max 40.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.lines.length === 0 ? (zh ? '这一段没有文字记录' : 'nothing said yet in this conversation') : value.lines.join('\n'),
      }],
    },
    async execute(args, exec) {
      const limit = Math.min(MAX_HISTORY, Math.max(1, Number(args.limit ?? 12)));
      const session = exec.agent?.session;
      if (session === undefined) return { lines: [] };
      return { lines: recentLines(session, limit, language) };
    },
  }));
  registered.push('qq_history');

  return registered;
}

/**
 * Find the conversation a `qq_send` argument names.
 *
 * Accepts the full key, `kind:id`, or a bare id that matches exactly one
 * conversation. An ambiguous bare id resolves to nothing rather than to a guess:
 * sending a private thought into a group is not a recoverable mistake.
 *
 * @param {Map<string, import('./types.js').QqTarget>} targets - known conversations.
 * @param {string} given - what the model passed.
 * @returns {import('./types.js').QqTarget|undefined} the target, if unambiguous.
 */
export function resolveTarget(targets, given) {
  const want = String(given ?? '').trim();
  if (want === '') return undefined;
  const exact = targets.get(want);
  if (exact !== undefined) return exact;
  const normalized = want.replace(/^qq:/, '').replace(/^(私聊|群)\s*/, '');
  if (targets.has(normalized)) return targets.get(normalized);
  const matches = [...targets.entries()].filter(([key, target]) => key.endsWith(`:${normalized}`) || target.id === normalized);
  return matches.length === 1 ? matches[0][1] : undefined;
}
