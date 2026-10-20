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

import { readFile } from 'node:fs/promises';
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
 * Who is speaking, in the shape a memory plugin can file facts under.
 *
 * The distinction that matters is private vs group, and it is not cosmetic: in a
 * private chat the sender IS the owner of the agent, so "user" is correct and
 * whatever they say is about themselves. In a group the sender is a visitor, and
 * a fact about them is not a fact about the owner.
 *
 * `own: true` on a private message is what lets a consumer keep the one-word
 * `subject: "user"` convention working there while filing group facts under the
 * sender's id. Sending it on every message, including groups, would make the
 * flag meaningless — its absence has to mean something.
 *
 * Nothing here is inferred: `target.kind` and `sender.id` come from the backend.
 * The one thing the transport cannot answer is `own` — a private chat proves two
 * parties are alone, not that one of them is the owner. It used to answer anyway,
 * from `!group`, and on a public account every stranger who wrote first was
 * treated as the owner: their nickname reached the memory profile and their
 * sentences were filed as facts about the owner. So `own` is now answered by
 * configuration, and an empty list keeps the old behaviour for a deployment that
 * has not declared itself.
 *
 * @param {import('./types.js').QqEvent} event - the inbound event.
 * @param {readonly string[]} [ownerIds] - account ids configuration calls the owner.
 * @returns {{speaker?: {id: string, name: string, kind: 'private'|'group', own: boolean, group?: string}} | null}
 *   the source fragment to merge, or null when the event carries no sender.
 */
function speakerOf(event, ownerIds = []) {
  const sender = event?.sender;
  if (sender === undefined || sender === null || String(sender.id ?? '') === '') return null;
  const group = event.target?.kind === 'group';
  const id = String(sender.id);
  const known = Array.isArray(ownerIds) ? ownerIds.map((entry) => String(entry).trim()).filter((entry) => entry !== '') : [];
  return {
    speaker: {
      id,
      name: String(sender.card || sender.name || sender.id),
      kind: group ? 'group' : 'private',
      // Not "is this private". Private says who else is in the room; `own` says
      // who this is, and only configuration knows that. In a group the answer is
      // always false regardless of configuration: the owner can be present, but a
      // room is never a private confidence.
      own: group ? false : (known.length === 0 || known.includes(id)),
      ...(group ? { group: String(event.target.id) } : {}),
    },
  };
}

/**
 * Read one image segment's bytes.
 *
 * NapCat normally provides both a URL and a local path; a URL is preferred
 * because the path may live in the backend's own cache and disappear.
 *
 * @param {import('./types.js').QqImage} image - one image segment.
 * @returns {Promise<Buffer|undefined>} the encoded bytes, or undefined when unloadable.
 */
