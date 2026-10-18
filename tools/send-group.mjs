// Send one message to a group through the live OneBot backend.
//
// Two things this is for, neither of which a unit test can settle:
//
//   1. Whether send_group_msg works on a real group. The suites drive a fake
//      socket; the wire format and the retcode are the backend's business.
//   2. Whether the echo filter holds. A message this account sends comes back
//      as an event in some backend configurations, and if it is not dropped the
//      agent answers itself. Sending one and watching the bridge for a turn is
//      the only honest test of that.
//
// Run: node tools\send-group.mjs <group-id> <text...>
const [, , groupArg, ...words] = process.argv;
const group = String(groupArg ?? '');
const text = words.join(' ');

if (group === '' || text === '') {
  console.error('usage: node tools\\send-group.mjs <group-id> <text...>');
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
    }, 15000);
  });
}

socket.addEventListener('message', (message) => {
  let frame;
  try {
    frame = JSON.parse(String(message.data));
  } catch {
    return;
  }
  if (!frame.echo) return;
  const waiter = pending.get(frame.echo);
  if (!waiter) return;
  pending.delete(frame.echo);
  if (frame.retcode !== 0 && frame.retcode !== undefined) {
    waiter.reject(new Error(`retcode ${frame.retcode}: ${frame.message ?? ''}`));
    return;
  }
  waiter.resolve(frame.data);
});

socket.addEventListener('open', async () => {
  try {
    // A number on the wire, which is what NapCat expects; a string is accepted
    // by some backends and silently ignored by others.
    const sent = await call('send_group_msg', { group_id: Number(group), message: text });
    console.log(`sent to group ${group}, message_id=${sent?.message_id ?? '(none)'}`);
  } catch (error) {
    console.error(`failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});

socket.addEventListener('error', () => {
  console.error('socket: could not connect');
  process.exitCode = 1;
});

socket.addEventListener('close', () => process.exit());
