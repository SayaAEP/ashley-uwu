/**
 * Bot Control — small registry that lets plugins request runtime actions
 * without requiring `main.js` directly.
 *
 * Why: main.js starts the WhatsApp client as soon as it is required, so a
 * plugin must never `require("../main")`. Instead main registers callbacks here
 * and plugins call the functions below.
 *
 * Actions:
 *   - reloadPlugins(): re-scan plugins/ and load everything again
 *   - reconnect(reason): rebuild the WhatsApp client (same path as auto-reconnect)
 *   - restart(reason): reload plugins + reconnect (soft restart, process stays)
 *   - status(): { available, shuttingDown, reconnecting }
 */

const ACTIONS = ["reloadPlugins", "reconnect", "restart", "status"];

/** @type {Record<string, Function|null>} */
const hooks = Object.fromEntries(ACTIONS.map((action) => [action, null]));

function unavailable(action) {
  const err = new Error(
    `Bot control "${action}" is not available yet (the bot may still be starting).`,
  );
  err.code = "BOT_CONTROL_UNAVAILABLE";
  return err;
}

/**
 * Register runtime callbacks. Only functions are accepted; unknown keys are
 * ignored so typos cannot silently replace a hook with a non-function.
 *
 * @param {Partial<Record<"reloadPlugins"|"reconnect"|"restart"|"status", Function>>} handlers
 */
function register(handlers = {}) {
  for (const action of ACTIONS) {
    if (typeof handlers[action] === "function") {
      hooks[action] = handlers[action];
    }
  }
}

/**
 * @param {"reloadPlugins"|"reconnect"|"restart"|"status"} action
 * @returns {boolean}
 */
function isAvailable(action) {
  return typeof hooks[action] === "function";
}

/**
 * @returns {{ available: boolean, shuttingDown: boolean, reconnecting: boolean }}
 */
function status() {
  if (typeof hooks.status !== "function") {
    return { available: false, shuttingDown: false, reconnecting: false };
  }

  return { available: true, ...hooks.status() };
}

/**
 * Reload every plugin from disk.
 *
 * @returns {Promise<{ loaded: number }>}
 */
async function reloadPlugins() {
  if (typeof hooks.reloadPlugins !== "function") {
    throw unavailable("reloadPlugins");
  }
  return hooks.reloadPlugins();
}

/**
 * Rebuild the WhatsApp client using the existing session.
 *
 * @param {string} [reason]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function reconnect(reason = "command") {
  if (typeof hooks.reconnect !== "function") {
    throw unavailable("reconnect");
  }
  return hooks.reconnect(reason);
}

/**
 * Soft restart: reload plugins, then rebuild the client.
 *
 * @param {string} [reason]
 * @returns {Promise<{ ok: boolean, error?: string, loaded?: number }>}
 */
async function restart(reason = "command") {
  if (typeof hooks.restart !== "function") {
    throw unavailable("restart");
  }
  return hooks.restart(reason);
}

/** Test helper — remove all registered hooks. */
function _reset() {
  for (const action of ACTIONS) hooks[action] = null;
}

module.exports = {
  register,
  isAvailable,
  status,
  reloadPlugins,
  reconnect,
  restart,
  _reset,
};
