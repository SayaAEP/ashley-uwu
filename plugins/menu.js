/**
 * Plugin: Menu / Help
 * Displays list of installed plugins dynamically grouped by category,
 * or detailed usage of a specific command.
 *
 * Sends the menu directly in reply to the person who requested it.
 *
 * Usage:
 *   - .menu or .help — display all available commands
 *   - .menu <command> — display detailed usage for a command
 */

const config = require('../config');
const pluginHandler = require('../handlers/plugin');

// ═══════════════════════════════════════════════════════
//  CONFIGURATION — Edit values below to customize
// ═══════════════════════════════════════════════════════
let headerTitle = config.botName || 'Ashley UwU';
// ═══════════════════════════════════════════════════════

module.exports = {
  name: 'menu',
  aliases: ['help', 'm', 'h', 'plugins'],
  description: 'Display available bot commands and plugin information',
  usage: `${config.prefix}menu [command]`,
  category: 'General',
  ownerOnly: false,
  groupOnly: false,

  async handler(client, message, args) {
    // Get info of the person requesting the menu
    let requesterName = 'User';
    try {
      const contact = await message.getContact();
      requesterName = contact.pushname || contact.name || contact.id?.user || 'User';
    } catch {}

    const allPluginsMap = pluginHandler.getPlugins();

    // ── Single Command Help Request ───────────────────────
    if (args.length > 0) {
      const targetQuery = args[0].toLowerCase().replace(/^[.!]/, '');
      const plugin = pluginHandler.findPlugin(targetQuery);

      if (!plugin) {
        await message.reply(`❌ Command "*${targetQuery}*" not found. Type *${config.prefix}menu* to view all commands.`);
        return;
      }

      const aliasesStr = plugin.aliases && plugin.aliases.length > 0
        ? plugin.aliases.map((a) => `${config.prefix}${a}`).join(', ')
        : 'None';

      const detailText = [
        `╭──「 *COMMAND DETAILS* 」`,
        `│ *Name:* ${config.prefix}${plugin.name}`,
        `│ *Aliases:* ${aliasesStr}`,
        `│ *Category:* ${plugin.category || 'General'}`,
        `│ *Description:* ${plugin.description || 'No description available.'}`,
        `│ *Usage:* ${plugin.usage || `${config.prefix}${plugin.name}`}`,
        `│ *Owner Only:* ${plugin.ownerOnly ? 'Yes' : 'No'}`,
        `│ *Group Only:* ${plugin.groupOnly ? 'Yes' : 'No'}`,
        `╰─────────────────────`,
        ``,
        `Hello *@${requesterName}*, hope this helps! ✨`
      ].join('\n');

      await message.reply(detailText);
      return;
    }

    // ── Full Menu List ─────────────────────────────────────
    // Deduplicate plugins (filter out duplicate aliases pointing to same plugin object)
    const uniquePlugins = [];
    const seenNames = new Set();

    for (const [_, plugin] of allPluginsMap.entries()) {
      if (!seenNames.has(plugin.name)) {
        seenNames.add(plugin.name);
        uniquePlugins.push(plugin);
      }
    }

    // Group by category
    const categories = {};
    for (const plugin of uniquePlugins) {
      const cat = plugin.category || 'General';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(plugin);
    }

    const menuLines = [
      `Hi, *${requesterName}*! 👋`,
      `Here is the list of installed plugins for *${headerTitle}*:`,
      ``,
      `╭──「 *${headerTitle}* 」`,
      `│ *Bot Name:* ${config.botName}`,
      `│ *Prefix:* ${config.prefix} / ${config.second_prefix}`,
      `│ *Total Plugins:* ${uniquePlugins.length}`,
      `╰─────────────────────`,
      ``
    ];

    // Build category blocks
    for (const [category, plugins] of Object.entries(categories)) {
      menuLines.push(`╭──「 *${category.toUpperCase()}* 」`);
      for (const p of plugins) {
        const aliasText = p.aliases && p.aliases.length > 0
          ? ` _(${p.aliases.map((a) => config.prefix + a).join(', ')})_`
          : '';
        menuLines.push(`│ • *${config.prefix}${p.name}*${aliasText}`);
      }
      menuLines.push(`╰─────────────────────`);
      menuLines.push(``);
    }

    menuLines.push(`💡 *Tip:* Type *${config.prefix}menu <command>* for detailed command usage.`);

    // Send menu directly as a reply to the person requesting it
    await message.reply(menuLines.join('\n'));
  },
};
