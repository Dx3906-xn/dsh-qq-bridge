// Run every assertion suite, and say out loud what was skipped.
//
// Two kinds of file live in test/: assertion suites, which need nothing and must
// pass, and instruments (e2e scripts, database inspectors, migration helpers),
// which need an argument and may talk to a real deployment. The skip list is in
// the repository because a skip list that lives only in someone's shell history
// grows silently until the suite is passing because it is not running.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Files that need an argument or a live deployment; never run bare. */
const INSTRUMENTS = new Set([
  'e2e-agent.mjs',
  'fake-onebot.mjs',
  'fake-onebot-server.mjs',
  'ws-server.mjs',
  'helpers.mjs',
  'run-suites.mjs',
]);

const files = readdirSync(here)
  .filter((name) => name.endsWith('.mjs'))
  .filter((name) => !INSTRUMENTS.has(name))
  .sort();

const failed = [];
for (const file of files) {
  process.stdout.write(`\n=== ${file}\n`);
  const result = spawnSync(process.execPath, [join(here, file)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed.push(file);
}

// Only name files that are actually here. A skip list that names a missing file
// reads as "this is covered somewhere" and hides the fact that it is not.
const skipped = [...INSTRUMENTS]
  .filter((name) => name !== 'run-suites.mjs' && existsSync(join(here, name)))
  .sort();
console.log(`\n${'-'.repeat(60)}`);
console.log(`${files.length - failed.length}/${files.length} suites passed`);
if (skipped.length > 0) {
  console.log(`not run here (need an argument or a live deployment): ${skipped.join(', ')}`);
}
if (failed.length > 0) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exitCode = 1;
}

