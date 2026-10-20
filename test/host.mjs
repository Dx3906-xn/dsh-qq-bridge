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
  const calls = { created: [], resumed: [], mounted: [], resolved: [], disposed: [], images: [] };
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
            if (typeof over.beforeOpen === 'function') await over.beforeOpen();
            calls.created.push(options);
            over.onCreate?.();
            const agent = over.agentFactory?.(options) ?? fakeAgent();
            await options.setup?.(ctx, agent);
            return { agent, dispose: async () => calls.disposed.push(options.sessionId) };
          },
          resume: async (options) => {
            if (typeof over.beforeOpen === 'function') await over.beforeOpen();
            calls.resumed.push(options);
            over.onResume?.();
            const agent = over.agentFactory?.(options) ?? fakeAgent();
            await options.setup?.(ctx, agent);
            return { agent, dispose: async () => calls.disposed.push(options.resumeSessionId) };
          },
        };
      }
      if (name === 'attachments') {
        if (over.noAttachments === true) return undefined;
        return {
          saveImage: async (input) => {
            calls.images.push({ mediaType: input.mediaType, bytes: input.data.length, name: input.name });
            return {
              attachmentId: `att-${calls.images.length}`,
              mediaType: input.mediaType,
              bytes: input.data.length,
              width: 1,
              height: 1,
            };
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

// --- who is the owner --------------------------------------------------------
{
  // `own` used to be `!group`, which reads as "private chats are with the owner".
  // On a public account that is false, and the cost was not cosmetic: memory filed
  // a stranger's words under the owner and their nickname overwrote the owner's
  // name. Identity is configuration now.
  const agent = fakeAgent();
  const ctx = fakeCtx({ agentFactory: () => agent });
  const host = createHost(ctx, { workspace, ownerIds: ['3184763831'] });

  await host.handle({
    target: { kind: 'private', id: '3184763831' },
    sender: { id: '3184763831', name: '66' },
  }, '我是主人', 'k');
  t.check(agent.followed[0].source.speaker.own === true, 'the configured owner is marked as the owner');
  t.check(agent.followed[0].source.speaker.kind === 'private', 'a private chat keeps its kind');

  await host.handle({
    target: { kind: 'private', id: '999' },
    sender: { id: '999', name: '陌生人' },
  }, '你好', 'k');
  t.check(agent.followed[1].source.speaker.own === false, 'a stranger passed as the owner');

  // In a room the owner is present but `own` stays false: a room is never a
  // private confidence, and a consumer that trusts `own` must not be able to be
  // talked into one.
  await host.handle({
    target: { kind: 'group', id: '1070071261' },
    sender: { id: '3184763831', name: '晚晚' },
  }, '在群里我是主人', 'k');
  t.check(agent.followed[2].source.speaker.own === false, 'a group message from the owner was marked own');
  t.check(agent.followed[2].source.speaker.group === '1070071261', 'the room id is carried');
  await host.close();

  // Not configured keeps the old behaviour: a deployment only this machine can
  // reach should not have to name itself.
  const agent2 = fakeAgent();
  const ctx2 = fakeCtx({ agentFactory: () => agent2 });
  const host2 = createHost(ctx2, { workspace });
  await host2.handle({
    target: { kind: 'private', id: '999' },
    sender: { id: '999', name: '陌生人' },
  }, '你好', 'k');
  t.check(agent2.followed[0].source.speaker.own === true, 'an unconfigured bridge stopped trusting private chats');
  await host2.close();
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

// --- a turn nobody asked for -------------------------------------------------
{
  // The proactive path. The brief is an instruction to the agent, not a message
  // from the person, and a memory plugin that read it as `kind: 'user'` would
  // extract facts out of the plugin's own words.
  const agent = fakeAgent();
  const ctx = fakeCtx({ agentFactory: () => agent });
  const host = createHost(ctx, { workspace });
  const reply = await host.speak('k', '你刚看到一个视频，想跟他说点什么吗？', { plugin: 'dsh-proactive' });

  t.check(reply === '收到', 'the turn ran and its text came back');
  const message = agent.followed[0];
  t.check(message.source?.kind === 'plugin:dsh-proactive', `the brief names its producer (got ${message.source?.kind})`);
  t.check(message.source?.form === 'instructions', 'it is marked as addressed to the agent, not said by a person');
  t.check(message.content[0].text.includes('想跟他说点什么吗'), 'the brief is what the model reads');
  t.check(message.role === 'user', 'it still travels as a user-role message, which the harness requires');
  await host.close();
}

{
  const ctx = fakeCtx();
  const host = createHost(ctx, { workspace });
  await host.close();
  t.check((await host.speak('k', 'hi')) === '', 'a closed host does not run a proactive turn');
}

// --- images ------------------------------------------------------------------
{
  // A 1x1 PNG, valid enough for the magic-byte sniff and the fake store.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const agent = fakeAgent();
  const ctx = fakeCtx({ agentFactory: () => agent });
  const host = createHost(ctx, { workspace, ownerIds: ['10001'] });
  await host.handle({
    target: { kind: 'private', id: '10001' },
    sender: { id: '10001', name: '林晚' },
    images: [{ url: png, file: 'cat.png' }],
  }, '林晚：看我发的猫', 'k');

  t.check(ctx.calls.images.length === 1, 'the owner image was saved through attachments');
  t.check(ctx.calls.images[0].mediaType === 'image/png', 'the media type was sniffed from the bytes');
  const content = agent.followed[0].content;
  t.check(content.some((block) => block.type === 'image'), 'the user message carries an image block');
  t.check(content[0].type === 'text' && content[0].text === '林晚：看我发的猫', 'the text still comes first');

  // A group picture stays text: the room is not a private confidence.
  const groupAgent = fakeAgent();
  const groupCtx = fakeCtx({ agentFactory: () => groupAgent });
  const groupHost = createHost(groupCtx, { workspace, ownerIds: ['10001'] });
  await groupHost.handle({
    target: { kind: 'group', id: '1070071261' },
    sender: { id: '10001', name: '林晚' },
    images: [{ url: png }],
  }, '[群] 林晚：看这个', 'g');
  t.check(groupCtx.calls.images.length === 0, 'a group image is not saved');
  t.check(!groupAgent.followed[0].content.some((block) => block.type === 'image'), 'a group image stays text');

  // A broken URL must not fail the turn.
  const brokenAgent = fakeAgent();
  const brokenCtx = fakeCtx({ agentFactory: () => brokenAgent });
  const brokenHost = createHost(brokenCtx, { workspace, ownerIds: ['10001'] });
  const answer = await brokenHost.handle({
    target: { kind: 'private', id: '10001' },
    sender: { id: '10001', name: '林晚' },
    images: [{ url: 'http://127.0.0.1:1/nope.png' }],
  }, '看这个', 'k');
  t.check(answer === '收到', 'a failed image download still answers');
  t.check(brokenAgent.followed[0].content.length === 1, 'and falls back to text only');

  // No attachment service: degrade, do not throw.
  const noCtx = fakeCtx({ noAttachments: true });
  const noHost = createHost(noCtx, { workspace, ownerIds: ['10001'] });
  await noHost.handle({
    target: { kind: 'private', id: '10001' },
    sender: { id: '10001', name: '林晚' },
    images: [{ url: png }],
  }, '在吗', 'k');
  t.check(noCtx.calls.created.length === 1, 'without attachments the turn still runs');

  // `off` wins over `all`, and a stranger never gets an image in.
  const offAgent = fakeAgent();
  const offCtx = fakeCtx({ agentFactory: () => offAgent });
  const offHost = createHost(offCtx, { workspace, ownerIds: ['10001'], imageFrom: 'off' });
  await offHost.handle({
    target: { kind: 'private', id: '10001' },
    sender: { id: '10001', name: '林晚' },
    images: [{ url: png }],
  }, '看图', 'k');
  t.check(offCtx.calls.images.length === 0, 'imageFrom off saves nothing');
  t.check(!offAgent.followed[0].content.some((block) => block.type === 'image'), 'imageFrom off keeps text only');
}

// --- two callers, one session ------------------------------------------------
{
  // Seen live: an inbound message and a proactive turn arrived together, both
  // missed the live cache, and both opened the session. The second failed with
  // "session … is already owned by an active write handle", which from the
  // person's side looked like being ignored.
  const agent = fakeAgent();
  let created = 0;
  let resumed = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = fakeCtx({
    agentFactory: () => agent,
    onCreate: () => {
      created += 1;
    },
    onResume: () => {
      resumed += 1;
    },
    // Hold the first open open, so the second caller arrives while it is in flight.
    beforeOpen: () => gate,
  });
  const host = createHost(ctx, { workspace });

  const first = host.handle({ target: { kind: 'private', id: '1' } }, '在吗', 'same');
  const second = host.speak('same', '你看到一个视频');
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);

  t.check(created + resumed === 1, `the session was opened once, not twice (opened ${created + resumed})`);
  t.check(agent.followed.length === 2, 'both turns still ran, one after the other');
  await host.close();
}

// --- a session somebody else already opened ----------------------------------
{
  // The Web UI on the same Harness holds the write handle for as long as the
  // conversation page is open. Resuming then throws "already owned by an active
  // write handle", and every QQ message in that chat is lost while the page stays
  // open. Attaching to the live agent is the fix.
  const liveAgent = fakeAgent();
  const ctx = fakeCtx();
  ctx.get = ((original) => (name) => {
    if (name === 'agents') {
      return {
        get: (id) => (id === 'shared' ? liveAgent : undefined),
        create: async () => {
          throw new Error('should not create a session that is already live');
        },
        resume: async () => {
          throw new Error('should not resume a session that is already live');
        },
      };
    }
    return original(name);
  })(ctx.get.bind(ctx));

  const host = createHost(ctx, { workspace });
  const answer = await host.handle({ target: { kind: 'private', id: '1' } }, '在吗', 'shared');
  t.check(answer === '收到', 'the turn ran on the already-live agent');
  t.check(liveAgent.followed.length === 1, 'and the message reached it');
  await host.close();
  t.check(liveAgent.followed.length === 1, 'closing the bridge does not tear down a session it did not open');
}

t.done();
