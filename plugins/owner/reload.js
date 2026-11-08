/**
 * Plugin: Reload (owner only)
 *
 * Re-scans `plugins/` and reloads every plugin without restarting the bot.
 */

const config = require('../../config');
const botControl = require('../../utils/botControl');

module.exports = {
  name: 'reload',
  aliases: ['rl'],
  description: 'Reload all plugins without restarting the process',
  usage: `${config.prefix}reload`,
  category: 'System',
  ownerOnly: true,
  groupOnly: false,

  async handler(client, message) {
    if (!botControl.isAvailable('reloadPlugins')) {
      await message.reply('Reload is not available yet. Try again in a moment.');
      return;
    }

    try {
      const result = await botControl.reloadPlugins();
      await message.reply(`Reloaded ${result.loaded} plugin(s).`);
    } catch (err) {
      await message.reply(`Reload failed: ${err.message}`);
    }
  },
};
