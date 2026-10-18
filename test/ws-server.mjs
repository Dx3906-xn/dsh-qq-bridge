// A OneBot-shaped WebSocket server, small enough to read.
//
// The assertion suites drive the backend through a fake `WebSocket` class, which
// is the right thing for unit tests and the wrong thing for an end-to-end run:
// it never exercises a real handshake, real masking, or real frame boundaries. So
// the e2e run gets a real server — HTTP upgrade, `Sec-WebSocket-Accept`, the
// frame codec — and a real `WebSocket` client on the other end.
//
// It implements exactly the slice of RFC 6455 that OneBot needs: text frames,
// fragmentation, ping/pong and close. No extensions, no binary, no compression.
//
// @module dsh-qq-bridge/test/ws-server

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/** The GUID from RFC 6455 §1.3, used to derive the accept key. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Encode one frame.
 *
 * @param {number} opcode - 1 text, 8 close, 9 ping, 10 pong.
 * @param {Buffer} payload - the body.
 * @returns {Buffer} the frame.
 */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/**
 * Start the server.
 *
 * @param {{host?: string, port?: number}} [options] - where to listen; port 0 picks a free one.
 * @returns {Promise<object>} the server handle.
 */
export async function startWsServer(options = {}) {
  /** @type {Set<any>} */
  const clients = new Set();
  /** @type {(frame: any) => void[]} */
  const handlers = [];
  const server = createServer((request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' });
    response.end('upgrade required\n');
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const client = {
      socket,
      id: randomUUID(),
      /** Everything the client sent, as parsed JSON when it parses. */
      frames: [],
      headers: request.headers,
      alive: true,
      /** @param {any} payload - the JSON body to send. */
      send(payload) {
        if (!client.alive) return;
        socket.write(encodeFrame(1, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')));
      },
      close() {
        if (!client.alive) return;
        client.alive = false;
        socket.write(encodeFrame(8, Buffer.alloc(0)));
        socket.end();
        clients.delete(client);
      },
    };
    clients.add(client);
    for (const handler of handlers) handler({ kind: 'open', client });

    /** Accumulated bytes for the frame currently being read. */
    let buffer = Buffer.alloc(0);
    /** @type {Buffer[]} */
    let fragments = [];
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readFrame(buffer);
        if (frame === null) return;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 8) {
          client.alive = false;
          clients.delete(client);
          socket.end();
          for (const handler of handlers) handler({ kind: 'close', client });
          return;
        }
        if (frame.opcode === 9) {
          socket.write(encodeFrame(10, frame.payload));
          continue;
        }
        if (frame.opcode === 10) continue;
        fragments.push(frame.payload);
        // Continuation frames carry opcode 0; the first frame carries 1 or 2.
        if (frame.fin === false) continue;
        const body = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        client.frames.push(parsed);
        for (const handler of handlers) handler({ kind: 'frame', client, payload: parsed });
      }
    });
    socket.on('close', () => {
      if (client.alive) {
        client.alive = false;
        clients.delete(client);
        for (const handler of handlers) handler({ kind: 'close', client });
      }
    });
    socket.on('error', () => {
      // A client that vanishes mid-frame is a normal event, not a server error.
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    endpoint: `ws://127.0.0.1:${port}`,
    server,

    /** @returns {any[]} the currently connected clients. */
    clients() {
      return [...clients];
    },

    /** @returns {any[]} every frame every client has sent, oldest first. */
    frames() {
      return [...clients].flatMap((client) => client.frames);
    },

    /**
     * Subscribe to connection, frame and close events.
     * @param {(event: {kind: 'open'|'frame'|'close', client: any, payload?: any}) => void} handler - the listener.
     * @returns {() => void} unsubscribe.
     */
    on(handler) {
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },

    /**
     * Send one JSON payload to every connected client.
     * @param {any} payload - the body.
     * @returns {number} how many clients received it.
     */
    broadcast(payload) {
      let sent = 0;
      for (const client of clients) {
        client.send(payload);
        sent += 1;
      }
      return sent;
    },

    /**
     * Send to the newest client, which is the one that just connected.
     * @param {any} payload - the body.
     * @returns {boolean} whether a client was there to receive it.
     */
    push(payload) {
      const list = [...clients];
      const last = list[list.length - 1];
      if (last === undefined) return false;
      last.send(payload);
      return true;
    },

    /** Close every client and stop listening. @returns {Promise<void>} resolves when down. */
    async close() {
      for (const client of [...clients]) client.close();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * Read one frame off the front of a buffer.
 *
 * Returns null when the buffer does not yet hold a whole frame, which is the
 * normal case on a socket: frames arrive in pieces.
 *
 * @param {Buffer} buffer - accumulated bytes.
 * @returns {{fin: boolean, opcode: number, payload: Buffer, consumed: number}|null} the frame, or null.
 */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  // A client must mask; a masked frame carries a 4-byte key before the body.
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const raw = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== null) {
    for (let i = 0; i < raw.length; i += 1) raw[i] ^= mask[i % 4];
  }
  return { fin, opcode, payload: raw, consumed: offset + length };
}
