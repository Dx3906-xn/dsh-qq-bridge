// A real WebSocket in front of a fake OneBot.
//
// The unit suite drives the backend through a fake `WebSocket` class, so it never
// crosses a socket: real handshakes, real masking, real frame boundaries are all
// untested there. This file is the smallest thing that puts a real socket in the
// middle, so the e2e run exercises the same code an operator's NapCat will.
//
// Usage:
//   const bot = await startFakeOneBot({ selfId: '99999' });
//   const backend = createOneBotBackend({ endpoint: bot.endpoint });  // real global WebSocket
//   bot.inbound('private', { text: '在吗' });
import { startWsServer } from './ws-server.mjs';

/**
 * Start a server that speaks enough OneBot 11 to be one.
 *
 * @param {{selfId?: string, nickname?: string, quiet?: boolean}} [options] - identity and chattiness.
 * @returns {Promise<object>} the handle.
 */
export async function startFakeOneBot(options = {}) {
  const selfId = String(options.selfId ?? '99999');
  const nickname = String(options.nickname ?? '大肥鱼');
  const ws = await startWsServer();
  /** Every action the bridge called, in order. */
  const actions = [];
  /** Every outbound message the bridge asked to send. */
  const sent = [];
  let messageSeq = 7000;
  /** Replies that should fail, keyed by action, consumed one per call. */
  const failures = [];

  ws.on((event) => {
    if (event.kind !== 'frame') return;
    const payload = event.payload;
    if (payload === null || typeof payload !== 'object') return;
    if (typeof payload.action !== 'string') return;
    actions.push({ action: payload.action, params: payload.params });

    /** @param {any} data - the reply body. */
    const reply = (data) => event.client.send({ status: 'ok', retcode: 0, data, echo: payload.echo });
    /** @param {number} code - OneBot retcode. @param {string} wording - the reason. */
    const fail = (code, wording) => event.client.send({ status: 'failed', retcode: code, wording, data: null, echo: payload.echo });

    const refusal = failures.findIndex((item) => item.action === payload.action);
    if (refusal >= 0) {
      const item = failures.splice(refusal, 1)[0];
      fail(item.retcode ?? 100, item.wording ?? 'refused');
      return;
    }

    if (payload.action === 'get_login_info') {
      reply({ user_id: Number(selfId), nickname });
      return;
    }
    if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
      const isGroup = payload.action === 'send_group_msg';
      messageSeq += 1;
      sent.push({
        kind: isGroup ? 'group' : 'private',
        id: String(isGroup ? payload.params.group_id : payload.params.user_id),
        text: String(payload.params.message ?? ''),
        messageId: String(messageSeq),
        at: Date.now(),
      });
      reply({ message_id: messageSeq });
      return;
    }
    // Anything else is an action this bridge should not be calling. Answering
    // politely would hide the mistake, so it fails loudly.
    fail(1404, `dsh-qq-bridge should not call ${payload.action}`);
  });

  return {
    endpoint: ws.endpoint,
    selfId,
    actions,
    sent,

    /**
     * Queue a failure for the next call of an action.
     * @param {string} action - the OneBot action name.
     * @param {{retcode?: number, wording?: string}} [detail] - how it fails.
     * @returns {void}
     */
    failNext(action, detail = {}) {
      failures.push({ action, ...detail });
    },

    /**
     * Deliver an inbound message as NapCat would: an array of segments.
     *
     * @param {'private'|'group'} kind - the conversation.
     * @param {{text?: string, from?: string, name?: string, group?: string, groupName?: string, atMe?: boolean, segments?: any[]}} [detail] - the message.
     * @returns {any} the payload that was delivered.
     */
    inbound(kind, detail = {}) {
      const from = String(detail.from ?? '10001');
      const name = String(detail.name ?? '林晚');
      const segments = detail.segments ?? [
        ...(detail.atMe === true ? [{ type: 'at', data: { qq: selfId } }] : []),
        { type: 'text', data: { text: String(detail.text ?? '你好') } },
      ];
      messageSeq += 1;
      const payload = kind === 'group'
        ? {
          post_type: 'message',
          message_type: 'group',
          group_id: Number(detail.group ?? 67890),
          group_name: String(detail.groupName ?? '学习小组'),
          message_id: messageSeq,
          user_id: Number(from),
          time: Math.floor(Date.now() / 1000),
          self_id: Number(selfId),
          sender: { user_id: Number(from), nickname: name, card: '' },
          message: segments,
          raw_message: String(detail.text ?? ''),
        }
        : {
          post_type: 'message',
          message_type: 'private',
          sub_type: 'friend',
          message_id: messageSeq,
          user_id: Number(from),
          time: Math.floor(Date.now() / 1000),
          self_id: Number(selfId),
          sender: { user_id: Number(from), nickname: name, card: '' },
          message: segments,
          raw_message: String(detail.text ?? ''),
        };
      ws.push(payload);
      return payload;
    },

    /** @returns {any[]} connected clients. */
    clients() {
      return ws.clients();
    },

    /** @returns {Promise<void>} resolves when closed. */
    close() {
      return ws.close();
    },
  };
}

/**
 * Wait until a condition holds.
 *
 * @param {() => boolean} predicate - what to wait for.
 * @param {{timeoutMs?: number, label?: string}} [options] - limits.
 * @returns {Promise<void>} resolves when it holds, throws when it does not.
 */
export async function waitFor(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label ?? 'a condition'}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
