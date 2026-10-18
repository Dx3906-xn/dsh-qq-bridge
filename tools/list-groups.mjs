// Ask the OneBot backend which groups the account is in.
//
// A group test needs a group id up front: mention mode is keyed on the id, and
// an allowlist is meaningless without one. Guessing "it is the only group" is
// how you end up testing the wrong thing, so this asks the backend.
//
// Run: node tools\list-groups.mjs
//
// Uses the global WebSocket, like lib/onebot.js does. Importing 'ws' here would
// give this script a dependency the package deliberately does not have, and the
// global one is the WHATWG interface: addEventListener, not on().
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
    const me = await call('get_login_info');
    console.log(`account: ${me.user_id} (${me.nickname})`);

    const groups = await call('get_group_list');
    const list = Array.isArray(groups) ? groups : [];
    if (list.length === 0) {
      console.log('groups: none — the account is in no group');
    } else {
      console.log(`groups: ${list.length}`);
      for (const group of list) {
        console.log(`  ${group.group_id}  ${group.group_name}  (${group.member_count ?? '?'} members)`);
      }
    }

    const friends = await call('get_friend_list');
    const list2 = Array.isArray(friends) ? friends : [];
    console.log(`friends: ${list2.length}`);
    for (const friend of list2.slice(0, 20)) {
      console.log(`  ${friend.user_id}  ${friend.nickname} ${friend.remark ? `(${friend.remark})` : ''}`);
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
