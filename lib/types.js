/**
 * What a OneBot 11 message is, once the protocol noise is gone.
 *
 * The bridge never hands raw OneBot JSON to the agent, and it never composes raw
 * OneBot JSON to send. Everything crosses this boundary as a `QqEvent` /
 * `QqTarget` / `QqContent` so that a second backend — GUI automation, or whatever
 * replaces OneBot — is a new file rather than a new branch in eight places.
 *
 * @module dsh-qq-bridge/types
 */

/**
 * Where a message goes, or came from.
 *
 * `id` is the platform's own id: a friend's user id for a private chat, a group
 * number for a group. It is a string here even though OneBot sends numbers,
 * because it is concatenated into a session id and compared across a restart,
 * and `10001` and `"10001"` must not be two different conversations.
 *
 * @typedef {object} QqTarget
 * @property {'private'|'group'} kind - which kind of conversation.
 * @property {string} id - platform id of the friend or group.
 * @property {string} [name] - display name, when the backend knows it.
 */

/**
 * Who said it.
 *
 * `id` is the sender's own id, which is what memory has to be filed under: a
 * group is one conversation but many people, and a companion agent that confuses
 * two people in the same room is worse than one that forgets them both.
 *
 * @typedef {object} QqSender
 * @property {string} id - platform id of the person.
 * @property {string} name - display name, already unescaped.
 * @property {string} [card] - group card / nickname in that group, when present.
 */

/**
 * One inbound message or notice.
 *
 * @typedef {object} QqEvent
 * @property {'message'} kind - the only kind this bridge acts on today.
 * @property {QqTarget} target - where it happened.
 * @property {QqSender} sender - who said it.
 * @property {string} text - the message text with segments flattened; no CQ codes.
 * @property {boolean} mentionsSelf - whether this account was @-ed.
 * @property {string} messageId - platform message id, for quoting and dedupe.
 * @property {number} at - epoch milliseconds.
 * @property {unknown} raw - the original payload, kept for logging only.
 */

/**
 * What to send.
 *
 * Text only, on purpose: images and files widen the model's blast radius (an
 * agent that can send a file can exfiltrate one) and every backend supports text.
 *
 * @typedef {object} QqContent
 * @property {string} text - the message body.
 */

/**
 * What a backend can actually do.
 *
 * This is the load-bearing part of the interface. A GUI-automation backend has no
 * group list, no recall, and no way to send a file; a bridge that registers tools
 * regardless would let the model discover the gap by failing at it, in front of a
 * real person. Tools are registered from this set instead.
 *
 * @typedef {'private'|'group'|'image'|'file'|'recall'|'list'} QqCapability
 */

/**
 * The contract every backend implements.
 *
 * @typedef {object} QqBackend
 * @property {string} id - stable backend name, part of every session key.
 * @property {ReadonlySet<QqCapability>} capabilities - what this backend supports.
 * @property {() => Promise<void>} connect - open the connection; rejects on failure.
 * @property {() => Promise<void>} disconnect - close it; never throws.
 * @property {(target: QqTarget, content: QqContent) => Promise<{ok: boolean, id?: string, error?: string}>} send - deliver one message.
 * @property {(handler: (event: QqEvent) => void) => () => void} onEvent - subscribe; returns an unsubscribe function.
 * @property {() => {connected: boolean, since: number}} status - for diagnostics.
 */

export {};
