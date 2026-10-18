/**
 * OneBot 11 over a forward WebSocket.
 *
 * Why the forward connection (the bridge dials the backend, not the other way
 * round): NapCat and LLBot both offer it, it needs no listening port and no
 * inbound auth callback, and it means the bridge can be restarted at will without
 * the backend noticing an open socket it has to clean up. The reverse direction
 * would make the bridge a server, which is a much larger surface for a component
 * that handles other people's messages.
 *
 * The protocol itself is small: every outbound call is
 * `{action, params, echo}` and every inbound packet is either an event (`post_type`
 * present) or the reply to a call (`echo` matching one we sent). This file keeps
 * exactly that much of it, and nothing else.
 *
 * @module dsh-qq-bridge/onebot
 */

import { flattenMessage } from './text.js';

/** The actions this backend implements, as OneBot action names. */
const ACTIONS = {
  sendPrivate: 'send_private_msg',
  sendGroup: 'send_group_msg',
  selfInfo: 'get_login_info',
};

/**
 * Build a OneBot 11 backend.
 *
 * @param {object} options - connection settings.
 * @param {string} options.endpoint - `ws://host:port/path`, the backend's WS server.
 * @param {string} [options.accessToken] - sent as `Authorization: Bearer …` when set.
 * @param {number} [options.callTimeoutMs] - how long one action may take; defaults to 15000.
 * @param {number} [options.reconnectMinMs] - first retry delay; defaults to 1000.
 * @param {number} [options.reconnectMaxMs] - retry delay ceiling; defaults to 60000.
 * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {typeof WebSocket} [options.WebSocketImpl] - for tests and for a runtime without a global WebSocket.
 * @returns {import('./types.js').QqBackend & {selfId: string}} the backend.
 */
