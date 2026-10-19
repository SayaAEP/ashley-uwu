/**
 * Ashley UwU — Plugin System
 * Auto-loads all .js files from the plugins/ folder
 * Handles command parsing, permission checks, cooldowns,
 * and hot-reload (watches for file changes)
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

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
  }

  // ─── Plugin Loading ──────────────────────────────────

  /**
   * Load all plugins from the plugins/ directory, then start watching
   */
  loadPlugins() {
    // Create plugins directory if it doesn't exist
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      logger.warn('Created empty plugins/ directory');
    }

    const allFiles = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.js'));

    // Separate active plugins from unloaded ones (.unload.js)
    const activeFiles = allFiles.filter((f) => !f.endsWith('.unload.js'));
    const unloadedFiles = allFiles.filter((f) => f.endsWith('.unload.js'));

    // Load active plugins
    for (const file of activeFiles) {
      this.loadSinglePlugin(file);
    }

    // Log loaded plugins
    const pluginNames = [...this.plugins.keys()];
    if (pluginNames.length > 0) {
      logger.success(`Loaded plugins: ${pluginNames.join(', ')} (${pluginNames.length})`);
    } else {
      logger.warn('No plugins loaded');
    }

    // Log unloaded plugins
    if (unloadedFiles.length > 0) {
      const unloadedNames = unloadedFiles.map((f) => f.replace('.unload.js', ''));
      logger.warn(`Unloaded plugins: ${unloadedNames.join(', ')} (${unloadedNames.length})`);
    }

    // Start file watcher for hot-reload
    this.watchPlugins();
  }

  /**
   * Load a single plugin file by filename
   * @param {string} filename - e.g. 'sticker.js'
   * @returns {boolean} true if loaded successfully
   */
  loadSinglePlugin(filename) {
    const filePath = path.join(PLUGINS_DIR, filename);

    try {
      // Clear require cache so we get fresh code
      delete require.cache[require.resolve(filePath)];

      const plugin = require(filePath);

      // Validate plugin structure
      if (!plugin.name || !plugin.handler) {
        logger.warn(`Plugin "${filename}" is missing required fields (name, handler). Skipping.`);
        return false;
      }

      // Register by name
      this.plugins.set(plugin.name.toLowerCase(), plugin);

      // Register aliases
      if (plugin.aliases && Array.isArray(plugin.aliases)) {
        for (const alias of plugin.aliases) {
          this.aliases.set(alias.toLowerCase(), plugin);
        }
      }

      // Track file → plugin name mapping
      this.fileToPlugin.set(filename, plugin.name.toLowerCase());

      return true;
    } catch (err) {
      logger.error(`Failed to load plugin "${filename}":`, err.message);
      return false;
    }
  }

  /**
   * Unload a plugin by its source filename
   * @param {string} filename - e.g. 'sticker.js'
   * @returns {boolean} true if unloaded successfully
   */
  unloadPlugin(filename) {
    const pluginName = this.fileToPlugin.get(filename);
    if (!pluginName) return false;

    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;

    // Remove aliases
    if (plugin.aliases && Array.isArray(plugin.aliases)) {
      for (const alias of plugin.aliases) {
        this.aliases.delete(alias.toLowerCase());
      }
    }

    // Remove plugin
    this.plugins.delete(pluginName);

    // Remove file tracking
    this.fileToPlugin.delete(filename);

    // Clear require cache
    const filePath = path.join(PLUGINS_DIR, filename);
    try {
      delete require.cache[require.resolve(filePath)];
    } catch {
      // File might already be deleted, that's fine
    }

    return true;
  }

  // ─── Hot-Reload Watcher ──────────────────────────────

  /**
   * Watch the plugins/ directory for changes and auto-reload
   */
  watchPlugins() {
    if (!fs.existsSync(PLUGINS_DIR)) return;

    logger.info('Watching plugins/ for changes...');

    fs.watch(PLUGINS_DIR, (eventType, filename) => {
      // Only care about .js files
      if (!filename || !filename.endsWith('.js')) return;

      // Debounce — Windows fires duplicate events
      const existing = this._debounceTimers.get(filename);
      if (existing) clearTimeout(existing);

      this._debounceTimers.set(
        filename,
        setTimeout(() => {
          this._debounceTimers.delete(filename);
          this._handleFileChange(filename);
        }, 150)
      );
    });
  }

  /**
   * Handle a file change event (add, edit, delete, or rename)
   * @param {string} filename
   * @private
   */
  _handleFileChange(filename) {
    const filePath = path.join(PLUGINS_DIR, filename);
    const fileExists = fs.existsSync(filePath);
    const isUnloadFile = filename.endsWith('.unload.js');
    const wasLoaded = this.fileToPlugin.has(filename);

    // ── .unload.js file appeared → skip loading, just log ──
    if (fileExists && isUnloadFile) {
      const name = filename.replace('.unload.js', '');
      // Check if the active version was loaded, unload it
      const activeFile = filename.replace('.unload.js', '.js');
      if (this.fileToPlugin.has(activeFile)) {
        const oldName = this.fileToPlugin.get(activeFile);
        this.unloadPlugin(activeFile);
        logger.bot(`Disabled plugin: ${oldName}`);
      }
      return;
    }

    // ── .unload.js file removed (might be renamed back to .js) → handled by .js event ──
    if (!fileExists && isUnloadFile) {
      return;
    }

    // ── Active .js file ──
    if (fileExists && wasLoaded) {
      // File edited → reload
      const oldName = this.fileToPlugin.get(filename);
      this.unloadPlugin(filename);
      if (this.loadSinglePlugin(filename)) {
        logger.bot(`Reloaded plugin: ${oldName}`);
      }
    } else if (fileExists && !wasLoaded) {
      // New file added (or renamed from .unload.js back to .js)
      if (this.loadSinglePlugin(filename)) {
        logger.bot(`Loaded plugin: ${this.fileToPlugin.get(filename)}`);
      }
    } else if (!fileExists && wasLoaded) {
      // File deleted or renamed to .unload.js
      const oldName = this.fileToPlugin.get(filename);
      this.unloadPlugin(filename);
      logger.bot(`Removed plugin: ${oldName}`);
    }
  }

  // ─── Plugin Lookup ───────────────────────────────────

  /**
   * Get all loaded plugins
   * @returns {Map<string, object>}
   */
  getPlugins() {
    return this.plugins;
  }

  /**
   * Find a plugin by command name or alias
   * @param {string} name
   * @returns {object|null}
   */
  findPlugin(name) {
    const lower = name.toLowerCase();
    return this.plugins.get(lower) || this.aliases.get(lower) || null;
  }

  // ─── Cooldowns ───────────────────────────────────────

  /**
   * Check if a user is on cooldown for a command
   * @param {string} userId
   * @param {string} commandName
   * @returns {number} remaining cooldown in ms, or 0 if ready
   */
  checkCooldown(userId, commandName) {
    const key = `${userId}:${commandName}`;
    const lastUsed = this.cooldowns.get(key);

    if (!lastUsed) return 0;

    const elapsed = Date.now() - lastUsed;
    const remaining = config.cooldownMs - elapsed;

    return remaining > 0 ? remaining : 0;
  }

  /**
   * Set cooldown timestamp for a user + command
   * @param {string} userId
   * @param {string} commandName
   */
  setCooldown(userId, commandName) {
    const key = `${userId}:${commandName}`;
    this.cooldowns.set(key, Date.now());
  }

  // ─── Message Dispatcher ──────────────────────────────

  /**
   * Handle an incoming message — parse, check, and dispatch to plugin
   * @param {import('whatsapp-web.js').Client} client
   * @param {import('whatsapp-web.js').Message} message
   */
  async handleMessage(client, message) {
    const body = message.body?.trim();
    if (!body) return;

    // Check which prefix was used
    const prefixes = [config.prefix, config.second_prefix].filter(Boolean);
    const usedPrefix = prefixes.find((p) => body.startsWith(p));
    if (!usedPrefix) return;

    // Parse command and arguments
    const args = body.slice(usedPrefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();

    if (!commandName) return;

    // Find plugin
    const plugin = this.findPlugin(commandName);
    if (!plugin) return;

    // Check: owner only
    if (plugin.ownerOnly) {
      // In groups, use message.author; in private, use message.from
      const userId = message.author || message.from;
      if (userId !== config.ownerNumber) {
        await message.reply('This command is for the bot owner only.');
        return;
      }
    }

    // Check: group only
    if (plugin.groupOnly) {
      const chat = await message.getChat();
      if (!chat.isGroup) {
        await message.reply('This command can only be used in groups.');
        return;
      }
    }

    // Check: cooldown
    const senderId = message.author || message.from;
    const remaining = this.checkCooldown(senderId, plugin.name);
    if (remaining > 0) {
      const seconds = (remaining / 1000).toFixed(1);
      await message.reply(`Please wait ${seconds}s before using this command again.`);
      return;
    }

    // Execute plugin
    try {
      let displayId = senderId;
      let pushname = '';
      let groupTag = '';

      try {
        const contact = await message.getContact();
        displayId = contact.id?.user || senderId;
        if (contact.pushname) pushname = ` ~${contact.pushname}`;
      } catch {}

      try {
        const chat = await message.getChat();
        if (chat.isGroup) {
          groupTag = ` (${chat.name})`;
        }
      } catch {}

      logger.bot(`${displayId}${pushname}${groupTag} → ${config.prefix}${plugin.name} ${args.join(' ')}`.trim());
      await plugin.handler(client, message, args);
      this.setCooldown(senderId, plugin.name);
    } catch (err) {
      if (config.debug) {
        logger.error(`Plugin "${plugin.name}" error:`, err);
      } else {
        logger.error(`Plugin "${plugin.name}" error:`, err.message);
      }
      await message.reply('An error occurred while executing that command.');
    }
  }
}

module.exports = new PluginHandler();
