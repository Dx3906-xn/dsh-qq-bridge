// Print raw OneBot events as they arrive, without answering any of them.
//
// The bridge's own logs are not enough to answer "was that message @-ed".
// admit() strips the synthesized `@你` marker before the agent sees the text, so
// an accepted group message reads the same whether or not it was mentioned — the
// one distinction that matters is exactly the one the text no longer carries.
//
// This connects as an additional passive client (NapCat broadcasts events to
// every connection) and prints what the backend really sent: the message
// segments, the `at` ids, the sender, the message id.
//
// Run: node tools\watch-events.mjs [seconds]
const [, , secondsArg] = process.argv;
const seconds = Math.max(1, Number(secondsArg) || 120);
const URL = process.env.ONEBOT_URL ?? 'ws://127.0.0.1:3001';

const socket = new WebSocket(URL);
let count = 0;

socket.addEventListener('message', (message) => {
  let frame;
  try {
    frame = JSON.parse(String(message.data));
  } catch {
    return;
  }
  if (frame.post_type !== 'message') return;
  count += 1;

  const segments = Array.isArray(frame.message) ? frame.message : [];
  const ats = segments
    .filter((segment) => segment?.type === 'at')
    .map((segment) => String(segment.data?.qq ?? ''));
  const text = segments
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('');

  const where = frame.message_type === 'group' ? `group ${frame.group_id}` : `private ${frame.user_id}`;
  console.log(`\n[${count}] ${where}  from ${frame.sender?.nickname ?? frame.user_id} (${frame.user_id})`);
  console.log(`    self_id: ${frame.self_id}`);
  console.log(`    text:    ${JSON.stringify(text)}`);
  console.log(`    at:      ${ats.length === 0 ? '(none)' : ats.join(', ')}`);
  console.log(`    mentionsSelf: ${ats.includes(String(frame.self_id))}`);
  console.log(`    id:      ${frame.message_id}`);
});

socket.addEventListener('open', () => {
  console.log(`listening on ${URL} for ${seconds}s`);
});

socket.addEventListener('error', () => {
  console.error('socket: could not connect');
  process.exitCode = 1;
});

setTimeout(() => {
  console.log(`\n${count} event(s) seen`);
  socket.close();
  process.exit(0);
}, seconds * 1000);
