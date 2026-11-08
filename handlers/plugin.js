/**
 * Plugin System — auto-loads plugins/, handles commands, permissions,
 * cooldowns, and hot-reload.
 */

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const config = require("../config");

const PLUGINS_DIR = path.join(__dirname, "..", "plugins");
const COOLDOWN_SWEEP_MS = 60_000;

// ─── Pure helpers (unit tested) ─────────────────────────

/**
 * Parse a command body into its prefix, command name, and arguments.
 *
 * @param {string} body Raw message body
 * @param {string[]} prefixes Configured prefixes (longest wins)
 * @returns {{ usedPrefix: string, commandName: string, args: string[] }|null}
 */
function parseCommand(body, prefixes) {
  if (typeof body !== "string") return null;

  const text = body.trim();
  if (!text) return null;

  const list = (Array.isArray(prefixes) ? prefixes : [])
    .filter((prefix) => typeof prefix === "string" && prefix.length > 0)
    .sort((a, b) => b.length - a.length);

  const usedPrefix = list.find((prefix) => text.startsWith(prefix));
  if (!usedPrefix) return null;

  const args = text.slice(usedPrefix.length).trim().split(/\s+/);
  const commandName = (args.shift() || "").toLowerCase();

  if (!commandName) return null;

  return { usedPrefix, commandName, args };
}

/**
 * How long until a cooldown expires?
 *
 * @param {number|undefined} lastUsed Timestamp (ms) or undefined
 * @param {number} now Current timestamp (ms)
 * @param {number} cooldownMs Configured cooldown
 * @returns {number} Remaining ms, or 0 when ready
 */
function remainingCooldown(lastUsed, now, cooldownMs) {
  if (!lastUsed) return 0;

  const remaining = cooldownMs - (now - lastUsed);
  return remaining > 0 ? remaining : 0;
}

/**
 * Reduce a WhatsApp ID (or plain number) to its numeric user part.
 *
 * Accepts `62812…@c.us`, `62812…:12@c.us`, `+62 812…`, and `62812…@lid`.
 *
 * @param {string} value
 * @returns {string|null}
 */
function normalizeOwnerId(value) {
  if (typeof value !== "string") return null;

  let text = value.trim();
  if (!text) return null;

  const at = text.indexOf("@");
  if (at !== -1) text = text.slice(0, at);

  const colon = text.indexOf(":");
  if (colon !== -1) text = text.slice(0, colon);

  text = text.replace(/[^\d]/g, "");
  return text || null;
}

/**
 * Remove a plugin (and its plugin-local dependencies) from the require cache.
 *
 * Dependencies outside `plugins/` (config, utils) are intentionally kept —
 * reloading those mid-flight would create duplicate singletons.
 *
 * @param {string} modulePath
 * @param {Set<string>} [seen]
 */
function purgePluginCache(modulePath, seen = new Set()) {
  let resolved;
  try {
    resolved = require.resolve(modulePath);
  } catch {
    return;
  }

  if (seen.has(resolved)) return;
  seen.add(resolved);

  const cached = require.cache[resolved];
  if (cached) {
    for (const child of cached.children) {
      if (child.filename && child.filename.startsWith(PLUGINS_DIR + path.sep)) {
        purgePluginCache(child.filename, seen);
      }
    }
  }

  delete require.cache[resolved];
}

// ─── Plugin discovery (supports subfolders) ─────────────

const MAX_PLUGIN_DEPTH = 5;

/**
 * Normalize a watcher/loader filename to a POSIX-style path relative to
 * `plugins/` (e.g. `owner/reload.js`).
 *
 * @param {string} filename
 * @returns {string|null}
 */
function normalizePluginPath(filename) {
  if (!filename) return null;

  let name = String(filename);
  if (path.isAbsolute(name)) name = path.relative(PLUGINS_DIR, name);

  name = name.replace(/\\/g, "/");
  while (name.startsWith("./")) name = name.slice(2);
  name = name.replace(/\/+/g, "/");

  return name || null;
}

