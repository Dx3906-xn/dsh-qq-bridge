/**
 * One backend at a time, swappable while the process runs.
 *
 * Q5 in the plan, and the reason it is a file rather than a branch: a QQ account
 * can be reached over more than one transport (NapCat on this machine, LLBot on
 * another, a GUI driver when the protocol route is refusing), and the operator
 * needs to move between them without restarting the agent — because restarting
 * also drops every warm conversation and every half-finished turn.
 *
 * The one decision that carries weight: **the session key does not follow the
 * backend**. `sessionKey` puts `backend.id` into every conversation id, so a
 * switchboard that reported the *current* backend's name would rename every
 * conversation on switch, and every person would meet the agent again for the
 * first time. This one reports a stable id (`sessionNamespace`) instead, and the
 * transports are an implementation detail of one account.
 *
 * Switching is "connect the new one, then drop the old one", never the reverse:
 * a failed switch has to leave the working transport working. During the overlap
 * both transports forward events, and `bridge`'s dedupe drops the copies — a
 * short window of duplicated messages is a much cheaper mistake than a window of
 * dropped ones.
 *
 * @module dsh-qq-bridge/switchboard
 */

/**
 * Build a switchboard over named backends.
 *
 * @param {object} options - wiring.
 * @param {string} options.id - the stable session namespace; see the note above.
 * @param {Map<string, () => import('./types.js').QqBackend>} options.factories - backend id → constructor.
 * @param {string} options.initial - backend id to connect first.
 * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
 * @returns {object} a `QqBackend`-shaped handle, plus `switchTo`, `list`, `active`.
 */
export function createSwitchboard(options) {
  const log = options.log ?? (() => {});
  const namespace = String(options.id);
  if (namespace === '') throw new Error('dsh-qq-bridge: a switchboard needs a session namespace');
  const factories = options.factories;
  /** @type {import('./types.js').QqBackend|null} */
  let current = null;
  let active = '';
  /** @type {Set<(event: import('./types.js').QqEvent) => void>} */
  const handlers = new Set();
  /** @type {(() => void)|null} */
  let detach = null;
  let closed = false;

  /**
   * Forward one backend's events to whoever subscribed to the switchboard.
   *
   * The handler list is read at delivery time, so a subscriber that arrives while
   * a turn is being handled still sees the next message.
   *
   * @param {import('./types.js').QqEvent} event - an inbound message.
   * @returns {void}
   */
  const forward = (event) => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        log('qq-bridge: an event handler threw', error);
      }
    }
  };

  /**
   * Build and connect one named backend, leaving it detached on failure.
   *
   * @param {string} name - backend id.
   * @returns {Promise<{backend: import('./types.js').QqBackend, off: () => void}>} the connected backend and its unsubscribe handle.
   */
  const open = async (name) => {
    const factory = factories.get(name);
    if (factory === undefined) {
      throw new Error(`qq-bridge: unknown backend "${name}"; known: ${[...factories.keys()].join(', ')}`);
    }
    const backend = factory();
    const off = backend.onEvent(forward);
    try {
      await backend.connect();
    } catch (error) {
      off();
      // A backend that never opened may still have left a reconnect timer behind;
      // disconnecting is the only way to be sure it is quiet.
      try {
        await backend.disconnect();
      } catch {
        // Already down; nothing to report.
      }
      throw error;
    }
    return { backend, off };
  };

  return {
    /**
     * The stable namespace — deliberately not the active backend's name.
     * @returns {string} the session namespace.
     */
    id: namespace,

    /** What the active backend can do, right now. */
    get capabilities() {
      return current?.capabilities ?? new Set();
    },

    /** The active backend's account id, when it has one. */
    get selfId() {
      return String(current?.selfId ?? '');
    },

    /** Which backend is active. */
    get active() {
      return active;
    },

    /**
     * The configured backend ids, in configuration order.
     * @returns {string[]} the ids.
     */
    list() {
      return [...factories.keys()];
    },

    /**
     * Move to another backend.
     *
     * @param {string} name - backend id to activate.
     * @returns {Promise<{ok: boolean, changed: boolean, error?: string}>} the outcome.
     */
    async switchTo(name) {
      const want = String(name ?? '').trim();
      if (want === '') return { ok: false, changed: false, error: 'no backend named' };
      if (want === active) return { ok: true, changed: false };
      if (!factories.has(want)) {
        return { ok: false, changed: false, error: `unknown backend "${want}"; known: ${[...factories.keys()].join(', ')}` };
      }
      let next;
      let nextOff = () => {};
      try {
        const opened = await open(want);
        next = opened.backend;
        nextOff = opened.off;
      } catch (error) {
        // The old one is untouched and still connected. Say what failed rather
        // than reporting a switch that did not happen.
        const message = error instanceof Error ? error.message : String(error);
        log(`qq-bridge: could not switch to ${want}`, error);
        return { ok: false, changed: false, error: message };
      }
      const previous = current;
      const previousName = active;
      const previousDetach = detach;
      current = next;
      active = want;
      detach = nextOff;
      if (previous !== null) {
        // Only after the new one is confirmed connected: a switch that fails must
        // leave the working transport working.
        try {
          await previous.disconnect();
        } catch (error) {
          log(`qq-bridge: could not close ${previousName}`, error);
        }
        if (previousDetach !== null) previousDetach();
      }
      log(`qq-bridge: backend ${previousName === '' ? '(none)' : previousName} -> ${want}`);
      return { ok: true, changed: true };
    },

    /**
     * Connect the initial backend.
     * @returns {Promise<void>} resolves when it is connected.
     */
    async connect() {
      closed = false;
      const result = await this.switchTo(options.initial);
      if (!result.ok) throw new Error(`qq-bridge: could not connect backend "${options.initial}": ${result.error}`);
    },

    /**
     * Disconnect whatever is active.
     * @returns {Promise<void>} resolves when it is down.
     */
    async disconnect() {
      closed = true;
      const previous = current;
      current = null;
      active = '';
      if (detach !== null) detach();
      detach = null;
      if (previous !== null) {
        try {
          await previous.disconnect();
        } catch {
          // Shutdown must not fail on a transport that is already gone.
        }
      }
    },

    /**
     * Send through the active backend.
     *
     * @param {import('./types.js').QqTarget} target - where to send.
     * @param {import('./types.js').QqContent} content - what to send.
     * @returns {Promise<{ok: boolean, id?: string, error?: string}>} the outcome.
     */
    async send(target, content) {
      if (current === null) return { ok: false, error: 'no backend is connected' };
      return current.send(target, content);
    },

    /**
     * Subscribe to inbound messages.
     *
     * @param {(event: import('./types.js').QqEvent) => void} handler - the subscriber.
     * @returns {() => void} unsubscribe.
     */
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    /** Diagnostics, with the active backend named. */
    status() {
      const inner = current?.status() ?? { connected: false, since: 0 };
      return { connected: inner.connected === true, since: Number(inner.since ?? 0), backend: active, closed };
    },
  };
}
