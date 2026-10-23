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

import {
  admit,
  createAutoThrottle,
  createDailyBudget,
  createDedupe,
  createRateLimiter,
  createRoomLog,
  formatRoomContext,
  isSilence,
  sessionKey,
} from './policy.js';
import { cleanOutbound, splitMessage, splitParagraphs } from './text.js';

/**
 * Build the bridge.
 *
 * @param {object} options - wiring.
 * @param {import('./types.js').QqBackend} options.backend - the transport.
 * @param {{handle: (event: import('./types.js').QqEvent, text: string, key: string) => Promise<string>, busy?: (key: string) => boolean}} options.host - the agent side.
 * @param {object} options.settings - effective policy.
 * @param {'always'|'mention'|'auto'|'off'} options.settings.groupMode - when to answer in groups.
 * @param {readonly string[]} [options.settings.allowedGroups] - group whitelist; empty means all.
 * @param {number} [options.settings.autoMinIntervalMs] - in `auto`, the minimum gap between two decisions in one room; defaults to 45000.
 * @param {number} [options.settings.autoMaxPerHour] - in `auto`, how many decisions one room may cost per hour; defaults to 12.
 * @param {number} [options.settings.autoContextMessages] - in `auto`, how many recent lines the agent is shown; defaults to 12.
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
  // Only used by `auto`: the recent lines of each room, and the ceilings on how
  // often a room may cost a model call.
  const roomLog = createRoomLog(settings.autoContextMessages ?? 12);
  const autoThrottle = createAutoThrottle({
    minIntervalMs: settings.autoMinIntervalMs ?? 45_000,
    maxPerHour: settings.autoMaxPerHour ?? 12,
  });
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let healthTimer = null;
  /** The last account state seen, so a status report can answer without asking. */
  let lastHealth = { online: null, at: 0, detail: 'never checked' };
  let reportedOffline = false;

  /**
   * Messages that arrived while a turn was already running, per conversation.
   *
   * The queue is serial, so without this each of a burst becomes its own turn: the
   * person sends "在吗" "在不在" "人呢" over eight seconds, gets three separate
   * model calls, and receives three answers to what was one question. The live
   * transcripts show exactly that — "SILENT" three times in a row, and near
   * duplicates like "在" followed by "吃面 懒得想".
   *
   * So a message that arrives while its conversation is busy does not join the
   * queue. It joins a *batch*, and when the running turn finishes the batch is
   * handed over as one message. One thought, one answer.
   *
   * @type {Map<string, {event: any, texts: string[], firstAt: number, timer: ReturnType<typeof setTimeout>|null}>}
   */
  const batches = new Map();

  /**
   * Ask the backend whether the account is signed in, on a timer.
   *
   * The failure this exists for is not "the socket died" -- that one reconnects and
   * logs. It is "the socket is fine and the account is not", which is silent by
   * construction: sends fail with a vendor error, no events arrive, and nothing
   * distinguishes a bridge that is deaf from a room where nobody spoke.
   *
   * Reported once per transition rather than on every check: a warning every sixty
   * seconds for an offline account is a log nobody reads.
   */
  function startHealthCheck() {
    const intervalMs = Math.max(10_000, Number(settings.healthCheckMs) || 60_000);
    const tick = async () => {
      if (stopped) return;
      try {
        if (typeof backend.health === 'function') {
          const result = await backend.health();
          lastHealth = { online: result.online, at: now(), detail: result.detail ?? '' };
          if (result.online === false && !reportedOffline) {
            reportedOffline = true;
            log('qq-bridge: the account is NOT signed in. The socket is up but nothing will arrive; sign in again (NapCat WebUI or the QQ client).');
          } else if (result.online === true && reportedOffline) {
            reportedOffline = false;
            log('qq-bridge: the account is signed in again');
          }
        }
      } catch (error) {
        log('qq-bridge: health check failed', error);
      }
      if (stopped) return;
      healthTimer = setTimeout(tick, intervalMs);
      healthTimer.unref?.();
    };
    // The first check waits one interval: at connect time a quick-login is still
    // settling, and asking immediately reports offline for a healthy account.
    healthTimer = setTimeout(tick, intervalMs);
    healthTimer.unref?.();
  }

  /**
   * The pause before a reply, given how long the model already took.
   *
   * Two independent findings shape this, and they point the same way.
   *
   * The first is that a reply is judged on its *arrival*, not on its text. A CHI'26
   * study of 240 people found two-second answers rated as less thoughtful and less
   * useful than nine- or twenty-second ones — behaviour did not change, only the
   * impression. "Instant" is the one speed that reads as not having bothered.
   *
   * The second is that the model's own latency is already part of the pause. Adding
   * a fixed "thinking time" on top of a slow call produces a reply that arrives
   * both late and obviously delayed. Every project that measured this subtracts
   * what already elapsed; the persona, not the plumbing, should own the clock.
   *
   * So the *floor* is configurable behaviour, and it is measured from the moment the
   * message arrived rather than from the moment the answer was ready.
   *
   * @param {number} sinceAt - when the inbound message arrived.
   * @returns {number} milliseconds still to wait, possibly 0.
   */
  const humanPause = (sinceAt) => {
    const low = Math.max(0, Number(settings.replyDelayMinMs) || 0);
    const high = Math.max(low, Number(settings.replyDelayMaxMs) || 0);
    if (high === 0) return 0;
    const wanted = low + Math.random() * (high - low);
    const elapsed = Math.max(0, now() - sinceAt);
    return Math.max(0, wanted - elapsed);
  };

  /**
   * The pause between two bubbles of one reply.
   *
   * Separate from the thinking pause above because it answers a different question.
   * The thinking pause is "how long before I start"; this is "how long between one
   * message and the next", and the number is smaller and bounded differently — a
   * person splitting a thought into two bubbles does it in a second or two, not in
   * the eight seconds they might spend deciding what to say.
   *
   * Independent of length on purpose: the same person types the same speed, so a
   * fixed range per boundary is closer to how it reads than a per-character
   * estimate that makes the second bubble arrive slower than the first.
   *
   * @returns {number} milliseconds to wait.
   */
  const segmentGap = () => {
    const low = Math.max(0, Number(settings.segmentGapMinMs) || 0);
    const high = Math.max(low, Number(settings.segmentGapMaxMs) || 0);
    if (high === 0) return 0;
    return low + Math.random() * (high - low);
  };

  /**
   * When the message behind this turn actually arrived.
   *
   * Not "now": the pause is measured from arrival, so a slow model call eats into
   * it instead of stacking on top. Without this the person waits the model's time
   * plus the configured pause, which is the one combination that reads as both
   * broken and artificial.
   *
   * @param {import('./types.js').QqEvent} event - the admitted event.
   * @returns {number} epoch milliseconds.
   */
  const batchArrivedAt = (event) => {
    const at = Number(event?.at ?? 0);
    return at > 0 ? at : now();
  };

  /**
   * Send one outbound message, honouring the per-conversation gap and the split
   * limit.
   *
   * @param {import('./types.js').QqTarget} target - where to send.
   * @param {string} text - what to send.
   * @param {{proactive?: boolean, sinceAt?: number}} [flags] - `proactive` charges the daily budget; `sinceAt` adds the thinking pause measured from it.
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
    // A reply that arrives while the model is still "thinking" is fine; one that
    // arrives before the person has finished their sentence is not. The pause goes
    // before the rate-limit wait so the two compose in the order a person would
    // experience them.
    if (typeof flags.sinceAt === 'number') {
      const pause = humanPause(flags.sinceAt);
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    const gap = limiter.wait(key);
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    // A blank line in her output is a bubble boundary, so the reply is split on those
    // first and only then length-limited: a paragraph that is still too long for the
    // platform is cut again, but a paragraph that fits becomes exactly one message.
    const pieces = splitParagraphs(body).flatMap((part) => splitMessage(part, settings.maxChars ?? 1200));
    let sent = 0;
    for (const piece of pieces) {
      // Between two bubbles, not before the first one. A person who is splitting a
      // long thought into several messages pauses between them; the pause before
      // the first bubble is the thinking pause, which is a different thing and is
      // accounted for above. A fixed gap here turns three bubbles into a burst of
      // one, which reads as a wall of text arriving at once.
      if (sent > 0) {
        const between = segmentGap();
        if (between > 0) await new Promise((resolve) => setTimeout(resolve, between));
      }
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
    if (isSilence(answer)) {
      // `auto` hands the decision to the agent, which means it needs a way to say
      // "not now" that is not the same as being broken. The word is matched as the
      // whole answer, so a sentence containing it is still a sentence.
      log(`qq-bridge: ${key} chose not to speak`);
      return;
    }
    // Delivery is not fire-and-forget, and saying so is not optional.
    //
    // The person's side and the log's side are two different records of one
    // moment, and they diverge whenever a send fails quietly: the session says she
    // answered, the chat says she never did. Since the transport is the only place
    // that knows, it announces the outcome — a failure goes to the log, where a
    // missing reply becomes findable instead of being inferred from a screenshot
    // two days later.
    const result = await deliver(event.target, answer, { sinceAt: batchArrivedAt(event) });
    if (result?.ok !== true) {
      log(`qq-bridge: answer to ${key} was not delivered: ${result?.error ?? 'unknown error'}`);
    } else if (settings.groupMode === 'auto' && event.target.kind === 'group') {
      // Her own line goes into the room transcript. Without it the next brief
      // showed twelve lines of other people talking and none of her answer two
      // seconds earlier, so she had no way to know she had already spoken — which
      // is how a participant ends up answering the same remark twice.
      roomLog.noteSelf(String(event.target.id), answer);
    }
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
   * Join a message to the conversation's pending batch, or start one.
   *
   * The window exists because "the person has finished typing" is not knowable, so
   * the next best signal is "they have been quiet for a moment". A message that
   * lands inside the window does not get its own turn — it extends the batch, and
   * the whole batch is answered once the window closes.
   *
   * Two clocks, and only one of them may move.
   *
   * The quiet deadline is what "they have finished" means, so every new message
   * resets it — that is the whole point. But on its own it is unbounded: somebody
   * typing a long paragraph with a message every second would push the answer out
   * for as long as they keep typing, and the answer to the first sentence arrives
   * after the last. So there is also a hard deadline measured from the *first*
   * message of the batch, which no message may move.
   *
   * Whichever comes first wins. The consequence is honest: a long enough stream
   * gets split into more than one answer, which is what a person does too.
   *
   * @param {any} event - the admitted event, for its target and provenance.
   * @param {string} text - what the person said.
   * @param {string} key - the conversation's session id.
   * @returns {void}
   */
  const mergeOrRun = (event, text, key) => {
    const windowMs = Math.max(0, Number(settings.mergeWindowMs) || 0);
    if (windowMs === 0) {
      void enqueue(event, text, key);
      return;
    }
    const hardMs = Math.max(windowMs, Number(settings.mergeHardMs) || windowMs);

    const existing = batches.get(key);
    if (existing === undefined) {
      // The window applies to the *first* message too, not only to a burst. A
      // person who sends one line and then immediately sends a correction is the
      // same case as a burst, and answering the first line before the correction
      // arrives produces the "already answered that" reply. The window is short,
      // so a single message is delayed by it and nothing else.
      const batch = { event, texts: [text], firstAt: now(), timer: null };
      batch.timer = setTimeout(() => flushBatch(key), Math.min(windowMs, hardMs));
      batch.timer.unref?.();
      batches.set(key, batch);
      return;
    }
    existing.texts.push(text);
    // The latest event wins for provenance: an image or a quote on the newest
    // message is the one that matters, and the joined text already carries the
    // earlier lines.
    existing.event = event;
    // The quiet clock restarts, the hard clock does not. When the hard clock is the
    // nearer one, the batch is flushed on it and the new message joins the next one.
    if (existing.timer !== null) clearTimeout(existing.timer);
    const remaining = Math.max(0, existing.firstAt + hardMs - now());
    existing.timer = setTimeout(() => flushBatch(key), Math.min(windowMs, remaining));
    existing.timer.unref?.();
  };

  /**
   * Hand a completed batch to the queue as one message.
   *
   * @param {string} key - the conversation.
   * @returns {void}
   */
  const flushBatch = (key) => {
    const batch = batches.get(key);
    if (batch === undefined) return;
    batches.delete(key);
    if (batch.timer !== null) clearTimeout(batch.timer);
    if (stopped) return;
    const joined = batch.texts.join('\n');
    log(`qq-bridge: merged ${batch.texts.length} message(s) from ${key} into one turn`);
    void enqueue(batch.event, joined, key);
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

    if (settings.groupMode === 'auto' && event.target.kind === 'group') {
      // Every line is remembered, but only some lines are worth a model call. The
      // split matters: the transcript stays whole even when the decisions are
      // throttled, so a judgement made four messages later still sees the four
      // messages that led up to it.
      const room = String(event.target.id);
      // `card` is the group nickname and is very often present-but-empty, which
      // `??` does not fall through: every line in the transcript came out as
      // "某人" even for people with an obvious display name. Test the trimmed
      // value, not its presence.
      const name =
        String(event.sender?.card ?? '').trim() ||
        String(event.sender?.name ?? '').trim() ||
        '某人';
      roomLog.note(room, `${name}: ${decision.text}`);

      const mentioned = event.mentionsSelf === true;
      // Throttling is opt-in, and off by default for a reason the live logs made
      // plain: a throttled message was *dropped*, not deferred. The transcript kept
      // it, but nothing ever came back to judge it — so the last thing a room said
      // before going quiet was never looked at, and she sat silent through
      // "你还会吃饭？" simply because it arrived twelve seconds after her last
      // decision. The intent ("let the room finish its thought") was right; the
      // implementation lost the thought instead of waiting for it.
      //
      // Until deferral exists, the honest default is no throttle at all: every
      // line is judged, which costs more and misses nothing. A deployment that
      // needs the ceiling can turn it on and accept the loss knowingly.
      const throttled = settings.autoThrottle === true;
      if (throttled && !autoThrottle.allow(room, { urgent: mentioned })) {
        log(`qq-bridge: room ${room} is throttled; this line was not judged (that is the known cost of the ceiling)`);
        return { accepted: false, reason: 'auto: throttled, not judged' };
      }
      if (throttled) autoThrottle.note(room);

      const text = formatRoomContext({
        room,
        lines: roomLog.read(room, settings.autoContextMessages ?? 12),
        mentioned,
        language: settings.language ?? 'zh',
        selfNames: settings.selfNames ?? [],
        // How she has been talking here, so the brief can say "you spoke two
        // minutes ago" and she can decide to hold back. Recorded rather than
        // enforced: a limit would make the judgement in her persona dead weight.
        selfTalk: {
          sinceLast: roomLog.lastSelfAt(room) === 0 ? 0 : Date.now() - roomLog.lastSelfAt(room),
          countLastHour: roomLog.selfCount(room),
        },
      });
      // Marked so the transport wrapper does not prepend a "someone said:" envelope
      // to a text that is already a transcript. Without the marker the agent is told
      // that one person said the whole room's last twelve lines.
      //
      // Group transcripts are not merged. A batch is "one person finishing a
      // thought", and in a room the lines in the window come from different people
      // — joining them would hand the model one utterance in three voices.
      await enqueue({ ...inbound, autoContext: true }, text, key);
      return { accepted: true, reason: decision.reason };
    }

    mergeOrRun(inbound, decision.text, key);
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
      startHealthCheck();
    },

    /**
     * Whether the account behind the socket is signed in.
     *
     * Distinct from `stats().connected`, which only reports the WebSocket. The two
     * diverged for three hours on 2026-10-22 and nobody noticed.
     *
     * @returns {Promise<{online: boolean|null, detail?: string}>} the account state.
     */
    async health() {
      if (typeof backend.health !== 'function') return { online: null, detail: 'this backend has no health call' };
      if (stopped) return { online: null, detail: 'stopped' };
      return backend.health();
    },

    /**
     * Stop listening. In-flight turns are allowed to finish; the connection is
     * closed so no new ones arrive.
     * @returns {Promise<void>} resolves when the backend is closed.
     */
    async stop() {
      stopped = true;
      if (healthTimer !== null) clearTimeout(healthTimer);
      healthTimer = null;
      // Pending batches are dropped rather than flushed: shutdown is not the moment
      // to spend a model call, and a half-answered burst is worse than a clean stop.
      for (const batch of batches.values()) {
        if (batch.timer !== null) clearTimeout(batch.timer);
      }
      batches.clear();
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
      // No thinking pause here: a proactive message was not prompted by anything,
      // so there is nothing for the pause to look like. Adding it would only make
      // her check-ins arrive later than the moment she decided to send them.
      return deliver(target, text, { proactive: true });
    },

    /** Diagnostics for a status command or a log line. */
    stats() {
      return {
        connected: backend.status().connected,
        conversations: queues.size,
        dedupe: dedupe.size(),
        proactiveLeft: budget.remaining(),
        // The account state, which is a different question from `connected`. A
        // report that only answers the socket sends the reader looking in the
        // wrong place when nothing arrives.
        accountOnline: lastHealth.online,
        accountCheckedAt: lastHealth.at,
        accountDetail: lastHealth.detail,
      };
    },

    /** Whether a conversation is mid-turn, for tests and diagnostics. */
    busy(key) {
      return queues.has(key);
    },
  };
}
