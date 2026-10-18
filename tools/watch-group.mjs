// Watch whether the bridge answers a group message.
//
// The question "did mention mode ignore that" is not answerable from the bridge's
// logs, because ignoring is silent by design. What is observable is the session
// directory: the bridge creates one per conversation it actually hands to the
// agent, so its appearance is the honest signal that a group message woke a turn.
//
// Run: node tools\watch-group.mjs <group-id> [seconds]
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , groupArg, secondsArg] = process.argv;
const group = String(groupArg ?? '');
if (group === '') {
  console.error('usage: node tools\\watch-group.mjs <group-id> [seconds]');
  process.exit(2);
}
const seconds = Math.max(1, Number(secondsArg) || 90);

const home = process.env.DSH_HOME ?? 'D:\\A\\DSH-L\\agent\\home';
// The key is URL-encoded into the directory name: ':' becomes ~003A.
const encoded = `qq~003Aonebot~003Agroup~003A${group}`;
const sessionsRoot = join(home, 'sessions', '--D-A-DSH-L--');
const dir = join(sessionsRoot, encoded);

const started = Date.now();
const before = existsSync(dir) ? readdirSync(dir).length : 0;
console.log(`watching ${dir}`);
console.log(`files before: ${before}`);
console.log(`waiting ${seconds}s...`);

const timer = setInterval(() => {
  const files = existsSync(dir) ? readdirSync(dir).length : 0;
  if (files !== before) {
    console.log(`\nthe bridge opened a group turn (${before} -> ${files} files after ${Math.round((Date.now() - started) / 1000)}s)`);
    console.log('verdict: the message was ANSWERED');
    clearInterval(timer);
    process.exit(0);
  }
}, 1000);

setTimeout(() => {
  clearInterval(timer);
  console.log(`\nno group session after ${seconds}s`);
  console.log('verdict: the message was IGNORED');
  process.exit(0);
}, seconds * 1000);
