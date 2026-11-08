/**
 * Plugin: Reconnect (owner only)
 *
 * Rebuilds the WhatsApp client using the existing session. This is the same
 * path the automatic reconnect uses — the process stays alive.
 */

const config = require('../../config');
const logger = require('../../utils/logger');
const botControl = require('../../utils/botControl');

module.exports = {
  name: 'reconnect',
  aliases: ['rc'],
  description: 'Reconnect the WhatsApp client without restarting the process',
  usage: `${config.prefix}reconnect`,
  category: 'System',
  ownerOnly: true,
  groupOnly: false,

  async handler(client, message) {
    if (!botControl.isAvailable('reconnect')) {
      await message.reply('Reconnect is not available yet. Try again in a moment.');
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

    // Reply before the current client is destroyed.
    await message.reply('Reconnecting to WhatsApp...');

    const result = await botControl.reconnect('command: reconnect');
    if (!result.ok) {
      logger.warn(`Reconnect command failed: ${result.error}`);
    }
  },
};
