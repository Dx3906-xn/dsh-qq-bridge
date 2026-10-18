// The agent side: which session a conversation is, and what counts as the reply.
//
// This is the file that decides whether a restart continues a conversation or
// starts over, so most of these checks are about what the store is asked and what
// wins when two answers disagree. The harness is replaced by a stand-in that
// records the calls: everything asserted here is a decision this plugin makes,
// not a decision the harness makes for it.
import { suite } from './helpers.mjs';
import { createHost, replyOf } from '../lib/host.js';

const t = suite('host');

/**
 * A session stand-in: a list of events with `seq` and `eventAt`.
 *
 * @param {any[]} events - the durable events.
 * @returns {any} the session.
 */
function fakeSession(events = []) {
  const list = [...events];
  return {
    get seq() {
      return list.length;
    },
    eventAt(seq) {
      return list[seq];
    },
    /** @param {any} event - append an event. */
    push(event) {
      list.push(event);
    },
    list,
  };
}

/**
 * A context with the services `createHost` reads, recording what was called.
 *
 * @param {object} [over] - service overrides.
 * @returns {any} the fake context.
 */
function fakeCtx(over = {}) {
  const calls = { created: [], resumed: [], mounted: [], resolved: [], disposed: [] };
  const sessionsById = new Map(over.sessionsById ?? []);
  const statById = new Map(over.statById ?? []);
  const ctx = {
    calls,
    /** Event registrations, kept so a test can see what the setup installed. */
    listeners: [],
    /**
     * The scoped-context face `installModelSelection` needs.
     *
     * @param {string} event - event name.
     * @param {any} handler - the listener.
     * @returns {() => void} a disposer.
     */
    on(event, handler) {
      ctx.listeners.push({ event, handler });
      return () => {};
    },
    /**
     * The scoped-context face plugins use for teardown.
     *
     * @param {any} body - the effect body.
     * @returns {void}
     */
    effect(body) {
      void body;
    },
    get(name) {
      if (name === 'loader') return { await: async () => {} };
      if (name === 'sessions') {
        return {
          get: (id) => sessionsById.get(id),
          flush: async () => true,
        };
      }
      if (name === 'sessionPersistence') {
        if (over.noPersistence === true) return undefined;
        return {
          stat: async (id) => statById.get(id),
        };
      }
      if (name === 'sessionQuery') {
        if (over.query === undefined) return undefined;
        return over.query;
      }
      if (name === 'agentDefaultModel') {
        if (over.noDefaultModel === true) return undefined;
        return { currentSelection: () => over.selection ?? { provider: 'p', model: 'm' } };
      }
      if (name === 'agentPresets') {
        if (over.noPresets === true) return undefined;
        return {
          resolve: async (id) => {
            calls.resolved.push(id);
            if (id !== undefined && over.unknownPreset === true) throw new Error(`Unknown agent preset: ${id}`);
            return { id: id ?? 'default-preset' };
          },
          mount: async (agentCtx, id) => {
            calls.mounted.push({ agentCtx, id });
            return { id };
          },
        };
      }
      if (name === 'agents') {
        if (over.noAgents === true) return undefined;
        return {
          create: async (options) => {
            calls.created.push(options);
            const agent = over.agentFactory?.(options) ?? fakeAgent();
            await options.setup?.(ctx, agent);
            return { agent, dispose: async () => calls.disposed.push(options.sessionId) };
          },
          resume: async (options) => {
            calls.resumed.push(options);
            const agent = over.agentFactory?.(options) ?? fakeAgent();
            await options.setup?.(ctx, agent);
            return { agent, dispose: async () => calls.disposed.push(options.resumeSessionId) };
          },
        };
      }
      return undefined;
    },
  };
  return ctx;
}

/**
 * An agent stand-in that accepts one followup and answers with a fixed turn.
 *
 * @returns {any} the agent.
 */
function fakeAgent() {
  const session = fakeSession();
  const seen = [];
  return {
    session,
    followed: seen,
    followup(message) {
      seen.push(message);
      // Mirror the harness: a user message becomes a durable event, then the turn
      // produces an assistant message and an end reason.
      session.push({ type: 'user/message', data: message });
      session.push({ type: 'turn/start', data: { turn: 1 } });
      session.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '收到' }] } },
      });
      session.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    },
    async whenIdle() {},
  };
}

const workspace = process.cwd();