/**
 * Recursively collect `.js` files under `plugins/`, as POSIX relative paths.
 *
 * Dot-directories, `node_modules`, and symlinks are skipped so a stray link
 * cannot create an infinite walk.
 *
 * @param {string} [dir]
 * @param {string} [prefix]
 * @param {number} [depth]
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectPluginFiles(
  dir = PLUGINS_DIR,
  prefix = "",
  depth = 0,
  out = [],
) {
  if (depth > MAX_PLUGIN_DEPTH) return out;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      collectPluginFiles(path.join(dir, entry.name), relative, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(relative);
    }
  }

  return out;
}

// ─── Plugin Handler ─────────────────────────────────────

class PluginHandler {
  constructor() {
    /** @type {Map<string, object>} command name → plugin object */
    this.plugins = new Map();

    /** @type {Map<string, object>} alias → plugin object */
    this.aliases = new Map();

    /** @type {Map<string, string>} filename → plugin name (for hot-reload tracking) */
    this.fileToPlugin = new Map();

    /** @type {Map<string, number>} `userId:commandName` → last used timestamp */
    this.cooldowns = new Map();

    /** @type {Map<string, NodeJS.Timeout>} filename → debounce timer */
    this._debounceTimers = new Map();

    /** @type {fs.FSWatcher|null} */
    this._watcher = null;

    /** @type {NodeJS.Timeout|null} */
    this._cooldownSweep = null;
  }

  // ─── Plugin Loading ──────────────────────────────────

  /**
   * Load all plugins from plugins/ directory, then start watching.
   */
  loadPlugins() {
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      logger.warn("Created empty plugins/ directory");
    }

    // Sorted so collisions behave the same on every OS. Includes subfolders
    // such as `plugins/owner/`.
    const allFiles = collectPluginFiles();

    const activeFiles = allFiles.filter((file) => !file.endsWith(".unload.js"));
    const unloadedFiles = allFiles.filter((file) => file.endsWith(".unload.js"));

    for (const file of activeFiles) {
      this.loadSinglePlugin(file);
    }

    const pluginNames = [...this.plugins.keys()];
    if (pluginNames.length > 0) {
      logger.success(
        `Loaded plugins: ${pluginNames.join(", ")} (${pluginNames.length})`,
      );
    } else {
      logger.warn("No plugins loaded");
    }

    if (unloadedFiles.length > 0) {
      const unloadedNames = unloadedFiles.map((file) =>
        file.replace(/\.unload\.js$/, ""),
      );
      logger.warn(
        `Unloaded plugins: ${unloadedNames.join(", ")} (${unloadedNames.length})`,
      );
    }

    this.watchPlugins();
    this.startCooldownSweep();
  }

  /**
   * Reload every plugin from disk (used by the `reload` runtime command).
   *
   * @returns {{ loaded: number }}
   */
  reloadAll() {
    for (const file of [...this.fileToPlugin.keys()]) {
      this.unloadPlugin(file);
    }

    this.loadPlugins();
    return { loaded: this.plugins.size };
  }

  /**
   * Load a single plugin file (relative path, e.g. 'sticker.js' or
   * 'owner/reload.js').
   *
   * @param {string} filename
   * @returns {boolean} true when the plugin was registered
   */
  loadSinglePlugin(filename) {
    const pluginPath = normalizePluginPath(filename);
    if (!pluginPath) {
      logger.warn(`Plugin path "${filename}" is invalid. Skipping.`);
      return false;
    }

    const filePath = path.join(PLUGINS_DIR, ...pluginPath.split("/"));

    try {
      // Re-loading the same file must not leave the previous object's aliases
      // pointing at stale code.
      if (this.fileToPlugin.has(pluginPath)) {
        this.unloadPlugin(pluginPath);
      }

      purgePluginCache(filePath);

      const plugin = require(filePath);

      if (!plugin || typeof plugin !== "object") {
        logger.warn(`Plugin "${pluginPath}" does not export an object. Skipping.`);
        return false;
      }

      if (typeof plugin.name !== "string" || plugin.name.trim().length === 0) {
        logger.warn(`Plugin "${pluginPath}" is missing a valid "name". Skipping.`);
        return false;
      }

      if (typeof plugin.handler !== "function") {
        logger.warn(`Plugin "${pluginPath}" is missing a handler function. Skipping.`);
        return false;
      }

      const pluginName = plugin.name.trim().toLowerCase();
      const existing = this.plugins.get(pluginName);

      // A different file already owns this command name.
      if (existing && this.fileToPlugin.get(pluginPath) !== pluginName) {
        logger.warn(
          `Plugin "${pluginPath}" duplicates command "${pluginName}" (already loaded from another file). Skipping.`,
        );
        return false;
      }

      this.plugins.set(pluginName, plugin);

      if (Array.isArray(plugin.aliases)) {
        for (const rawAlias of plugin.aliases) {
          if (typeof rawAlias !== "string" || rawAlias.trim().length === 0) {
            continue;
          }

          const alias = rawAlias.trim().toLowerCase();
          if (alias === pluginName) continue;

          const aliasOwner = this.aliases.get(alias);
          if (aliasOwner && aliasOwner !== plugin) {
            logger.warn(
              `Plugin "${pluginPath}" alias "${alias}" is already used by "${aliasOwner.name}". Skipping alias.`,
            );
            continue;
          }

          this.aliases.set(alias, plugin);
        }
      }

      this.fileToPlugin.set(pluginPath, pluginName);
      return true;
    } catch (err) {
      logger.error(`Failed to load plugin "${pluginPath}":`, err.message);
      return false;
    }
  }

  /**
   * Unload a plugin by its relative source path.
   *
   * @param {string} filename
   * @returns {boolean} true if unloaded
   */
  unloadPlugin(filename) {
    const pluginPath = normalizePluginPath(filename);
    if (!pluginPath) return false;

    const pluginName = this.fileToPlugin.get(pluginPath);
    if (!pluginName) return false;

    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;

    if (Array.isArray(plugin.aliases)) {
      for (const rawAlias of plugin.aliases) {
        if (typeof rawAlias !== "string") continue;

        const alias = rawAlias.trim().toLowerCase();
        // Never steal an alias that another plugin has since claimed.
        if (this.aliases.get(alias) === plugin) {
          this.aliases.delete(alias);
        }
      }
    }

    this.plugins.delete(pluginName);
    this.fileToPlugin.delete(pluginPath);
    purgePluginCache(path.join(PLUGINS_DIR, ...pluginPath.split("/")));

    return true;
  }

  // ─── Hot-Reload Watcher ──────────────────────────────

  /**
   * Watch plugins/ directory for changes and auto-reload.
   */
  watchPlugins() {
    if (!fs.existsSync(PLUGINS_DIR) || this._watcher) return;

    logger.info("Watching plugins/ for changes (recursive)...");

    try {
      this._watcher = fs.watch(
        PLUGINS_DIR,
        { recursive: true },
        (eventType, filename) => {
          try {
            if (!filename) return;

            const name = normalizePluginPath(filename);
            if (!name || !name.endsWith(".js")) return;

            // Debounce — Windows fires duplicate events.
            const existing = this._debounceTimers.get(name);
            if (existing) clearTimeout(existing);

            this._debounceTimers.set(
              name,
              setTimeout(() => {
                this._debounceTimers.delete(name);
                this._handleFileChange(name);
              }, 150),
            );
          } catch (err) {
            logger.error("Plugin watcher callback error:", err.message);
          }
        },
      );

      this._watcher.on("error", (err) => {
        logger.error("Plugin watcher error:", err.message);
      });

      // Do not keep a test process / CLI alive only because of the watcher.
      if (typeof this._watcher.unref === "function") {
        this._watcher.unref();
      }
    } catch (err) {
      logger.error(
        "Could not watch plugins/ recursively; hot-reload is disabled (use the reload command instead):",
        err.message,
      );
    }
  }

  /**
   * Handle a file change event (add, edit, delete, or rename).
   *
   * @param {string} filename Relative path inside plugins/
   * @private
   */
  _handleFileChange(filename) {
    const pluginPath = normalizePluginPath(filename);
    if (!pluginPath) return;

    const filePath = path.join(PLUGINS_DIR, ...pluginPath.split("/"));
    const fileExists = fs.existsSync(filePath);
    const isUnloadFile = pluginPath.endsWith(".unload.js");
    const wasLoaded = this.fileToPlugin.has(pluginPath);

    // ── .unload.js file appeared → disable the active version ──
    if (fileExists && isUnloadFile) {
      const activeFile = pluginPath.replace(/\.unload\.js$/, ".js");
      if (this.fileToPlugin.has(activeFile)) {
        const oldName = this.fileToPlugin.get(activeFile);
        this.unloadPlugin(activeFile);
        logger.bot(`Disabled plugin: ${oldName}`);
      }
      return;
    }

    // ── .unload.js removed (rename back handled by the .js event) ──
    if (!fileExists && isUnloadFile) {
      return;
    }

    // ── Active .js file ──
    if (fileExists && wasLoaded) {
      const oldName = this.fileToPlugin.get(pluginPath);
      this.unloadPlugin(pluginPath);
      if (this.loadSinglePlugin(pluginPath)) {
        logger.bot(`Reloaded plugin: ${oldName}`);
      }
    } else if (fileExists && !wasLoaded) {
      if (this.loadSinglePlugin(pluginPath)) {
        logger.bot(`Loaded plugin: ${this.fileToPlugin.get(pluginPath)}`);
      }
    } else if (!fileExists && wasLoaded) {
      const oldName = this.fileToPlugin.get(pluginPath);
      this.unloadPlugin(pluginPath);
      logger.bot(`Removed plugin: ${oldName}`);
    }
  }

  // ─── Plugin Lookup ───────────────────────────────────

  /**
   * @returns {Map<string, object>} All loaded plugins
   */
  getPlugins() {
    return this.plugins;
  }

  /**
   * Find a plugin by command name or alias.
   *
   * @param {string} name
   * @returns {object|null}
   */
  findPlugin(name) {
    if (typeof name !== "string") return null;

    const lower = name.toLowerCase();
    return this.plugins.get(lower) || this.aliases.get(lower) || null;
  }

  // ─── Cooldowns ───────────────────────────────────────

  /**
   * @param {string} userId
   * @param {string} commandName
   * @returns {number} remaining cooldown in ms, or 0 if ready
   */
  checkCooldown(userId, commandName) {
    const lastUsed = this.cooldowns.get(`${userId}:${commandName}`);
    return remainingCooldown(lastUsed, Date.now(), config.cooldownMs);
  }

  /**
   * Reserve the cooldown slot for a user + command.
   *
   * @param {string} userId
   * @param {string} commandName
   */
  setCooldown(userId, commandName) {
    this.cooldowns.set(`${userId}:${commandName}`, Date.now());
  }

  /**
   * Drop expired cooldown entries so the map cannot grow forever.
   */
  sweepCooldowns() {
    const now = Date.now();
    const ttl = Math.max(0, Number(config.cooldownMs) || 0);

    for (const [key, lastUsed] of this.cooldowns) {
      if (now - lastUsed >= ttl) this.cooldowns.delete(key);
    }
  }

  startCooldownSweep() {
    if (this._cooldownSweep) return;

    this._cooldownSweep = setInterval(
      () => this.sweepCooldowns(),
      COOLDOWN_SWEEP_MS,
    );
    if (this._cooldownSweep.unref) this._cooldownSweep.unref();
  }

  // ─── Permissions / Replies ───────────────────────────

  /**
   * @param {import("whatsapp-web.js").Message} message
   * @returns {Promise<boolean>}
   */
  async isOwner(message) {
    const expected = normalizeOwnerId(config.ownerNumber);
    if (!expected) {
      logger.warn("ownerNumber is not configured; owner-only commands are denied.");
      return false;
    }

    for (const candidate of [message.author, message.from]) {
      if (normalizeOwnerId(candidate) === expected) return true;
    }

    // @lid JIDs may not carry the phone number, so ask WhatsApp for the contact.
    try {
      const contact = await message.getContact();
      if (contact) {
        if (normalizeOwnerId(contact.number) === expected) return true;
        if (normalizeOwnerId(contact.id?._serialized) === expected) return true;
      }
    } catch {
      // Contact lookup is best-effort.
    }

    return false;
  }

  /**
   * Reply without letting a revoked/blocked chat crash the handler.
   *
   * @param {import("whatsapp-web.js").Message} message
   * @param {string} text
   */
  async safeReply(message, text) {
    try {
      await message.reply(text);
    } catch (err) {
      logger.debug(`[reply] could not reply: ${err.message}`);
    }
  }

  // ─── Message Dispatcher ──────────────────────────────

  /**
   * Handle an incoming message — parse, check, and dispatch to plugin.
   *
   * @param {import('whatsapp-web.js').Client} client
   * @param {import('whatsapp-web.js').Message} message
   */
  async handleMessage(client, message) {
    if (!message) return;
    if (message.isStatus || message.broadcast) return;

    const command = parseCommand(message.body, [
      config.prefix,
      config.second_prefix,
    ]);
    if (!command) return;

    const plugin = this.findPlugin(command.commandName);
    if (!plugin) return;

    if (plugin.ownerOnly) {
      const allowed = await this.isOwner(message);
      if (!allowed) {
        await this.safeReply(message, "This command is for the bot owner only.");
        return;
      }
    }

    if (plugin.groupOnly) {
      let chat = null;
      try {
        chat = await message.getChat();
      } catch (err) {
        logger.debug(`[groupOnly] getChat failed: ${err.message}`);
      }

      if (!chat || !chat.isGroup) {
        await this.safeReply(
          message,
          "This command can only be used in groups.",
        );
        return;
      }
    }

    const senderId = message.author || message.from || "unknown";
    const remaining = this.checkCooldown(senderId, plugin.name);
    if (remaining > 0) {
      const seconds = (remaining / 1000).toFixed(1);
      await this.safeReply(
        message,
        `Please wait ${seconds}s before using this command again.`,
      );
      return;
    }

    // Reserve the slot *before* running so simultaneous messages cannot both
    // pass the cooldown check.
    this.setCooldown(senderId, plugin.name);

    try {
      let displayId = senderId;
      let pushname = "";
      let groupTag = "";

      try {
        const contact = await message.getContact();
        displayId = contact.id?.user || senderId;
        if (contact.pushname) pushname = ` ~${contact.pushname}`;
      } catch {
        // Logging is best-effort.
      }

      try {
        const chat = await message.getChat();
        if (chat.isGroup) groupTag = ` (${chat.name})`;
      } catch {
        // Logging is best-effort.
      }

      logger.bot(
        `${displayId}${pushname}${groupTag} → ${config.prefix}${plugin.name} ${command.args.join(" ")}`.trim(),
      );

      await plugin.handler(client, message, command.args);
    } catch (err) {
      if (config.debug) {
        logger.error(`Plugin "${plugin.name}" error:`, err);
      } else {
        logger.error(`Plugin "${plugin.name}" error:`, err.message);
      }

      await this.safeReply(
        message,
        "An error occurred while executing that command.",
      );
    }
  }
}

const pluginHandler = new PluginHandler();

module.exports = pluginHandler;
module.exports.PluginHandler = PluginHandler;
module.exports.parseCommand = parseCommand;
module.exports.remainingCooldown = remainingCooldown;
module.exports.normalizeOwnerId = normalizeOwnerId;
module.exports.PLUGINS_DIR = PLUGINS_DIR;
module.exports.collectPluginFiles = collectPluginFiles;
module.exports.normalizePluginPath = normalizePluginPath;
