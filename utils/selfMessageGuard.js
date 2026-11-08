/**
 * Self Message Guard — stops the bot from processing messages it sent itself.
 *
 * Why this exists: whatsapp-web.js emits `message_create` for outgoing messages
 * too, so a plugin that sends text starting with the command prefix (for
 * example `.echo .menu`) would otherwise trigger another command execution.
 *
 * We do NOT ignore every `message.fromMe` message: commands sent from the
 * owner's own phone (self-chat) must still work. Instead we only ignore
 * messages the bot itself produced, detected in two layers:
 *
 *   1. The message ID returned by `client.sendMessage()`.
 *   2. A short-lived fingerprint (`chatId + text`) recorded *before* sending,
 *      covering the race where the `message_create` event arrives before
 *      `sendMessage()` resolves.
 */

const SENT_ID_TTL_MS = 60_000;
const SENT_TEXT_TTL_MS = 5_000;

/** @type {Map<string, number>} message id → expiry timestamp */
const sentIds = new Map();
/** @type {Map<string, number>} `chatId\0text` → expiry timestamp */
const sentTexts = new Map();
const wrappedClients = new WeakSet();

function prune(map, now) {
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) map.delete(key);
  }
}

function makeTextKey(chatId, text) {
  return `${chatId}\u0000${text}`;
}

/**
 * Remember a text we are about to send.
 *
 * @param {string} chatId
 * @param {*} content
 */
function rememberText(chatId, content) {
  if (typeof content !== "string" || !chatId) return;
  const text = content.trim();
  if (!text) return;

  sentTexts.set(makeTextKey(chatId, text), Date.now() + SENT_TEXT_TTL_MS);
}

/**
 * Remember the message returned by `client.sendMessage()`.
 *
 * @param {import("whatsapp-web.js").Message} message
 */
function rememberMessage(message) {
  const serialized = message?.id?._serialized;
  if (!serialized) return;

  sentIds.set(serialized, Date.now() + SENT_ID_TTL_MS);
}

/**
 * Wrap `client.sendMessage` once so every outgoing message is tracked.
 *
 * @param {import("whatsapp-web.js").Client} client
 * @returns {import("whatsapp-web.js").Client}
 */
function install(client) {
  if (!client || wrappedClients.has(client)) return client;

  const original = client.sendMessage.bind(client);

  client.sendMessage = async (...args) => {
    const [chatId, content] = args;
    rememberText(chatId, content);

    const sent = await original(...args);
    rememberMessage(sent);
    return sent;
  };

  wrappedClients.add(client);
  return client;
}

/**
 * Should this message be ignored by the command dispatcher?
 *
 * @param {import("whatsapp-web.js").Message} message
 * @returns {boolean}
 */
function shouldIgnore(message) {
  if (!message) return true;
  if (message.isStatus || message.broadcast) return true;

  const remote = message.id?.remote || message.from || "";
  if (
    remote === "status@broadcast" ||
    remote.endsWith("@broadcast") ||
    remote.endsWith("@newsletter")
  ) {
    return true;
  }

  const now = Date.now();
  prune(sentIds, now);

  const serialized = message.id?._serialized;
  if (serialized && sentIds.has(serialized)) return true;

  if (message.fromMe && typeof message.body === "string") {
    const body = message.body.trim();
    if (body) {
      prune(sentTexts, now);
      const chats = new Set([message.from, message.to].filter(Boolean));
      for (const chat of chats) {
        if (sentTexts.has(makeTextKey(chat, body))) return true;
      }
    }
  }

  return false;
}

/** Test helper — clears all tracked state. */
function reset() {
  sentIds.clear();
  sentTexts.clear();
}

module.exports = { install, shouldIgnore, rememberText, rememberMessage, reset };
