/**
 * Plugin: Restart (owner only)
 *
 * Soft restart: reload every plugin, then rebuild the WhatsApp client.
 * The process itself stays alive; use `exit` in the terminal for a full stop.
 */

const config = require('../../config');
const logger = require('../../utils/logger');
const botControl = require('../../utils/botControl');

module.exports = {
  name: 'restart',
  aliases: ['rs'],
  description: 'Reload plugins and reconnect the WhatsApp client',
  usage: `${config.prefix}restart`,
  category: 'System',
  ownerOnly: true,
  groupOnly: false,

  async handler(client, message) {
    if (!botControl.isAvailable('restart')) {
      await message.reply('Restart is not available yet. Try again in a moment.');
      return;
    }

    const status = botControl.status();
    if (status.shuttingDown) {
      await message.reply('The bot is shutting down.');
      return;
    }

    if (status.reconnecting) {
      await message.reply('A reconnect is already in progress.');
      return;
    }

    // Reply before plugins/client are replaced.
    await message.reply('Restarting (reload plugins + reconnect)...');

    const result = await botControl.restart('command: restart');
    if (!result.ok) {
      logger.warn(`Restart command failed: ${result.error}`);
    }
  },
};