export function createOneBotBackend(options) {
  const endpoint = String(options.endpoint ?? '');
  if (endpoint === '') throw new Error('dsh-qq-bridge: onebot endpoint is required');
  const accessToken = String(options.accessToken ?? '');
  const callTimeoutMs = Number(options.callTimeoutMs) || 15000;
  const reconnectMinMs = Math.max(100, Number(options.reconnectMinMs) || 1000);
  const reconnectMaxMs = Math.max(reconnectMinMs, Number(options.reconnectMaxMs) || 60000);
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  // `globalThis.WebSocket` exists from Node 22 on; taking it from an option is
  // what lets the test suite drive a fake server without monkey-patching globals.
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof Impl !== 'function') {
    throw new Error('dsh-qq-bridge: this Node runtime has no global WebSocket; pass WebSocketImpl');
  }

  /** @type {WebSocket|null} */
  let socket = null;
  let connectedAt = 0;
  let retryDelay = reconnectMinMs;
  let retryTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  let closedByUs = false;
  let echoSeq = 0;
  /** Resolved by the next `open` event on the socket being dialled, or by its close. */
  let opening = /** @type {Promise<boolean>|null} */ (null);
  /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  /** @type {Set<(event: import('./types.js').QqEvent) => void>} */
  const handlers = new Set();
  let selfId = '';

  const settleAll = (error) => {
    for (const [echo, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(echo);
    }
  };

  /**
   * Send one action and wait for its echo reply.
   *
   * @param {string} action - OneBot action name.
   * @param {Record<string, unknown>} params - action parameters.
   * @returns {Promise<any>} the reply's `data`.
   */
  const call = (action, params) => new Promise((resolve, reject) => {
    const active = socket;
    if (active === null || active.readyState !== 1) {
      reject(new Error('onebot: not connected'));
      return;
    }
    echoSeq += 1;
    const echo = `qqb-${echoSeq}`;
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`onebot: ${action} timed out after ${callTimeoutMs}ms`));
    }, callTimeoutMs);
    // Register before sending: a backend that answers synchronously (a fake in a
    // test, or a very fast local NapCat) can reply before `send` returns.
    pending.set(echo, { resolve, reject, timer });
    try {
      active.send(JSON.stringify({ action, params, echo }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(echo);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  /**
   * Turn a raw OneBot event into the bridge's own shape.
   *
   * Only `post_type: 'message'` is translated. Notices and requests are dropped
   * rather than forwarded: a friend request or a group invite is an operator
   * decision, not something an agent should be able to accept by replying, and a
   * transport that forwards them hands the model a lever it must never pull.
   *
   * @param {any} payload - one parsed inbound packet.
   * @returns {import('./types.js').QqEvent|null} the event, or null when it is not one.
   */
  const translate = (payload) => {
    if (payload === null || typeof payload !== 'object') return null;
    if (payload.post_type !== 'message') return null;
    const kind = payload.message_type;
    if (kind !== 'private' && kind !== 'group') return null;
    const senderRaw = payload.sender ?? {};
    const senderId = String(payload.user_id ?? senderRaw.user_id ?? '');
    if (senderId === '') return null;
    // A message from this account (another client, or an echo) is not inbound
    // conversation. Answering it would make the bot talk to itself.
    //
    // The comparison uses the packet's own `self_id` first, because `get_login_info`
    // is a round trip: between connecting and its answer arriving, `selfId` is ''
    // and a check that only consulted it would pass the bot's own message through.
    const ownId = senderId === selfId || (payload.self_id !== undefined && senderId === String(payload.self_id));
    if (ownId) return null;
    const flatten = flattenMessage(payload.message, { selfId });
    const target = kind === 'group'
      ? { kind: 'group', id: String(payload.group_id ?? ''), name: String(payload.group_name ?? '') }
      : { kind: 'private', id: senderId, name: String(senderRaw.nickname ?? '') };
    if (target.id === '') return null;
    return {
      kind: 'message',
      target,
      sender: {
        id: senderId,
        name: String(senderRaw.nickname ?? senderRaw.card ?? senderId),
        card: String(senderRaw.card ?? ''),
      },
      text: flatten.text,
      mentionsSelf: flatten.mentionsSelf,
      messageId: String(payload.message_id ?? ''),
      at: Number(payload.time ?? 0) > 0 ? Number(payload.time) * 1000 : now(),
      raw: payload,
    };
  };

  const scheduleReconnect = () => {
    if (closedByUs) return;
    if (retryTimer !== null) return;
    const delay = retryDelay;
    // Exponential with a ceiling, and the ceiling matters: a backend that is down
    // for an hour should not be retried 3600 times, and a backend that comes back
    // should be noticed within a minute.
    retryDelay = Math.min(reconnectMaxMs, Math.round(retryDelay * 1.7));
    log(`onebot: reconnecting in ${delay}ms`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void open();
    }, delay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  const open = async () => {
    if (closedByUs) return;
    if (socket !== null && (socket.readyState === 0 || socket.readyState === 1)) return;
    /** @type {WebSocket} */
    let fresh;
    try {
      fresh = accessToken === ''
        ? new Impl(endpoint)
        : new Impl(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (error) {
      log('onebot: connect failed', error);
      scheduleReconnect();
      return;
    }
    /** @type {(ok: boolean) => void} */
    let settleOpen = () => {};
    opening = new Promise((resolve) => {
      settleOpen = resolve;
    });
    socket = fresh;

    fresh.addEventListener('open', () => {
      connectedAt = now();
      retryDelay = reconnectMinMs;
      settleOpen(true);
      log(`onebot: connected to ${endpoint}`);
      void call(ACTIONS.selfInfo, {}).then((data) => {
        const id = String(data?.user_id ?? '');
        if (id !== '') selfId = id;
      }).catch((error) => {
        // Not fatal: sending does not need the id, and @ detection degrades to
        // "nobody is mentioned" rather than to "everybody is".
        log('onebot: could not read login info', error);
      });
    });

    fresh.addEventListener('message', (frame) => {
      let payload;
      try {
        payload = JSON.parse(String(frame.data));
      } catch {
        log('onebot: dropped a frame that is not JSON');
        return;
      }
      const echo = payload === null || typeof payload !== 'object' ? undefined : payload.echo;
      if (typeof echo === 'string' && pending.has(echo)) {
        const entry = pending.get(echo);
        pending.delete(echo);
        clearTimeout(entry.timer);
        // OneBot reports failure in-band: HTTP-style `status`/`retcode`, with the
        // reason in `wording`. Treating a `retcode` of 0 as success is the whole
        // contract.
        const code = Number(payload.retcode ?? 0);
        if (code === 0) entry.resolve(payload.data ?? {});
        else entry.reject(new Error(`onebot: ${String(payload.wording ?? 'action failed')} (retcode ${code})`));
        return;
      }
      const event = translate(payload);
      if (event === null) return;
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          log('onebot: an event handler threw', error);
        }
      }
    });

    fresh.addEventListener('close', () => {
      if (socket === fresh) socket = null;
      // Anything still waiting here was waiting for this socket: a connect that
      // has not opened yet, and calls that were in flight.
      settleOpen(false);
      settleAll(new Error('onebot: connection closed'));
      log('onebot: connection closed');
      scheduleReconnect();
    });

    fresh.addEventListener('error', (error) => {
      // The close event follows, and that is where reconnection is decided; this
      // handler exists so the runtime does not report an unhandled error.
      log('onebot: socket error', error);
    });

    // Waiting here is the point of the whole dance: `connect()` returning before
    // the socket is usable means the first message after startup is sent into a
    // socket with readyState 0 and comes back "not connected", which reads like a
    // backend problem and is not.
    await opening;
    opening = null;
  };

  return {
    id: 'onebot',
    // A OneBot backend can do exactly this. Listing the capabilities this bridge
    // does not implement (files, images, recall, member lists) is the point: the
    // tool surface is derived from this set, so an unimplemented verb is never
    // offered to the model.
    capabilities: new Set(['private', 'group']),
    get selfId() {
      return selfId;
    },
    async connect() {
      closedByUs = false;
      await open();
    },
    async disconnect() {
      closedByUs = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      settleAll(new Error('onebot: disconnected'));
      const active = socket;
      socket = null;
      if (active !== null) {
        try {
          active.close();
        } catch {
          // Closing an already-broken socket is not an error worth reporting.
        }
      }
    },
    async send(target, content) {
      const action = target.kind === 'group' ? ACTIONS.sendGroup : ACTIONS.sendPrivate;
      const params = target.kind === 'group'
        ? { group_id: Number(target.id), message: content.text }
        : { user_id: Number(target.id), message: content.text };
      try {
        const data = await call(action, params);
        return { ok: true, id: String(data?.message_id ?? '') };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    status() {
      return { connected: socket !== null && socket.readyState === 1, since: connectedAt };
    },
  };
}