// --- replyOf -----------------------------------------------------------------
{
  const session = fakeSession([
    { type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'thinking', text: '他问我' }, { type: 'text', text: '在的。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  const outcome = replyOf(session, 0);
  t.check(outcome.text === '在的。', `only the text block is the reply (got "${outcome.text}")`);
  t.check(outcome.reason?.kind === 'completed', 'the turn reason is reported');
}

{
  // Two assistant messages in one turn is normal (a tool call, then the answer).
  // The reply is the last one; concatenating them would send the agent's own
  // scratch work to the person.
  const session = fakeSession([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我查一下。' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '查到了，明天下午三点。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  t.check(replyOf(session, 0).text === '查到了，明天下午三点。', 'the last assistant text is the reply, not every assistant text');
}

{
  const session = fakeSession([
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '上一轮的' }] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]);
  t.check(replyOf(session, 1).text === '', 'events before the turn started are not the reply');
}

{
  const session = fakeSession([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '要说的' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } } } },
  ]);
  const outcome = replyOf(session, 0);
  t.check(outcome.reason.kind === 'error', 'a failed turn is reported as failed');
  t.check(outcome.text === '要说的', 'and whatever was said before the failure is still returned');
}

// --- route -------------------------------------------------------------------
{
  const ctx = fakeCtx({ selection: { provider: 'profile-p', model: 'profile-m' } });
  const host = createHost(ctx, { workspace, provider: 'cfg-p', model: 'cfg-m' });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'key-1');
  t.check(ctx.calls.created[0].agentOptions.provider === 'cfg-p', 'a configured provider wins over the profile default');
  await host.close();
}

{
  const ctx = fakeCtx({ selection: { provider: 'profile-p', model: 'profile-m' } });
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'key-1');
  t.check(ctx.calls.created[0].agentOptions.provider === 'profile-p', 'with nothing configured the profile default is used');
  await host.close();
}

{
  const ctx = fakeCtx({ noDefaultModel: true });
  const host = createHost(ctx, { workspace });
  let message = '';
  try {
    await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'key-1');
  } catch (error) {
    message = error.message;
  }
  t.check(/no agentDefaultModel/.test(message), `without either source it refuses instead of guessing (got "${message}")`);
}

// --- create vs resume --------------------------------------------------------
{
  const ctx = fakeCtx();
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'qq:onebot:private:10001');
  t.check(ctx.calls.created.length === 1, 'a new conversation creates a session');
  t.check(ctx.calls.created[0].sessionId === 'qq:onebot:private:10001', 'the session id is the conversation key');
  t.check(ctx.calls.created[0].meta.cwd === workspace, 'the workspace is recorded on the session');
  await host.close();
}

{
  // The restart case: nothing is live, but the log is on disk.
  const ctx = fakeCtx({ statById: new Map([['k', { header: { id: 'k' }, revision: 4 }]]) });
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  t.check(ctx.calls.resumed.length === 1, 'a session on disk is resumed, not recreated');
  t.check(ctx.calls.created.length === 0, 'and nothing is created');
  t.check(ctx.calls.resumed[0].resumeSessionId === 'k', 'the resume names the stored session');
  await host.close();
}

{
  // A second message on a warm conversation. The first one created the agent; the
  // second must find it, not open a second session on the same key.
  const ctx = fakeCtx();
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  await host.handle({ target: { kind: 'private', id: '1' } }, '还是我', 'k');
  t.check(ctx.calls.created.length === 1, 'a warm conversation is neither created nor resumed again');
  t.check(ctx.calls.resumed.length === 0, 'and nothing is resumed');
  t.check(host.liveCount === 1, 'one agent serves both messages');
  await host.close();
}

{
  // `sessions.get(id)` sees a session another part of the process is holding: the
  // bridge must resume it rather than create a second one on the same key.
  const existing = fakeAgent();
  const ctx = fakeCtx({ sessionsById: new Map([['k', existing]]) });
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  t.check(ctx.calls.created.length === 0, 'a session already in this process is not created twice');
  t.check(ctx.calls.resumed.length === 1, 'it is attached by resume instead');
  await host.close();
}

{
  // Nothing live, no persistence service, but a query service that knows the id.
  const ctx = fakeCtx({
    noPersistence: true,
    query: {
      observeSession: async (id) => {
        if (id !== 'k') {
          const error = new Error('no such session');
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
          throw error;
        }
        return { projections: { values: { agentPreset: 'companion' } } };
      },
    },
  });
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  t.check(ctx.calls.resumed.length === 1, 'the query service is enough to find a stored session');
  t.check(ctx.calls.mounted.some((item) => item.id === 'companion'), 'and its preset is read from the projection');
  await host.close();
}

