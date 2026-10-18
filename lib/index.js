/**
 * A QQ channel for a DSH agent.
 *
 * The shape of the thing, in one paragraph: a backend (today: OneBot 11 over a
 * forward WebSocket, as served by NapCat or LLBot) delivers messages; `policy`
 * decides whether this one wakes the agent; `bridge` serializes it per
 * conversation and delivers the answer; `host` maps a conversation to a DSH
 * session and drives one turn on it. Everything the agent can *do* to the outside
 * world is a tool registered from `tools`, and there are three of them.
 *
 * Two decisions worth knowing before reading the config:
 *
 *   - One DSH session per conversation, keyed by `qq:<backend>:<kind>:<id>` and
 *     persisted, so a restart continues the same conversation instead of meeting
 *     the person again.
 *   - The session is composed under an agent preset like any other, which is what
 *     lets a companion agent answer in its own voice with its own memory mounted.
 *
 * @module dsh-qq-bridge
 */

import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './bridge.js';
import { createHost } from './host.js';
import { createOneBotBackend } from './onebot.js';
import { GROUP_MODES } from './policy.js';
import { loadRoster, saveRoster } from './roster.js';
import { createSwitchboard } from './switchboard.js';
import { renderInbound } from './text.js';
import { registerTools } from './tools.js';

export const name = 'qq-bridge';

/**
 * Services are read through `ctx.get` rather than injected.
 *
 * Deliberately not `inject`: the bridge answers messages, and a missing optional
 * service (a profile without `sessionPersistence`, a headless profile without
 * presets) should degrade one feature rather than refuse to mount the plugin. The
 * one service it cannot work without — `agents` — is checked where it is used,
 * with a message that names the bundle that provides it.
 */
export const inject = [];

/**
 * Plugin configuration.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('Mount the bridge. Off keeps the settings without opening a connection.'),
  endpoint: z
    .string()
    .default('ws://127.0.0.1:3001')
    .description('The OneBot 11 forward WebSocket, e.g. ws://127.0.0.1:3001 (NapCat default).'),
  backend: z
    .string()
    .default('onebot')
    .description('Which transport to connect first: "onebot" today, or any key declared in `backends`. `/qq backend <id>` switches at runtime.'),
  backends: z
    .dict(z.object({
      endpoint: z.string().default(''),
      accessToken: z.string().default(''),
    }))
    .default({})
    .description('Extra transports to switch between, keyed by id. An id declared here can be reached with `/qq backend <id>`; `onebot` always exists using `endpoint`.'),
  sessionNamespace: z
    .string()
    .default('onebot')
    .description('Prefix of every conversation id. Deliberately not the active backend: changing it renames every conversation and forgets everyone.'),
  accessToken: z
    .string()
    .default('')
    .description('Sent as a Bearer token when the backend requires one.'),
  groupMode: z
    .union(GROUP_MODES)
    .default('mention')
    .description('Groups: "always" answers every message, "mention" only when @-ed, "off" never.'),
  allowedGroups: z
    .array(z.string())
    .default([])
    .description('Group ids to answer in. Empty means every group.'),
  preset: z
    .string()
    .default('')
    .description('Agent preset to compose each session from. Empty uses the profile default.'),
  provider: z
    .string()
    .default('')
    .description('Provider route for new sessions. Empty uses this profile\u2019s default model.'),
  model: z
    .string()
    .default('')
    .description('Model for new sessions. Empty uses this profile\u2019s default model.'),
  workspace: z
    .string()
    .default('')
    .description('Working directory recorded on new sessions. Empty uses the process cwd.'),
  language: z
    .union(['zh', 'en'])
    .default('zh')
    .description('Language of the envelope the model reads and of the tool descriptions.'),
  minimumGapMs: z
    .number()
    .default(1200)
    .description('Minimum spacing between sends to one conversation, in milliseconds.'),
  maxChars: z
    .number()
    .default(1200)
    .description('Soft limit per outbound message; longer replies are split at sentence ends.'),
  ignoreAutoReply: z
    .boolean()
    .default(true)
    .description('Drop QQ\u2019s canned away-message ("[自动回复]...") instead of waking the agent for it.'),
  dailyProactive: z
    .number()
    .default(0)
    .description('How many messages the agent may start per local day. 0 disables proactive sends.'),
  maxLiveAgents: z
    .number()
    .default(8)
    .description('Conversations kept warm in memory. The least recently used is disposed first.'),
  rosterPath: z
    .string()
    .default('')
    .description('Conversation list file. Empty uses $DSH_HOME/qq-bridge/conversations.json.'),
  ownerIds: z
    .array(z.string())
    .default([])
    .description('Account ids that are the owner. Anyone else who writes is a stranger. Empty keeps the old assumption that a private chat is the owner.'),
});

/**
 * Resolve the roster location without depending on dsh-home-paths.
 * @returns {string} absolute path to the conversation list.
 */
