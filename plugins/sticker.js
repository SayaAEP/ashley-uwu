/**
 * Plugin: Sticker
 * Convert images/videos/GIFs to WhatsApp stickers
 *
 * Usage:
 *   - Send an image/video/GIF with caption: !s or !sticker
 *   - Reply to an image/video/GIF with: !s or !sticker
 */

const { MessageMedia } = require('whatsapp-web.js');
const config = require('../config');

// ═══════════════════════════════════════════════════════
//  CONFIGURATION — Edit values below to customize
// ═══════════════════════════════════════════════════════
let stickerAuthor = config.botName;
let stickerName = 'Cute Sticker';
// ═══════════════════════════════════════════════════════

module.exports = {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    description: 'Convert an image or video to a sticker',
    usage: `${config.prefix}sticker — send/reply to an image or video`,
    category: 'Media',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message, args) {
        let media = null;

        // Try to get media from the message itself
        if (message.hasMedia) {
            media = await message.downloadMedia();
        }

        // Otherwise try the quoted/replied message
        if (!media && message.hasQuotedMsg) {
            const quoted = await message.getQuotedMessage();
            if (quoted.hasMedia) {
                media = await quoted.downloadMedia();
            }
        }

        if (!media) {
            await message.reply(
                'Send an image or video with the command, or reply to one.'
            );
            return;
        }

        const isImage = media.mimetype && media.mimetype.startsWith('image/');
        const isVideo = media.mimetype && media.mimetype.startsWith('video/');

        const logger = require('../utils/logger');
        if (isImage) {
            logger.debug(`[sticker] Processing static image sticker (${media.mimetype})`);
        } else if (isVideo) {
            const ffmpegBin = config.ffmpegPath || 'ffmpeg';
            logger.debug(`[sticker] Processing video sticker via FFmpeg (${ffmpegBin})`);
        }

        if (!isImage && !isVideo) {
            await message.reply('Only images and videos can be converted to stickers.');
            return;
        }

        try {
            logger.debug(`[sticker] Sending media as sticker to ${message.from}...`);
            await client.sendMessage(message.from, media, {
                sendMediaAsSticker: true,
                stickerAuthor: stickerAuthor,
                stickerName: stickerName,
            });
            logger.success(`[sticker] Sticker sent successfully to ${message.from}`);
        } catch (e) {
            logger.error(`[sticker] Failed to send sticker:`, e);
            throw e;
        }
    },
};