{
  // An unreadable log is not an absent one: recreating over it erases the
  // conversation, which looks exactly like a memory bug to the person.
  const ctx = fakeCtx({
    noPersistence: true,
    query: { observeSession: async () => { throw new Error('the log is corrupt'); } },
  });
  const host = createHost(ctx, { workspace });
  let message = '';
  try {
    await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  } catch (error) {
    message = error.message;
  }
  t.check(/corrupt/.test(message), 'a corrupt log fails the turn instead of starting over');
  t.check(ctx.calls.created.length === 0, 'and nothing was created on top of it');
}

// --- preset precedence -------------------------------------------------------
{
  // The regression this file was written for: passing '' to the registry asks for
  // a preset literally named nothing.
  const ctx = fakeCtx({ statById: new Map([['k', { header: { id: 'k' }, revision: 1 }]]) });
  const host = createHost(ctx, { workspace, preset: 'companion' });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  t.check(ctx.calls.resolved[0] === 'companion', 'the stored preset is what gets resolved');
  t.check(!ctx.calls.resolved.includes(''), 'the empty string is never handed to the registry');
  await host.close();
}

{
  const ctx = fakeCtx({ statById: new Map([['k', { header: { id: 'k', agentPreset: 'stored' }, revision: 1 }]]) });
  const host = createHost(ctx, { workspace, preset: 'configured' });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  t.check(ctx.calls.resolved[0] === 'stored', 'a resumed session keeps the preset it was composed under');
  t.check(!ctx.calls.resolved.includes('configured'), 'the configured one does not override a stored session');
  await host.close();
}

{
  const ctx = fakeCtx({ noPresets: true });
  const host = createHost(ctx, { workspace, preset: 'companion' });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  t.check(ctx.calls.resolved.length === 0, 'with no preset registry the turn still runs');
  t.check(ctx.calls.created.length === 1, 'the session is still created');
  await host.close();
}

// --- the message shape -------------------------------------------------------
{
  // The harness rejects a session whose messages have no id, and it rejects the
  // whole session when it finds one. This plugin builds the message, so it has to
  // carry one — and the id has to be fresh per message, not a constant.
  const agent = fakeAgent();
  const ctx = fakeCtx({ agentFactory: () => agent });
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, '林晚：在吗', 'k');
  const message = agent.followed[0];
  t.check(typeof message.id === 'string' && message.id !== '', 'the user message carries an id');
  t.check(message.role === 'user', 'it is a user message');
  t.check(message.source?.kind === 'user', 'its source kind is the standard one, not a private kind');
  t.check(message.content[0].text === '林晚：在吗', 'the envelope text is what the model reads');
  await host.handle({ target: { kind: 'private', id: '1' } }, '还在吗', 'k');
  t.check(agent.followed[1].id !== agent.followed[0].id, 'a second message gets its own id');
  await host.close();
}

// --- eviction ----------------------------------------------------------------
{
  const ctx = fakeCtx();
  const host = createHost(ctx, { workspace, maxLiveAgents: 2 });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'a', 'one');
  await host.handle({ target: { kind: 'private', id: '2' } }, 'b', 'two');
  t.check(host.liveCount === 2, 'two conversations are live');
  await host.handle({ target: { kind: 'private', id: '3' } }, 'c', 'three');
  t.check(host.liveCount === 2, 'the third evicts one rather than growing');
  t.check(ctx.calls.disposed.includes('one'), 'the oldest conversation is the one disposed');
  t.check(!ctx.calls.disposed.includes('three'), 'the new one is kept');
  await host.close();
}

{
  const ctx = fakeCtx();
  const host = createHost(ctx, { workspace });
  await host.handle({ target: { kind: 'private', id: '1' } }, 'a', 'one');
  await host.handle({ target: { kind: 'private', id: '2' } }, 'b', 'two');
  await host.close();
  t.check(ctx.calls.disposed.length === 2, 'closing disposes every live agent');
  t.check(host.liveCount === 0, 'and the cache is empty');
  const after = await host.handle({ target: { kind: 'private', id: '1' } }, 'c', 'three');
  t.check(after === '', 'a closed host answers nothing rather than reviving an agent');
}

// --- a missing harness -------------------------------------------------------
{
  const ctx = fakeCtx({ noAgents: true });
  const host = createHost(ctx, { workspace });
  let message = '';
  try {
    await host.handle({ target: { kind: 'private', id: '1' } }, 'hi', 'k');
  } catch (error) {
    message = error.message;
  }
  t.check(/agents service is not mounted/.test(message), 'without the agents service it names what is missing');
  t.check(/dsh-base/.test(message), 'and which bundle provides it');
}

t.done();
