// Ask the running NapCat who it is logged in as.
//
// This is the one question the log cannot answer reliably: after a kick the
// log keeps rotating QR codes, and "3001 is listening" only means the OneBot
// server is up, not that an account is behind it.
//
//   node tools/whoami.mjs [ws://127.0.0.1:3001]

const endpoint = process.argv[2] ?? 'ws://127.0.0.1:3001';

function call(socket, action, params = {}) {
  return new Promise((resolve, reject) => {
    const echo = `w${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`${action}: no answer in 8s`)), 8000);
    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.echo !== echo) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(payload);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ action, params, echo }));
  });
}

const socket = new WebSocket(endpoint);
socket.addEventListener('open', async () => {
  try {
    const info = await call(socket, 'get_login_info');
    if (info.retcode !== 0) {
      console.log(`not logged in: ${info.message || info.wording || info.retcode}`);
    } else {
      console.log(`account ${info.data.user_id} (${info.data.nickname})`);
    }
    const status = await call(socket, 'get_status');
    const online = status.data?.online;
    console.log(`online: ${online === undefined ? '(no field)' : online}`);
    const version = await call(socket, 'get_version_info');
    if (version.retcode === 0) console.log(`napcat: ${version.data.app_name} ${version.data.app_version}`);
    // A group list is the cheapest proof that the session works end to end.
    const groups = await call(socket, 'get_group_list');
    if (groups.retcode === 0) {
      console.log(`groups: ${groups.data.map((g) => `${g.group_id} ${g.group_name}`).join(' / ') || '(none)'}`);
    }
  } catch (error) {
    console.log(`failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
socket.addEventListener('error', () => {
  console.log(`cannot reach ${endpoint}`);
  process.exitCode = 1;
});
