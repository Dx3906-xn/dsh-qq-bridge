// Probe one get_msg call: does the backend return the quoted message, and in what shape?
const [, , idArg] = process.argv;
const id = String(idArg ?? '').trim();
if (id === '') {
  console.error('usage: node tools/get-msg.mjs <message-id>');
  process.exit(2);
}

const URL = process.env.ONEBOT_URL ?? 'ws://127.0.0.1:3001';
const socket = new WebSocket(URL);
const pending = new Map();
let seq = 0;

function call(action, params = {}) {
  const echo = `probe-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(echo, { resolve, reject });
    socket.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.delete(echo)) reject(new Error(`${action} timed out`));
    }, 10000);
  });
}

socket.addEventListener('message', (frame) => {
  let payload;
  try {
    payload = JSON.parse(typeof frame.data === 'string' ? frame.data : String(frame.data));
  } catch {
    return;
  }
  const waiter = pending.get(payload.echo);
  if (waiter === undefined) return;
  pending.delete(payload.echo);
  if (payload.retcode !== 0) waiter.reject(new Error(`retcode ${payload.retcode}: ${payload.message ?? ''}`));
  else waiter.resolve(payload.data);
});

socket.addEventListener('open', async () => {
  try {
    const data = await call('get_msg', { message_id: Number(id) });
    console.log('keys:', Object.keys(data ?? {}));
    console.log('message type:', Array.isArray(data?.message) ? 'array' : typeof data?.message);
    console.log('message:', JSON.stringify(data?.message).slice(0, 1200));
    console.log('sender:', JSON.stringify(data?.sender).slice(0, 300));
  } catch (error) {
    console.log('ERROR:', error instanceof Error ? error.message : String(error));
  } finally {
    socket.close();
    process.exit(0);
  }
});

socket.addEventListener('error', (event) => {
  console.log('SOCKET ERROR:', event?.message ?? 'unknown');
  process.exit(1);
});