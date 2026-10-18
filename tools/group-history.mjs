// Fetch recent group history from the backend and print the raw message shape.
//
// Watching live events proves what arrives, but not what the *segment array*
// looked like: a hand-typed "@LD" and a real @-mention both surface as text in a
// flattened view, and only one of them carries an `at` segment. get_group_msg_history
// returns the stored form, so this prints the segments verbatim.
//
// Run: node tools\group-history.mjs <group-id> [count]
const [, , groupArg, countArg] = process.argv;
const group = String(groupArg ?? '');
if (group === '') {
  console.error('usage: node tools\\group-history.mjs <group-id> [count]');
  process.exit(2);
}
const count = Math.max(1, Math.min(50, Number(countArg) || 10));

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
    const data = await call('get_group_msg_history', { group_id: Number(group), count });
    const messages = Array.isArray(data) ? data : (data?.messages ?? []);
    console.log(`${messages.length} message(s) in group ${group}\n`);
    for (const item of messages) {
      const sender = item.sender ?? {};
      console.log(`--- id ${item.message_id}  from ${sender.nickname ?? sender.user_id} (${sender.user_id})`);
      console.log(`    raw message: ${JSON.stringify(item.message)}`);
      if (Array.isArray(item.message)) {
        const ats = item.message.filter((s) => s?.type === 'at').map((s) => s.data?.qq);
        console.log(`    at segments: ${ats.length === 0 ? '(none)' : ats.join(', ')}`);
      }
      console.log('');
    }
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
