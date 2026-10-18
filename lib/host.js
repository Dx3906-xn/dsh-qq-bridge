/**
 * The agent side of the bridge: one DSH session per conversation.
 *
 * This file is where the transport stops and the harness begins. It owns three
 * decisions and nothing else:
 *
 *   - which session a conversation belongs to, and whether to create it or resume
 *     the one already on disk;
 *   - how an inbound message becomes a user message the harness accepts;
 *   - which part of the finished turn is the reply.
 *
 * The third one deserves a note. The reply is the turn's final assistant text,
 * not everything the model emitted: a turn can contain reasoning, tool calls and
 * several partial messages, and pasting all of that into a chat window is how a
 * bot looks broken. There is deliberately no "reply" tool — a model that has to
 * remember to call a tool to speak will eventually answer into the void, and the
 * person sees silence.
 *
 * @module dsh-qq-bridge/host
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

/** How many turns an idle conversation keeps its Agent alive before eviction. */
const DEFAULT_MAX_LIVE_AGENTS = 8;

/**
 * The text and reason of one finished turn.
 *
 * Mirrors what the headless runner does, for the same reason: the durable log is
 * the only complete account of a turn, and reading it is how the reply and the
 * outcome cannot disagree.
 *
 * @param {any} session - the live session.
 * @param {number} firstSeq - the session's seq when the turn was submitted.
 * @returns {{text: string, reason: any}} the last assistant text and the turn's end reason.
 */