function defaultRosterPath() {
  const home = process.env.DSH_HOME?.trim();
  const root = home === undefined || home === '' ? join(homedir(), '.dsh') : home;
  return join(root, 'qq-bridge', 'conversations.json');
}

/**
 * The diagnostic sink.
 *
 * `process.emitWarning` and not a logger service: this plugin has to be able to
 * complain before the host tree is fully up (a malformed endpoint, a refused
 * connection), and a warning that only appears once logging is wired up is a
 * warning nobody reads.
 *
 * @param {string} message - what happened.
 * @param {unknown} [detail] - an error, when there is one.
 * @returns {void}
 */
function log(message, detail) {
  process.emitWarning(detail === undefined ? message : `${message}: ${detail instanceof Error ? detail.message : String(detail)}`);
}

/**
 * Every transport this configuration can reach, keyed by the id `/qq backend`
 * takes.
 *
 * `onebot` is always present — it is the endpoint this plugin has always spoken
 * to, and a configuration written before `backends` existed must keep working
 * unchanged. Anything declared in `backends` is a second (third, fourth) OneBot
 * socket, which is what "another transport for the same account" means in
 * practice: NapCat on this machine, LLBot on another, a different port after a
 * restart.
 *
 * The endpoint of a declared transport falls back to the top-level `endpoint` so
 * that declaring a transport to give it a *name* does not require repeating an
 * address that is already correct.
 *
 * @param {{endpoint: string, accessToken: string, backends: Record<string, {endpoint: string, accessToken: string}>}} config - validated configuration.
 * @returns {Map<string, () => import('./types.js').QqBackend>} id → constructor.
 */
export function backendFactories(config) {
  const factories = new Map();
  factories.set('onebot', () => createOneBotBackend({
    endpoint: config.endpoint,
    accessToken: config.accessToken,
    log,
  }));
  for (const [id, declared] of Object.entries(config.backends ?? {})) {
    if (id === 'onebot') continue;
    const endpoint = declared.endpoint.trim() === '' ? config.endpoint : declared.endpoint;
    const accessToken = declared.accessToken === '' ? config.accessToken : declared.accessToken;
    factories.set(id, () => createOneBotBackend({ endpoint, accessToken, log }));
  }
  return factories;
}

/**
 * Activate the plugin.
 *
 * @param {any} ctx - the plugin context.
 * @param {z.infer<typeof Config>} config - validated configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.enabled === false) {
    log('qq-bridge: disabled by configuration');
    return;
  }
  const language = config.language === 'en' ? 'en' : 'zh';

  /** @type {Map<string, import('./types.js').QqTarget>} */
  const targets = loadRoster(config.rosterPath.trim() === '' ? defaultRosterPath() : config.rosterPath.trim(), log);
  const rosterPath = config.rosterPath.trim() === '' ? defaultRosterPath() : config.rosterPath.trim();
  /** Keys in the order this process last touched them, for roster trimming. */
  const recency = [];
  /**
   * Remember a conversation so `qq_send` and a restart can find it again.
   *
   * The roster is not the session log: it holds a key, a kind, an id and a name.
   * Writing it on every message is cheap and it is the only thing that survives
   * `maxLiveAgents` eviction, which is what makes a proactive message possible at
   * all.
   *
   * @param {string} key - the conversation's session id.
   * @param {import('./types.js').QqTarget} target - where it is.
   */
  const touch = (key, target) => {
    targets.set(key, target);
    const at = recency.indexOf(key);
    if (at >= 0) recency.splice(at, 1);
    recency.unshift(key);
  };

  /** @type {any} */
  let bridge;

  // One switchboard per account, whatever transports reach it. `sessionNamespace`
  // and not the active backend's name ends up in every conversation id: renaming
  // the conversations because the operator moved to another transport would make
  // every person meet the agent again for the first time (see switchboard.js).
  const switchboard = createSwitchboard({
    id: config.sessionNamespace.trim(),
    initial: config.backend.trim(),
    factories: backendFactories(config),
    log,
  });
  const backend = switchboard;

  const host = createHost(ctx, {
    workspace: config.workspace.trim() === '' ? process.cwd() : config.workspace.trim(),
    preset: config.preset.trim(),
    provider: config.provider.trim(),
    model: config.model.trim(),
    maxLiveAgents: config.maxLiveAgents,
    ownerIds: config.ownerIds,
    log,
    // Per-agent scope, because these tools act for one conversation and must not
    // exist on every agent in the profile.
    onAgent: (agentCtx, agent) => {
      registerTools(agentCtx, {
        getBridge: () => bridge,
        backend,
        language,
        targets,
        agent,
        log,
      });
    },
  });

  /**
   * The seam the bridge calls: remember the conversation, say where the message
   * came from, then run a turn.
   *
   * The envelope is built here and not in `host` because it is a property of the
   * transport: a private chat and a group message both have a sender, and only the
   * transport knows whether the sender was named, whether the agent was @-ed, and
   * what the group is called.
   */
  const controller = {
    async handle(event, text, key) {
      touch(key, event.target);
      try {
        return await host.handle(event, renderInbound({ ...event, text }, { language }), key);
      } finally {
        saveRoster(rosterPath, targets, recency, log);
      }
    },
  };

  bridge = createBridge({
    backend,
    host: controller,
    settings: {
      groupMode: config.groupMode,
      allowedGroups: config.allowedGroups,
      minimumGapMs: config.minimumGapMs,
      dailyProactive: config.dailyProactive,
      maxChars: config.maxChars,
      ignoreAutoReply: config.ignoreAutoReply,
    },
    log,
  });

  ctx.effect(() => {
    // Starting is not awaited: a backend that is down must not hold up the harness
    // boot. The bridge reconnects on its own, and `qq_whoami` reports the state.
    void bridge.start().catch((error) => {
      log('qq-bridge: could not start', error);
    });
    return async () => {
      // Stop the transport first, then the agents: a message arriving during
      // teardown would otherwise be handed to a disposed agent.
      await bridge.stop();
      saveRoster(rosterPath, targets, recency, log);
      await host.close();
    };
  });

  // `/qq` is registered only when this profile actually carries the command
  // registry. A headless profile has no composer to type into, and a plugin that
  // refuses to mount because a UI service is missing would take the QQ channel
  // down with it.
  const commands = ctx.get('commands');
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      name: 'qq',
      description: 'Show the QQ bridge, or switch its transport: /qq backend <id>',
      input: { hint: '[status|backend [<id>]]' },
      handler: (invocation) => runQqCommand(switchboard, invocation, language),
    });
  }
}

