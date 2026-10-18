// The whole thing, for real: a DSH host tree, a real agent, a real model, a real
// socket, and a fake QQ on the far end.
//
// Everything else in test/ replaces one of those to keep the run cheap and
// deterministic. This replaces just one: the QQ server. It boots the actual
// harness with this plugin mounted, lets the bridge connect to a real WebSocket,
// pushes inbound messages at it, and asserts on what came back out — which is the
// only way to know that the assembled tree, the agent preset, the model route and
// the session store agree with each other.
//
// It costs model tokens, so it is not part of `npm test`.
//
// Usage:
//   node test/e2e-agent.mjs                                   # builds a throwaway home
//   node test/e2e-agent.mjs D:\A\DSH-L\agent\home-e2e         # reuse a path (wiped)
//   node test/e2e-agent.mjs <home> --source <dsh home>        # credentials from elsewhere
//   node test/e2e-agent.mjs <home> --bin <path to bin.js>
//
// Requires a real DEEPSEEK_API_KEY in <source>/.credentials.yaml.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOneBot, waitFor } from './fake-onebot-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, '..');

const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith('--')));
const positionals = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
/** @param {string} name - flag name without dashes. @returns {string} its value, or ''. */
const flagValue = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : '';
};

const home = resolve(positionals[0] ?? join(here, '..', '.e2e-home'));
const source = resolve(flagValue('source') || 'D:\\A\\DSH-L\\agent\\home');
const bin = flagValue('bin') || 'D:\\A\\DSH-L\\agent\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

let failures = 0;
/** @param {boolean} ok - did it hold. @param {string} label - what was checked. */
function check(ok, label) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

/**
 * Ask the OS for a port nobody is using.
 * @returns {Promise<number>} the port.
 */
function freePort() {
  return new Promise((resolve_, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve_(port));
    });
  });
}

/**
 * Build a DSH home whose only job is to run this plugin.
 *
 * Written in JavaScript rather than copied from a live home: `Copy-Item -Recurse`
 * follows the junctions in a profile's node_modules into the harness install and
 * turns a 3 MB home into 900 MB of duplicates, and the run then tests the snapshot
 * it copied instead of the code in this repository.
 *
 * @returns {string} the home path.
 */
function buildHome() {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const credentials = join(source, '.credentials.yaml');
  if (!existsSync(credentials)) throw new Error(`no credentials at ${credentials}; this run needs a real model key`);
  writeFileSync(join(home, '.credentials.yaml'), readFileSync(credentials));
  const anonymous = join(source, '.anonymous-user-id');
  if (existsSync(anonymous)) writeFileSync(join(home, '.anonymous-user-id'), readFileSync(anonymous));

  const profileDir = join(home, 'profiles', 'qq');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-qq',
    private: true,
    dependencies: { 'dsh-qq-bridge': `link:${plugin.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-qq-bridge'] } },
  }, null, 2)}\n`);
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n');
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  // The plugin's own bundle patch inserts a row named `qq-bridge`; this profile
  // layer is what gives it a backend to talk to.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# Written by test/e2e-agent.mjs; rewritten on every run.',
    '- id: qq-bridge',
    '  name: dsh-qq-bridge',
    '  config:',
    `    endpoint: ${JSON.stringify(endpoint)}`,
    '    groupMode: mention',
    '    minimumGapMs: 0',
    '    language: zh',
    '',
  ].join('\n'));
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  symlinkSync(plugin, join(profileDir, 'node_modules', 'dsh-qq-bridge'), 'junction');
  return home;
}

const port = await freePort();
const bot = await startFakeOneBot({ selfId: '99999', nickname: '大肥鱼' });
/** @type {string} */
let endpoint = `ws://127.0.0.1:${new URL(bot.endpoint).port}`;
buildHome();
console.log(`e2e: home ${home}`);
console.log(`e2e: fake onebot ${endpoint}, web ${port}`);

/** @type {string[]} */
const output = [];
const child = spawn(process.execPath, [bin, '--profile', 'qq', '--port', String(port), '--no-open'], {
  cwd: home,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));

/**
 * Stop the harness and the fake server.
 * @returns {Promise<void>} resolves when both are down.
 */
async function shutdown() {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve_) => child.once('exit', resolve_)),
      new Promise((resolve_) => setTimeout(resolve_, 5000)),
    ]);
    if (child.exitCode === null) {
      const { spawnSync } = await import('node:child_process');
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
  await bot.close();
}

try {
  console.log('\nconnecting');
  await waitFor(() => bot.clients().length > 0, { timeoutMs: 120000, label: 'the bridge to connect' });
  check(true, 'the plugin mounted and opened a WebSocket to the backend');
  await waitFor(() => bot.actions.some((item) => item.action === 'get_login_info'), { timeoutMs: 30000, label: 'get_login_info' });
  check(true, 'it asked who it is, so @-detection has an id to compare against');

  // --- one private conversation, two turns ------------------------------------
  // The fact asserted on is deliberately not the sender's nickname: the envelope
  // already carries that, so a reply that repeats it proves nothing.
  console.log('\nprivate chat');
  bot.inbound('private', { from: '10001', name: '临晚', text: '我家有两只猫，一只叫年糕，是橘猫。' });
  await waitFor(() => bot.sent.length >= 1, { timeoutMs: 180000, label: 'the first reply' });
  check(bot.sent[0].kind === 'private' && bot.sent[0].id === '10001', `the reply went back to the person who wrote (got ${bot.sent[0].kind}:${bot.sent[0].id})`);
  check(bot.sent[0].text.trim() !== '', 'the reply has text in it');
  console.log(`     reply 1: ${bot.sent[0].text.slice(0, 120).replace(/\n/g, ' ')}`);

  const beforeSecond = bot.sent.length;
  bot.inbound('private', { from: '10001', name: '临晚', text: '我家猫叫什么名字？' });
  await waitFor(() => bot.sent.length > beforeSecond, { timeoutMs: 180000, label: 'the second reply' });
  const second = bot.sent[bot.sent.length - 1].text;
  check(/年糕/.test(second), `the second turn remembered the first (reply: ${second.slice(0, 120).replace(/\n/g, ' ')})`);
  check(bot.clients().length === 1, 'the second turn reused the conversation instead of opening a new one');

  // --- a group that was not addressed -----------------------------------------
  console.log('\ngroup');
  const beforeGroup = bot.sent.length;
  bot.inbound('group', { from: '10002', name: '阿橘', groupName: '画画的朋友', text: '今天好热啊' });
  await new Promise((resolve_) => setTimeout(resolve_, 8000));
  check(bot.sent.length === beforeGroup, 'group chatter without a mention is not answered');

  bot.inbound('group', { from: '10002', name: '阿橘', groupName: '画画的朋友', atMe: true, text: '大肥鱼你也在吗' });
  await waitFor(() => bot.sent.length > beforeGroup, { timeoutMs: 180000, label: 'the group reply' });
  const groupReply = bot.sent[bot.sent.length - 1];
  check(groupReply.kind === 'group' && groupReply.id === '67890', `a mentioned group message is answered in that group (got ${groupReply.kind}:${groupReply.id})`);
  console.log(`     reply 3: ${groupReply.text.slice(0, 120).replace(/\n/g, ' ')}`);
} catch (error) {
  failures += 1;
  console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await shutdown();
}

const tail = output.join('').split('\n').slice(-40).join('\n');
console.log(`\n--- harness output (tail)\n${tail}`);
console.log(`\n${failures === 0 ? 'THE BRIDGE ANSWERS ON A REAL HOST' : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exitCode = 1;
