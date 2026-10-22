// The tool surface, and the promise that it stays small.
//
// Two things are worth asserting about tools on an agent that answers strangers:
// that each one is registered only when the backend can actually do it, and that
// the set of them is what this file says it is. A tool that quietly appears later
// is a lever nobody reviewed; a tool registered against a capability the backend
// lacks is a failure the model discovers instead of the plugin.
import { suite, fakeBackend } from './helpers.mjs';
import { describeTarget, recentLines, registerTools, resolveTarget } from '../lib/tools.js';

/**
 * A context that records the tool definitions handed to it.
 *
 * Real registration validates against the harness's schema; this keeps the
 * definition objects so the suite can inspect names, parameters and renderers
 * without booting a host tree.
 *
 * @returns {any} the fake context.
 */
function fakeCtx() {
  /** @type {Map<string, any>} */
  const tools = new Map();
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    registered: tools,
  };
}

/**
 * Build the deps `registerTools` expects.
 *
 * @param {object} [over] - overrides.
 * @returns {any} deps.
 */
function deps(over = {}) {
  const backend = over.backend ?? fakeBackend();
  return {
    backend,
    language: 'zh',
    targets: new Map([
      ['qq:onebot:private:10001', { kind: 'private', id: '10001', name: '林晚' }],
      ['qq:onebot:group:67890', { kind: 'group', id: '67890', name: '学习小组' }],
    ]),
    getBridge: () => ({
      stats: () => ({ connected: true, conversations: 2, dedupe: 0, proactiveLeft: 3 }),
      sendProactive: async (target, text) => ({ ok: true, sent: 1, target, text }),
    }),
    log: () => {},
    ...over,
  };
}

const t = suite('tools');

// --- registration ------------------------------------------------------------
{
  const ctx = fakeCtx();
  const names = registerTools(ctx, deps());
  t.check(names.length === 3, `three tools are registered (got ${names.length}: ${names.join(', ')})`);
  t.check(names.join(',') === 'qq_whoami,qq_send,qq_history', 'and they are the three this plugin promises');
  t.check(ctx.registered.size === 3, 'each name reached the context exactly once');
  t.check([...ctx.registered.keys()].sort().join(',') === 'qq_history,qq_send,qq_whoami', 'no extra tool was registered under another name');
}

{
  // A backend with no proactive ability at all. `qq_send` is the only tool whose
  // existence depends on what the transport can do, so it is the only one that
  // should disappear.
  const ctx = fakeCtx();
  const names = registerTools(ctx, deps({ backend: fakeBackend({ capabilities: [] }) }));
  t.check(!names.includes('qq_send'), 'a backend that can send nothing does not get qq_send');
  t.check(names.includes('qq_whoami'), 'it still gets qq_whoami');
  t.check(names.includes('qq_history'), 'and qq_history, which needs no transport at all');
}

{
  const ctx = fakeCtx();
  const names = registerTools(ctx, deps({ backend: fakeBackend({ capabilities: ['private'] }) }));
  t.check(names.includes('qq_send'), 'a private-only backend still gets qq_send');
}

// --- resolveTarget -----------------------------------------------------------
{
  const targets = new Map([
    ['qq:onebot:private:10001', { kind: 'private', id: '10001', name: '林晚' }],
    ['qq:onebot:group:67890', { kind: 'group', id: '67890', name: '学习小组' }],
  ]);
  t.check(resolveTarget(targets, 'qq:onebot:private:10001')?.kind === 'private', 'the full key resolves');
  t.check(resolveTarget(targets, 'private:10001')?.kind === 'private', 'kind:id resolves');
  t.check(resolveTarget(targets, '10001')?.kind === 'private', 'a bare id resolves when it is unique');
  t.check(resolveTarget(targets, '67890')?.kind === 'group', 'the other bare id resolves to the group');
  t.check(resolveTarget(targets, 'qq:onebot:group:67890')?.id === '67890', 'the group key resolves');
  t.check(resolveTarget(targets, '私聊 10001')?.kind === 'private', 'the label prefix this plugin prints is accepted back');
  t.check(resolveTarget(targets, '') === undefined, 'an empty string resolves to nothing');
  t.check(resolveTarget(targets, '424242') === undefined, 'an unknown id resolves to nothing');

  // The one that matters: the same number in a private chat and in a group.
  const colliding = new Map([
    ['qq:onebot:private:10001', { kind: 'private', id: '10001', name: '林晚' }],
    ['qq:onebot:group:10001', { kind: 'group', id: '10001', name: '同名群' }],
  ]);
  t.check(resolveTarget(colliding, '10001') === undefined, 'an ambiguous bare id resolves to nothing rather than a guess');
  t.check(resolveTarget(colliding, 'private:10001')?.kind === 'private', 'the explicit form still disambiguates');
}