/**
 * The `/qq` command.
 *
 * Switching is available as a human command and not as a tool on purpose: an
 * agent woken by strangers must not be able to change how its own account is
 * reachable, or a prompt injection becomes a way to strand the account on a
 * transport that does not work.
 *
 * @param {any} switchboard - the backend switchboard.
 * @param {{rawInput?: string}} invocation - the command invocation.
 * @param {'zh'|'en'} language - output language.
 * @returns {import('@deepseek-ai/dsh-commands').CommandResult|Promise<import('@deepseek-ai/dsh-commands').CommandResult>} the result.
 */
export function runQqCommand(switchboard, invocation, language) {
  const zh = language !== 'en';
  const raw = String(invocation.rawInput ?? '').trim();
  const [verb, ...rest] = raw === '' ? ['status'] : raw.split(/\s+/);
  const describe = () => {
    const status = switchboard.status();
    return [
      zh ? `传输：${status.backend || '（无）'}` : `backend: ${status.backend || '(none)'}`,
      zh ? `状态：${status.connected ? '已连接' : '未连接'}` : `state: ${status.connected ? 'connected' : 'disconnected'}`,
      zh ? `可选：${switchboard.list().join(', ')}` : `available: ${switchboard.list().join(', ')}`,
    ].join('\n');
  };

  if (verb === 'status') {
    return { kind: 'success', text: describe() };
  }
  if (verb !== 'backend') {
    return { kind: 'error', text: zh ? '用法：/qq [status|backend [<id>]]' : 'usage: /qq [status|backend [<id>]]' };
  }
  if (rest.length === 0) {
    return { kind: 'success', text: describe() };
  }
  // `handler` may return a promise; the registry awaits either. A switch connects
  // before it disconnects, so this can take a few seconds for a transport that is
  // slow to open — and that is the right way round, because the failure mode is
  // then "still on the old one", not "on neither".
  return switchboard.switchTo(rest[0]).then((result) => {
    if (result.ok !== true) {
      return { kind: 'error', text: zh ? `没有切换：${result.error}` : `not switched: ${result.error}` };
    }
    const after = switchboard.status();
    return {
      kind: 'success',
      text: result.changed === true
        ? (zh ? `已切到 ${after.backend}，${after.connected ? '连接正常' : '还没连上'}` : `switched to ${after.backend}, ${after.connected ? 'connected' : 'not connected yet'}`)
        : (zh ? `本来就在 ${after.backend} 上` : `already on ${after.backend}`),
    };
  });
}

export { createBridge } from './bridge.js';
export { createHost, replyOf } from './host.js';
export { createOneBotBackend } from './onebot.js';
export { admit, createDailyBudget, createDedupe, createRateLimiter, GROUP_MODES, sessionKey } from './policy.js';
export { loadRoster, saveRoster } from './roster.js';
export { createSwitchboard } from './switchboard.js';
export { cleanOutbound, flattenMessage, renderInbound, splitMessage, unescapeCq } from './text.js';
export { describeTarget, registerTools, resolveTarget } from './tools.js';
