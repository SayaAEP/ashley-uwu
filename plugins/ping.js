/**
 * Plugin: Ping
 * Check if the bot is alive and measure response latency
 */

const config = require('../config');

module.exports = {
  name: 'ping',
  aliases: ['p'],
  description: 'Check if the bot is alive and measure latency',
  usage: `${config.prefix}ping`,
  category: 'General',
  ownerOnly: false,
  groupOnly: false,

  async handler(client, message) {
    const start = Date.now();
    await message.reply('Pong!');
    const latency = Date.now() - start;

    // Keep the original two-message output: the second message carries the
    // measured round-trip time.
    await client.sendMessage(message.from, `Response time: ${latency}ms`);
  },
};
