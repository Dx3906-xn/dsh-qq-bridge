// Shared scaffolding for the assertion suites: a counter with a face, and the
// fixtures the pure modules need.
//
// Not a test framework. Every suite here is a plain program that prints each
// check as it happens and sets a non-zero exit code at the end, because a suite
// whose output you cannot read is a suite whose failures you learn about from a
// green checkmark somewhere else.

/**
 * Create a check counter.
 *
 * @param {string} [title] - printed once at the start.
 * @returns {{check: (ok: boolean, label: string) => void, done: () => number, failures: number}} the counter.
 */
export function suite(title) {
  if (title !== undefined) console.log(title);
  let checks = 0;
  let failures = 0;
  return {
    check(ok, label) {
      checks += 1;
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    },
    /** Print the tally and set the exit code. @returns {number} how many checks failed. */
    done() {
      console.log(`\n${checks - failures}/${checks} checks passed`);
      if (failures > 0) process.exitCode = 1;
      return failures;
    },
    get failures() {
      return failures;
    },
  };
}

/**
 * A message event with sane defaults.
 *
 * @param {object} [over] - fields to override.
 * @returns {import('../lib/types.js').QqEvent} the event.
 */
export function messageEvent(over = {}) {
  return {
    kind: 'message',
    target: { kind: 'private', id: '10001', name: '林晚' },
    sender: { id: '10001', name: '林晚', card: '' },
    text: '你好',
    mentionsSelf: false,
    messageId: 'msg-1',
    at: Date.UTC(2026, 9, 19, 2, 0, 0),
    raw: {},
    ...over,
  };
}

/**
 * A stand-in backend that records what was sent to it.
 *
 * @param {{id?: string, capabilities?: string[], failSend?: boolean}} [options] - overrides.
 * @returns {any} the backend, plus a `sent` array.
 */
export function fakeBackend(options = {}) {
  /** @type {{target: any, content: any}[]} */
  const sent = [];
  /** @type {Set<(event: any) => void>} */
  const handlers = new Set();
  let connected = false;
  return {
    sent,
    id: options.id ?? 'onebot',
    capabilities: new Set(options.capabilities ?? ['private', 'group']),
    selfId: '99999',
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    async send(target, content) {
      if (options.failSend === true) return { ok: false, error: 'backend refused' };
      sent.push({ target, content });
      return { ok: true, id: `sent-${sent.length}` };
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    status() {
      return { connected, since: connected ? Date.now() : 0 };
    },
    /**
     * The account state, which is a different question from the socket.
     *
     * Defaults to "signed in when connected" because that is the ordinary case and
     * every existing test means a working transport. `accountOnline` overrides it
     * for the failure the real backend can now report: a socket that stays up while
     * the account behind it is gone.
     */
    async health() {
      if (options.healthThrows === true) throw new Error('health probe failed');
      const online = options.accountOnline === undefined
        ? (connected ? true : null)
        : options.accountOnline;
      return { online };
    },
    /** Deliver an event as the backend would. @param {any} event - the event. */
    emit(event) {
      for (const handler of handlers) handler(event);
    },
    /** How many listeners are attached, so a test can prove teardown happened. */
    get listeners() {
      return handlers.size;
    },
  };
}

/**
 * A stand-in host that answers with a fixed string and records the calls.
 *
 * @param {{answer?: string|((text: string) => string), fail?: boolean}} [options] - behaviour.
 * @returns {any} the host.
 */
export function fakeHost(options = {}) {
  /** @type {{event: any, text: string, key: string}[]} */
  const calls = [];
  return {
    calls,
    async handle(event, text, key) {
      calls.push({ event, text, key });
      if (options.fail === true) throw new Error('agent exploded');
      const answer = options.answer ?? '在的。';
      return typeof answer === 'function' ? answer(text) : answer;
    },
  };
}

/**
 * Wait until a predicate holds, or give up.
 *
 * Used instead of a fixed sleep: a test that waits 50ms for a promise chain
 * passes on this machine and fails on a slower one, and the failure looks like a
 * bug in the code under test.
 *
 * @param {() => boolean} predicate - what to wait for.
 * @param {{timeoutMs?: number, label?: string}} [options] - limits.
 * @returns {Promise<void>} resolves when it holds.
 */
export async function until(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label ?? 'a condition'}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