export function replyOf(session, firstSeq) {
  let text = '';
  let reason;
  let started = false;
  const length = session.seq;
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) break;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((/** @type {any} */ block) => block.type === 'text')
        .map((/** @type {any} */ block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

/**
 * Build the agent host.
 *
 * @param {any} ctx - the plugin context, carrying agents/presets/default model.
 * @param {object} config - effective settings.
 * @param {string} config.workspace - absolute working directory recorded on new sessions.
 * @param {string} [config.preset] - agent preset to mount; the registry default when empty.
 * @param {string} [config.provider] - provider override.
 * @param {string} [config.model] - model override.
 * @param {number} [config.maxLiveAgents] - conversations kept warm; defaults to 8.
 * @param {(message: string, detail?: unknown) => void} [config.log] - diagnostic sink.
 * @param {(agentCtx: any, agent: any) => void | Promise<void>} [config.onAgent] - per-agent scope setup, run inside the creation transaction.
 * @returns {object} the host handle.
 */
export function createHost(ctx, config) {
  const log = config.log ?? (() => {});
  const maxLive = Math.max(1, Number(config.maxLiveAgents) || DEFAULT_MAX_LIVE_AGENTS);
  /** @type {Map<string, {handle: {agent: any, dispose: () => Promise<void>}, used: number, chain: Promise<void>}>} */
  const live = new Map();
  let closed = false;
  let loaderWaited = false;

  /**
   * The model route for a new agent.
   *
   * Resolved per agent rather than once at mount: the profile's default model can
   * be changed while the bridge is running, and a conversation started after the
   * change should use the new one.
   *
   * @returns {{provider: string, model: string}} the route.
   */
  const route = () => {
    if (config.provider !== undefined && config.model !== undefined && config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model };
    }
    const defaults = ctx.get('agentDefaultModel');
    if (defaults === undefined) throw new Error('dsh-qq-bridge: no agentDefaultModel service and no provider/model configured');
    const selection = defaults.currentSelection();
    return { provider: selection.provider, model: selection.model };
  };

  /**
   * Whether a persisted session with this id exists, and the preset it was made
   * under.
   *
   * Asked before `create`, because `create` on an existing id either throws or,
   * worse, silently starts over: a bridge that recreates a conversation forgets
   * the person on every restart, which is indistinguishable from a memory bug.
   *
   * `stat` is the right question — it observes the stored header without taking
   * write ownership, so it also works for a session this process is not holding.
   * The header carries the preset the session was composed from, and the preset
   * decides the session's tools and prompt: resuming a `companion` conversation
   * under a different preset would replay history the model can no longer act on,
   * so the stored value wins over the configured one.
   *
   * A corrupt or unreadable log is deliberately *not* reported as absent:
   * starting over on top of it would erase the conversation instead of naming the
   * problem.
   *
   * @param {string} sessionId - the conversation's id.
   * @returns {Promise<{found: boolean, preset?: string}>} what the store says.
   */
  const probe = async (sessionId) => {
    if (ctx.get('sessions')?.get(sessionId) !== undefined) return { found: true };
    const store = ctx.get('sessionPersistence');
    if (store !== undefined) {
      const snapshot = await store.stat(sessionId);
      if (snapshot === undefined) return { found: false };
      const preset = snapshot.header.agentPreset;
      return { found: true, ...(preset === undefined || preset === '' ? {} : { preset }) };
    }
    const query = ctx.get('sessionQuery');
    if (query !== undefined) {
      try {
        const observation = await query.observeSession(sessionId);
        const preset = observation?.projections?.values?.agentPreset;
        const dispose = observation?.[Symbol.dispose];
        if (typeof dispose === 'function') dispose.call(observation);
        return { found: true, ...(typeof preset === 'string' && preset !== '' ? { preset } : {}) };
      } catch (error) {
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { found: false };
        throw error;
      }
    }
    // No persistence at all is not a resumable world: creating every time is the
    // only thing that can work, and the sessions service will say so if it cannot.
    return { found: false };
  };

  /**
   * Compose the per-agent setup: model selection, scoped tools, then the preset.
   *
   * All three matter in this order. Without the selection the agent loop refuses
   * to run (`no provider/model`); without the scoped tools the agent cannot send a
   * proactive message or read back the conversation; without the preset the agent
   * gets the bare harness — no persona, no memory — and answers like a generic
   * assistant. Tools are registered before the preset mounts so that a preset row
   * which itself wants them finds them already there.
   *
   * @param {{provider: string, model: string}} selection - the route.
   * @param {string|undefined} presetId - the preset to mount; empty means the registry default.
   * @returns {(agentCtx: any, agent: any) => Promise<void>} the setup callback.
   */
  const setupFor = (selection, presetId) => async (agentCtx, agent) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
    if (config.onAgent !== undefined) await config.onAgent(agentCtx, agent);
    const presets = ctx.get('agentPresets');
    if (presets === undefined) {
      if (presetId !== undefined && presetId !== '') {
        log(`qq-bridge: preset "${presetId}" requested but no agentPresets service is mounted`);
      }
      return;
    }
    // `undefined`, not `''`: the registry treats a nullish argument as "the
    // default" and an empty string as the name of a preset called nothing, which
    // fails with `Unknown agent preset: ` — an error that reads like a
    // configuration problem and is really a calling convention.
    const wanted = presetId === undefined || presetId === '' ? undefined : presetId;
    const resolved = (await presets.resolve(wanted)).id;
    await presets.mount(agentCtx, resolved);
  };

  /**
   * Evict the least recently used conversation when the cache is full.
   *
   * Disposal, not just dropping the reference: a live agent holds a session, a
   * scope and its own listeners, and forgetting the map entry without disposing
   * leaks all three.
   *
   * @returns {Promise<void>} resolves when an entry has been evicted.
   */
  const evictOne = async () => {
    let oldestKey = '';
    let oldestUsed = Number.POSITIVE_INFINITY;
    for (const [key, entry] of live) {
      if (entry.used < oldestUsed) {
        oldestUsed = entry.used;
        oldestKey = key;
      }
    }
    if (oldestKey === '') return;
    const entry = live.get(oldestKey);
    live.delete(oldestKey);
    if (entry !== undefined) {
      try {
        await entry.handle.dispose();
      } catch (error) {
        log('qq-bridge: disposing a live agent failed', error);
      }
    }
  };

  /**
   * Get the live agent for a conversation, creating or resuming as needed.
   *
   * @param {string} sessionId - the conversation's session id.
   * @returns {Promise<any>} the live agent.
   */
  const acquire = async (sessionId) => {
    const cached = live.get(sessionId);
    if (cached !== undefined) {
      cached.used = Date.now();
      return cached.handle.agent;
    }
    const agents = ctx.get('agents');
    if (agents === undefined) throw new Error('dsh-qq-bridge: the agents service is not mounted; this plugin needs dsh-base');
    const selection = route();
    const probed = await probe(sessionId);
    let handle;
    if (probed.found) {
      // The stored preset wins. A conversation composed as `companion` must not be
      // resumed as something else because the operator changed a default in the
      // meantime: the prompt and the tool set are part of what the history means.
      const preset = probed.preset ?? config.preset;
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions: selection, setup: setupFor(selection, preset) });
      log(`qq-bridge: resumed ${sessionId}${preset === undefined ? '' : ` as ${preset}`}`);
    } else {
      handle = await agents.create({
        sessionId,
        meta: {
          cwd: config.workspace,
          ...(config.preset === undefined || config.preset === '' ? {} : { agentPreset: config.preset }),
        },
        agentOptions: selection,
        setup: setupFor(selection, config.preset),
      });
      log(`qq-bridge: created ${sessionId}`);
    }
    await handle.agent.whenIdle();
    if (live.size >= maxLive) await evictOne();
    live.set(sessionId, { handle, used: Date.now(), chain: Promise.resolve() });
    return handle.agent;
  };

  return {
    /**
     * Run one inbound message through its conversation's agent.
     *
     * @param {import('./types.js').QqEvent} event - the inbound event, for provenance.
     * @param {string} text - the text to hand the model.
     * @param {string} key - the conversation's session id.
     * @returns {Promise<string>} the reply, or an empty string when the model said nothing.
     */
    async handle(event, text, key) {
      if (closed) return '';
      if (!loaderWaited) {
        loaderWaited = true;
        await ctx.get('loader')?.await();
      }
      const agent = await acquire(key);
      const before = agent.session.seq;
      // `source.kind: 'user'` and not a private kind: memory plugins, transcript
      // exporters and the compaction policy all key off it, and an out-of-tree
      // kind silently falls out of every one of them. The QQ envelope (who, where)
      // travels inside the text instead, where the model reads it.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }));
      await agent.whenIdle();
      const outcome = replyOf(agent.session, before);
      if (outcome.reason?.kind === 'error') {
        log(`qq-bridge: turn ended in error: ${outcome.reason.error?.code}: ${outcome.reason.error?.message}`);
      }
      const sessions = ctx.get('sessions');
      if (sessions !== undefined) {
        // Flush before returning: the reply leaves the process now, but the log
        // that explains it may be read by the next process, which is a restart
        // away.
        await sessions.flush(agent.session);
      }
      return outcome.text;
    },

    /** Whether the bridge has been closed. */
    get closed() {
      return closed;
    },

    /** How many conversations are currently live. */
    get liveCount() {
      return live.size;
    },

    /**
     * Dispose every live agent.
     * @returns {Promise<void>} resolves when all are down.
     */
    async close() {
      closed = true;
      const entries = [...live.values()];
      live.clear();
      await Promise.allSettled(entries.map((entry) => entry.handle.dispose()));
    },
  };
}