// --- describeTarget ----------------------------------------------------------
{
  t.check(describeTarget({ kind: 'private', id: '10001', name: '林晚' }, 'zh') === '私聊 林晚(10001)', 'a private target reads as a person');
  t.check(describeTarget({ kind: 'group', id: '67890', name: '学习小组' }, 'zh') === '群 学习小组(67890)', 'a group target reads as a group');
  t.check(describeTarget({ kind: 'group', id: '67890' }, 'zh') === '群 (67890)', 'a target with no name still shows its id');
  t.check(describeTarget({ kind: 'private', id: '10001', name: 'Lin' }, 'en') === 'private Lin(10001)', 'the English label exists');
}

// --- qq_whoami ---------------------------------------------------------------
{
  const ctx = fakeCtx();
  registerTools(ctx, deps());
  const tool = ctx.registered.get('qq_whoami');
  const value = await tool.execute({}, {});
  t.check(value.connected === true, 'whoami reports the connection');
  t.check(value.selfId === '99999', 'whoami reports the account id');
  t.check(value.conversations.length === 2, 'whoami lists the known conversations');
  t.check(value.proactiveLeft === 3, 'whoami reports the proactive allowance');
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n');
  t.check(rendered.includes('99999'), 'the rendered form names the account');
  t.check(rendered.includes('私聊 林晚(10001)'), 'the rendered form names each conversation in words');
}

// --- qq_send -----------------------------------------------------------------
{
  const ctx = fakeCtx();
  registerTools(ctx, deps());
  const tool = ctx.registered.get('qq_send');
  const ok = await tool.execute({ where: 'private:10001', text: '在忙吗' }, {});
  t.check(ok.ok === true, 'qq_send to a known conversation succeeds');
  const known = await tool.execute({ where: '10001', text: '嗯' }, {});
  t.check(known.ok === true, 'the bare-id form works too');

  // The failure that must not lie. A tool that returns ok because it could not
  // decide where to send leaves the agent believing the person was told.
  const missing = await tool.execute({ where: '424242', text: '你好' }, {});
  t.check(missing.ok === false, 'an unknown target is reported as not sent');
  t.check(missing.sent === 0, 'and nothing is counted as sent');
  t.check(missing.error.includes('no conversation'), `and the reason says so (got "${missing.error}")`);
  t.check(/没发出去/.test(tool.output.render({}, missing)[0].text), 'the rendered form says it did not go out');
  // The detail is what the model reads back, and it has to name what it failed to
  // reach: "没发出去" alone leaves it guessing whether the fault was the number,
  // the connection, or its own wording.
  t.check(missing.where === '', 'and no destination is claimed when none was resolved');
  t.check(missing.detail.includes('424242'), `the detail repeats what was asked for (${missing.detail})`);
}

// --- qq_send says where it went, not just that it did ------------------------
{
  const ctx = fakeCtx();
  registerTools(ctx, deps());
  const tool = ctx.registered.get('qq_send');
  const sent = await tool.execute({ where: 'private:10001', text: '在忙吗' }, {});
  t.check(sent.ok === true, 'a delivered message reports ok');
  t.check(sent.where.includes('林晚'), `and names who received it (${sent.where})`);
  t.check(sent.to === '10001', 'and carries the raw id, for a caller that wants it');
  t.check(typeof sent.occurredAt === 'string' && sent.occurredAt.length > 0, 'and when it happened');
  t.check(sent.detail.includes('已经发到'), `and a sentence a person could read (${sent.detail})`);
  t.check(tool.output.render({}, sent)[0].text === sent.detail, 'the rendered form is that sentence, not a bare count');
}

// --- qq_history --------------------------------------------------------------
{
  // A session stand-in: the tool only reads `seq` and `eventAt`.
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '我爸住院了' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '严重吗' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '还好，观察两天' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '那就先别太担心' }] } } },
  ];
  const session = { seq: events.length, eventAt: (seq) => events[seq] };
  const lines = recentLines(session, 10, 'zh');
  t.check(lines.length === 4, `every text turn is reproduced (got ${lines.length})`);
  t.check(lines[0] === '对方: 我爸住院了', 'the person is labelled as the other side');
  t.check(lines[1] === '我: 严重吗', 'the agent is labelled as itself');
  t.check(recentLines(session, 2, 'zh').length === 2, 'the limit is honoured');
  t.check(recentLines(session, 2, 'zh')[0].includes('还好'), 'the limit keeps the newest lines, not the oldest');

  const ctx = fakeCtx();
  registerTools(ctx, deps());
  const tool = ctx.registered.get('qq_history');
  const value = await tool.execute({ limit: 2 }, { agent: { session } });
  t.check(value.lines.length === 2, 'the tool returns the requested window');
  const none = await tool.execute({}, {});
  t.check(none.lines.length === 0, 'a call outside an agent returns nothing rather than throwing');
  const capped = await tool.execute({ limit: 999 }, { agent: { session } });
  t.check(capped.lines.length === 4, 'an oversized limit is capped, not obeyed blindly');
}

t.done();
