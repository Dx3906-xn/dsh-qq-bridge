/**
 * The orchestration between "a message arrived" and "a message was sent".
 *
 * Deliberately free of both Cordis and OneBot: the backend and the agent host are
 * injected, so every decision here — who gets answered, what happens when the
 * agent is already busy, what is sent when the agent returns nothing — is
 * testable without a model, a socket, or a profile.
 *
 * The agent host is the seam. `handle(event, text)` takes one admitted message and
 * resolves to the text to send back; everything about sessions, presets and
 * prompts lives on the other side of it.
 *
 * @module dsh-qq-bridge/bridge
 */

import { admit, createDailyBudget, createDedupe, createRateLimiter, sessionKey } from './policy.js';
import { cleanOutbound, splitMessage } from './text.js';

/**
 * Build the bridge.
 *
 * @param {object} options - wiring.
 * @param {import('./types.js').QqBackend} options.backend - the transport.
 * @param {{handle: (event: import('./types.js').QqEvent, text: string, key: string) => Promise<string>, busy?: (key: string) => boolean}} options.host - the agent side.
 * @param {object} options.settings - effective policy.
 * @param {'always'|'mention'|'off'} options.settings.groupMode - when to answer in groups.
 * @param {readonly string[]} [options.settings.allowedGroups] - group whitelist; empty means all.
 * @param {number} [options.settings.minimumGapMs] - per-conversation send spacing; defaults to 1200.
 * @param {number} [options.settings.dailyProactive] - proactive messages per day; 0 disables them.
 * @param {number} [options.settings.maxChars] - soft limit per outbound message; defaults to 1200.
 * @param {boolean} [options.settings.ignoreAutoReply] - drop QQ's canned away-message; defaults to true.
 * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @returns {object} the bridge handle.
 */
