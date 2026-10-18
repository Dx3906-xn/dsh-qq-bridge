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

  const backend = createOneBotBackend({
    endpoint: config.endpoint,
    accessToken: config.accessToken,
    log,
  });

  const host = createHost(ctx, {
    workspace: config.workspace.trim() === '' ? process.cwd() : config.workspace.trim(),
    preset: config.preset.trim(),
    provider: config.provider.trim(),
    model: config.model.trim(),
    maxLiveAgents: config.maxLiveAgents,
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
}

export { createBridge } from './bridge.js';
export { createHost, replyOf } from './host.js';
export { createOneBotBackend } from './onebot.js';
export { admit, createDailyBudget, createDedupe, createRateLimiter, GROUP_MODES, sessionKey } from './policy.js';
export { loadRoster, saveRoster } from './roster.js';
export { cleanOutbound, flattenMessage, renderInbound, splitMessage, unescapeCq } from './text.js';
export { describeTarget, registerTools, resolveTarget } from './tools.js';