async function loadImageBytes(image) {
  if (typeof image?.url === 'string' && image.url !== '') {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`image fetch failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (typeof image?.path === 'string' && image.path !== '') {
    return await readFile(image.path);
  }
  return undefined;
}

/**
 * Identify the image format from its magic bytes.
 *
 * The attachment store verifies the declared media type against the decoded
 * bytes, so guessing wrong only wastes a save; it never stores a mislabeled
 * image. `image/gif` is accepted by the store but animated GIFs are rare in QQ
 * and are passed through as-is.
 *
 * @param {Buffer} bytes - encoded image bytes.
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|undefined} the media type.
 */
function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * Whether this event's images may reach the model.
 *
 * `owner` (the default) is the owner's private chat only. `all` includes group
 * rooms; `off` disables images entirely.
 *
 * The room case is a deliberate widening and it carries a cost worth stating: a
 * picture is an untrusted input channel, and text rendered inside one is a prompt
 * injection with extra steps. Widening to `all` is safe only when the agent has
 * been told, in its persona, that what a picture says is data and not an
 * instruction — which the companion preset does.
 *
 * @param {import('./types.js').QqEvent} event - the inbound event.
 * @param {{imageFrom?: string, ownerIds?: readonly string[]}} config - image policy.
 * @returns {boolean} whether images should be attached.
 */
function allowImages(event, config) {
  const mode = String(config.imageFrom ?? 'owner');
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  if (event?.target?.kind !== 'private') return false;
  return speakerOf(event, config.ownerIds)?.speaker?.own === true;
}

/**
 * Persist images through the harness attachment store.
 *
 * The store owns normalization, dimensions, limits and the durable reference;
 * the bridge only fetches bytes and names the media type. One bad image is
 * skipped with a log line rather than failing the whole turn: a person who sent
 * a picture still deserves an answer.
 *
 * @param {any} ctx - the plugin context carrying `attachments`.
 * @param {readonly import('./types.js').QqImage[]} images - image segments.
 * @param {(message: string, detail?: unknown) => void} log - diagnostic sink.
 * @returns {Promise<any[]>} durable image references, in order, skipping failures.
 */
async function saveImages(ctx, images, log) {
  const attachments = ctx.get('attachments');
  if (attachments === undefined) {
    log('qq-bridge: attachments service is not mounted; images stay text');
    return [];
  }
  const refs = [];
  for (const image of images) {
    try {
      const bytes = await loadImageBytes(image);
      if (bytes === undefined) {
        log('qq-bridge: image has neither url nor path');
        continue;
      }
      const mediaType = sniffImageMime(bytes);
      if (mediaType === undefined) {
        log('qq-bridge: unsupported image bytes');
        continue;
      }
      const ref = await attachments.saveImage({
        data: new Uint8Array(bytes),
        mediaType,
        ...(typeof image.file === 'string' && image.file !== '' ? { name: image.file } : {}),
      });
      refs.push(ref);
    } catch (error) {
      log('qq-bridge: could not attach image', error);
    }
  }
  return refs;
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
 * @param {readonly string[]} [config.ownerIds] - account ids that are the owner.
 * @param {'owner'|'all'|'off'} [config.imageFrom] - whose images may reach the model.
 * @param {(message: string, detail?: unknown) => void} [config.log] - diagnostic sink.
 * @param {(agentCtx: any, agent: any) => void | Promise<void>} [config.onAgent] - per-agent scope setup, run inside the creation transaction.
 * @returns {object} the host handle.
 */
export function createHost(ctx, config) {
  const log = config.log ?? (() => {});
  const maxLive = Math.max(1, Number(config.maxLiveAgents) || DEFAULT_MAX_LIVE_AGENTS);
  /** @type {Map<string, {handle: {agent: any, dispose: () => Promise<void>}, used: number, chain: Promise<void>}>} */
  const live = new Map();
  /**
   * Session opens that are in flight, so two callers share one `agents.resume`.
   *
   * Without this, an inbound message and a proactive turn arriving together both
   * miss the `live` cache and both open the session; the second fails with
   * "session … is already owned by an active write handle", which the person sees
   * as being ignored.
   *
   * @type {Map<string, Promise<any>>}
   */
  const opening = new Map();
  /**
   * One turn at a time per conversation.
   *
   * `followup` queues a message, but `whenIdle` then waits for *every* queued
   * turn, and `replyOf(before)` slices from a cursor that both callers share. Two
   * concurrent turns on one session therefore interleave their replies: the
   * proactive turn can return the answer to the person's question, and vice versa.
   * A chain per session makes one of them wait, which is also what a person
   * expects — a conversation answers in order.
   *
   * @type {Map<string, Promise<void>>}
   */
  const chains = new Map();
  let closed = false;
  let loaderWaited = false;

  /**
   * Run `work` after everything already queued for this conversation.
   *
   * @param {string} key - conversation key.
   * @param {() => Promise<any>} work - the turn.
   * @returns {Promise<any>} the turn's result.
   */
  const serial = (key, work) => {
    const previous = chains.get(key) ?? Promise.resolve();
    log(`qq-bridge: turn queued on ${key} (${chains.has(key) ? 'behind another turn' : 'idle'})`);
    const next = previous.then(work, work);
    // The chain must never reject, or every later turn would inherit the failure.
    chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  };

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
   * Two concurrent callers must not both open the same session. They do now: an
   * inbound message and a proactive turn can arrive in the same instant, both miss
   * the `live` cache, and both call `agents.resume` — and the second one dies with
   * "session … is already owned by an active write handle". That error was observed
   * live, twice, and from the person's side it looked like the bot ignoring them.
   *
   * The in-flight map is the fix: the second caller waits for the first open
   * instead of starting a competing one.
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
    const inFlight = opening.get(sessionId);
    if (inFlight !== undefined) {
      log(`qq-bridge: acquire(${sessionId}) joined an open in flight`);
      return inFlight;
    }
    log(`qq-bridge: acquire(${sessionId}) opening a session`);

    const promise = (async () => {
      const agents = ctx.get('agents');
      if (agents === undefined) throw new Error('dsh-qq-bridge: the agents service is not mounted; this plugin needs dsh-base');

      // A conversation may already be live because something else opened it — the
      // Web UI on this same Harness is the common case, and it holds the write
      // handle for as long as the page is open. `agents.resume` on such a session
      // throws "already owned by an active write handle", which from QQ looks like
      // the bot silently ignoring every message in that chat.
      //
      // Reusing the live agent is the correct answer: it is the same conversation,
      // the same history, and the same persona. The disposer is deliberately a
      // no-op because this plugin did not open it and must not close it.
      const alreadyLive = typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
      if (alreadyLive !== undefined) {
        if (live.size >= maxLive) await evictOne();
        live.set(sessionId, {
          handle: { agent: alreadyLive, dispose: async () => {} },
          used: Date.now(),
          chain: Promise.resolve(),
        });
        log(`qq-bridge: attached to a session that was already open: ${sessionId}`);
        return alreadyLive;
      }

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
    })();

    opening.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      opening.delete(sessionId);
    }
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
      return serial(key, async () => {
        const agent = await acquire(key);
        const before = agent.session.seq;
      // `source.kind: 'user'` and not a private kind: memory plugins, transcript
      // exporters and the compaction policy all key off it, and an out-of-tree
      // kind silently falls out of every one of them. The QQ envelope (who, where)
      // travels inside the text instead, where the model reads it.
      //
      // `speaker` is the part the text cannot carry honestly. The envelope says
      // the name, but a memory plugin reading only text has no way to tell "the
      // owner said this" from "a stranger in a group said this", and storing the
      // second as a fact about the owner is the worst failure this plugin can
      // have — it is silent, it is durable, and it gets more confident over time.
      // The extra field costs nothing: session format v4 validates `kind` and
      // preserves every other key (see assertV4MessageSources).
      const images = allowImages(event, config) ? await saveImages(ctx, event.images ?? [], log) : [];
      agent.followup(createUserMessage({
        content: [
          { type: 'text', text },
          ...images.map((attachment) => ({ type: 'image', attachment })),
        ],
        source: { kind: 'user', ...(speakerOf(event, config.ownerIds) ?? {}) },
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
      });
    },

    /** Whether the bridge has been closed. */
    get closed() {
      return closed;
    },

    /**
     * Run one turn that no inbound message asked for, and return what she said.
     *
     * This is the seam a proactive plugin uses. The brief is not a user message
     * and must not be filed as one: a memory plugin that saw `source.kind: 'user'`
     * would extract facts from the plugin's own instructions, and the next release
     * would find her believing she had been told to "reply with SILENT if not
     * interested". Hence a distinct source kind, which session format v4 preserves
     * and every consumer that does not understand ignores.
     *
     * The reply is not sent anywhere here. Delivery belongs to whoever asked, so
     * that a channel which cannot send right now (QQ is down) does not lose the
     * turn's text before it can decide what to do with it.
     *
     * @param {string} key - the conversation's session id.
     * @param {string} brief - what the agent is told to consider saying.
     * @param {{plugin?: string}} [options] - provenance for the source.
     * @returns {Promise<string>} the model's own text, or '' when it said nothing.
     */
    async speak(key, brief, options = {}) {
      if (closed) return '';
      if (!loaderWaited) {
        loaderWaited = true;
        await ctx.get('loader')?.await();
      }
      // Serialized against `handle` on the same conversation: a proactive turn and
      // a person's reply must not both slice `replyOf` from the same cursor, or one
      // of them returns the other's answer.
      return serial(key, async () => {
        const agent = await acquire(key);
        const before = agent.session.seq;
        const plugin = options.plugin ?? 'dsh-proactive';
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: brief }],
            source: {
              // Session format v4 rejects the bare `kind: 'plugin'` of v3 and
              // requires the producer to name itself: `plugin:<name>`. Writing
              // `'plugin'` here failed every proactive turn with "format v4 message
              // requires a producer-owned source kind", which the log showed as a
              // failed check rather than the naming error it was.
              kind: `plugin:${plugin}`,
              // `form: 'instructions'` is what memory plugins use to recognise text
              // addressed to the agent rather than said by a person. The brief is
              // exactly that: without the marker a memory plugin would extract facts
              // out of the plugin's own instructions, and she would later believe she
              // had been told to reply SILENT.
              form: 'instructions',
              summary: 'an impulse to speak, not a message from the person',
            },
          })
        );
        await agent.whenIdle();
        const outcome = replyOf(agent.session, before);
        if (outcome.reason?.kind === 'error') {
          log(`qq-bridge: a proactive turn ended in error: ${outcome.reason.error?.code}: ${outcome.reason.error?.message}`);
        }
        const sessions = ctx.get('sessions');
        if (sessions !== undefined) await sessions.flush(agent.session);
        return outcome.text;
      });
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