export function createBridge(options) {
  const { backend, host, settings } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const dedupe = createDedupe(512);
  const limiter = createRateLimiter(settings.minimumGapMs ?? 1200, now);
  const budget = createDailyBudget(settings.dailyProactive ?? 0);
  /** @type {Map<string, Promise<void>>} */
  const queues = new Map();
  /** Messages this bridge sent, so an echo coming back is not answered. */
  const sentTexts = createDedupe(256);
  let stopped = false;

  /**
   * Send one outbound message, honouring the per-conversation gap and the split
   * limit.
   *
   * @param {import('./types.js').QqTarget} target - where to send.
   * @param {string} text - what to send.
   * @param {{proactive?: boolean}} [flags] - `proactive` charges the daily budget.
   * @returns {Promise<{ok: boolean, sent: number, error?: string}>} the outcome.
   */
  const deliver = async (target, text, flags = {}) => {
    const body = cleanOutbound(text);
    if (body === '') return { ok: false, sent: 0, error: 'empty message' };
    if (flags.proactive === true && !budget.spend()) {
      // A budget refusal is not an error the agent needs to see; it is the
      // operator's decision that this account is quiet today.
      return { ok: false, sent: 0, error: 'daily proactive budget exhausted' };
    }
    const key = `${target.kind}:${target.id}`;
    const gap = limiter.wait(key);
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    const pieces = splitMessage(body, settings.maxChars ?? 1200);
    let sent = 0;
    for (const piece of pieces) {
      const result = await backend.send(target, { text: piece });
      if (result.ok !== true) return { ok: false, sent, error: result.error ?? 'send failed' };
      sent += 1;
      limiter.mark(key);
      sentTexts.remember(piece);
    }
    return { ok: true, sent };
  };

  /**
   * Run one inbound message to completion, serialized per conversation.
   *
   * Serialized because two turns on one agent at once is two interleaved
   * conversations in the same context window: the model answers the second
   * message having already read the first answer it was still writing.
   *
   * @param {import('./types.js').QqEvent} event - the admitted message.
   * @param {string} text - the text to hand the agent.
   * @param {string} key - the conversation's session id.
   * @returns {Promise<void>} resolves when the reply has been sent or given up on.
   */
  const runTurn = async (event, text, key) => {
    let answer;
    try {
      answer = await host.handle(event, text, key);
    } catch (error) {
      log('qq-bridge: the agent failed to handle a message', error);
      // Silence is the wrong answer to an internal failure: the person is
      // waiting, and "something went wrong" is worse than nothing only if it is
      // said every time. Say it once per failure, not once per retry.
      await deliver(event.target, '我这边出了点问题，等一下再说。');
      return;
    }
    if (typeof answer !== 'string' || answer.trim() === '') {
      // An empty answer is a real outcome: the model may have replied through a
      // different channel, or decided the message needed none. Sending nothing is
      // correct, and inventing a filler reply would be worse.
      log(`qq-bridge: no reply for ${key}`);
      return;
    }
    await deliver(event.target, answer);
  };

  /**
   * Enqueue one message on its conversation's chain.
   *
   * @param {import('./types.js').QqEvent} event - the admitted message.
   * @param {string} text - the text to hand the agent.
   * @param {string} key - the conversation's session id.
   * @returns {Promise<void>} resolves when this message has been handled.
   */
  const enqueue = (event, text, key) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => (stopped ? undefined : runTurn(event, text, key))).catch((error) => {
      log('qq-bridge: a queued turn threw', error);
    });
    queues.set(key, next);
    void next.finally(() => {
      // Drop the chain when this is still the tail, so an idle bridge holds no
      // promise per conversation it has ever seen.
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  };

  /**
   * Handle one backend event.
   *
   * @param {import('./types.js').QqEvent} event - the inbound event.
   * @returns {Promise<{accepted: boolean, reason: string}>} what happened.
   */
  const onEvent = async (event) => {
    if (stopped) return { accepted: false, reason: 'stopped' };
    if (event.messageId !== '' && dedupe.seen(event.messageId)) {
      return { accepted: false, reason: 'duplicate' };
    }
    dedupe.remember(event.messageId);
    // An echo of our own reply looped back by the backend. The backend already
    // filters by self id, but a bridge that trusts only that answers itself the
    // first time the id is unknown, which is exactly at startup.
    if (sentTexts.seen(event.text)) return { accepted: false, reason: 'echo' };

    // Recover a quoted message when the reply itself is empty.
    //
    // The live shape that produced this: the person replies to a picture, adds an
    // @ and a space, and sends. The reply segment is dropped (a quote is normally
    // not content) and the @ is stripped, leaving "". The agent then answers an
    // empty line — and a model asked to reply to nothing writes its own reasoning
    // out as the message. Resolving the quote turns that back into the picture
    // that was actually being shown.
    let inbound = event;
    const stripped = String(event.text ?? '').replace(/^@你\s*/, '').trim();
    if (
      stripped === '' &&
      (event.images?.length ?? 0) === 0 &&
      typeof event.replyTo === 'string' &&
      event.replyTo !== '' &&
      typeof backend.getQuoted === 'function'
    ) {
      const quoted = await backend.getQuoted(event.replyTo);
      if (quoted !== null) {
        const merged = [quoted.text, event.text].filter((part) => String(part ?? '').trim() !== '').join(' ');
        inbound = {
          ...event,
          text: merged,
          images: [...(quoted.images ?? []), ...(event.images ?? [])],
        };
      }
    }

    const decision = admit(inbound, {
      groupMode: settings.groupMode,
      selfId: '',
      allowedGroups: settings.allowedGroups ?? [],
      // Defaults to true: an away-message is the one inbound that never has a
      // person behind it. The switch exists because a deployment that wants to
      // log which friends are away can turn it off.
      ignoreAutoReply: settings.ignoreAutoReply !== false,
    });
    if (!decision.accept) return { accepted: false, reason: decision.reason };

    const key = sessionKey(backend.id, event.target);
    await enqueue(inbound, decision.text, key);
    return { accepted: true, reason: decision.reason };
  };

  return {
    sessionKey: (target) => sessionKey(backend.id, target),

    /**
     * Start listening.
     * @returns {Promise<void>} resolves once the backend is connected.
     */
    async start() {
      stopped = false;
      backend.onEvent((event) => {
        void onEvent(event);
      });
      await backend.connect();
    },

    /**
     * Stop listening. In-flight turns are allowed to finish; the connection is
     * closed so no new ones arrive.
     * @returns {Promise<void>} resolves when the backend is closed.
     */
    async stop() {
      stopped = true;
      await backend.disconnect();
      // Wait for the chains to drain, but not forever: a turn waiting on a model
      // that never answers must not block shutdown.
      const chains = [...queues.values()];
      if (chains.length > 0) {
        await Promise.race([
          Promise.allSettled(chains),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
      queues.clear();
    },

    /**
     * Send a message that no inbound message asked for.
     *
     * This is the path a companion agent uses to check in, and the reason it has
     * its own budget: it is the only path initiated by the model rather than by a
     * person.
     *
     * @param {import('./types.js').QqTarget} target - where to send.
     * @param {string} text - what to send.
     * @returns {Promise<{ok: boolean, sent: number, error?: string}>} the outcome.
     */
    sendProactive(target, text) {
      if (settings.dailyProactive === 0) {
        return Promise.resolve({ ok: false, sent: 0, error: 'proactive messages are disabled' });
      }
      return deliver(target, text, { proactive: true });
    },

    /** Diagnostics for a status command or a log line. */
    stats() {
      return {
        connected: backend.status().connected,
        conversations: queues.size,
        dedupe: dedupe.size(),
        proactiveLeft: budget.remaining(),
      };
    },

    /** Whether a conversation is mid-turn, for tests and diagnostics. */
    busy(key) {
      return queues.has(key);
    },
  };
}
