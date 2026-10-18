// A OneBot 11 backend that lives in memory.
//
// It stands in for the `WebSocket` global so the backend code under test is the
// real one: the same `send`/`close`, the same event listener registration, the
// same frame strings. What it replaces is only the transport, because a test that
// needs NapCat running is a test that does not run.
//
// Usage:
//   const server = createFakeServer();
//   const backend = createOneBotBackend({ endpoint: 'ws://x', WebSocketImpl: server.Impl });
//   await backend.connect();
//   server.push({ post_type: 'message', ... });   // deliver an inbound event
//   server.replies.push({ retcode: 0, data: {} }); // shape the next action reply
export function createFakeServer(options = {}) {
  /** Frames the client sent, parsed. */
  const received = [];
  /** Sockets the client opened, oldest first. */
  const sockets = [];
  /** How many times a connection was attempted. */
  let attempts = 0;

  const server = {
    received,
    sockets,
    /** Set to refuse every connection attempt (the backend is "down"). */
    refuse: options.refuse === true,
    /** What the next action replies with; shift one per call. */
    replies: [],
    /** Answers `get_login_info` automatically unless a reply is queued. */
    selfId: options.selfId ?? '99999',
    /** Every action name asked for, in order. */
    actions: received,

    get attempts() {
      return attempts;
    },

    get connected() {
      return sockets.length > 0 && sockets[sockets.length - 1].readyState === 1;
    },

    /** Deliver an inbound frame to the newest client. @param {any} payload - the JSON body. */
    push(payload) {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) throw new Error('fake onebot: no client connected');
      socket.deliver(payload);
    },

    /**
     * Forget the oldest reply, so the next action gets a plain success whose data
     * is `{}` unless `selfId` is asked for.
     * @returns {any} the queued reply, if any.
     */
    takeReply() {
      return server.replies.shift();
    },

    /** The `WebSocket` class the backend should use. */
    Impl: class FakeWebSocket {
      /**
       * @param {string} url - the endpoint.
       * @param {any} [init] - options; only `headers` is inspected.
       */
      constructor(url, init) {
        attempts += 1;
        this.url = url;
        this.init = init;
        this.readyState = 0;
        /** @type {Map<string, ((event: any) => void)[]>} */
        this.listeners = new Map();
        sockets.push(this);
        // Opening is asynchronous in a real socket, and code that assumes
        // otherwise works in a test and fails in production. Kept on a timer for
        // the same reason.
        setTimeout(() => {
          if (server.refuse === true) {
            this.readyState = 3;
            this.emit('error', { type: 'error', message: 'refused' });
            this.emit('close', { type: 'close' });
            return;
          }
          this.readyState = 1;
          this.emit('open', { type: 'open' });
        }, 0);
      }

      /** @param {string} type - event name. @param {(event: any) => void} handler - listener. */
      addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
      }

      /** @param {string} type - event name. @param {any} event - payload. */
      emit(type, event) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }

      /** @param {string} frame - the JSON body the client wants to send. */
      send(frame) {
        const payload = JSON.parse(frame);
        received.push({ action: payload.action, params: payload.params, echo: payload.echo });
        const queued = server.replies.shift();
        // A queued reply may carry its own `retcode` (to exercise the failure
        // path) or just be `data`. Anything else is a plain success.
        const envelope = queued !== undefined && typeof queued === 'object' && ('retcode' in queued)
          ? { status: 'failed', retcode: Number(queued.retcode), wording: String(queued.wording ?? ''), data: queued.data ?? null }
          : {
            status: 'ok',
            retcode: 0,
            data: queued ?? (payload.action === 'get_login_info' ? { user_id: Number(server.selfId), nickname: '大肥鱼' } : {}),
          };
        // Answered on a timer: a backend that resolves before `send` returns would
        // hide an ordering bug in the pending-map bookkeeping.
        setTimeout(() => {
          this.deliver({ ...envelope, echo: payload.echo });
        }, 0);
      }

      /** Drop the connection as a network failure would. @param {number} [code] - close code. */
      close(code) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.closeCode = code;
        this.emit('close', { type: 'close', code });
      }

      /** @param {any} payload - one inbound frame. */
      deliver(payload) {
        if (this.readyState !== 1) return;
        this.emit('message', { type: 'message', data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      }
    },
  };

  return server;
}
