/**
 * Plugin: Sticker — convert images/videos/GIFs to WhatsApp stickers.
 *
 * Usage: send/reply to an image/video/GIF with !s or !sticker
 */

const { MessageMedia } = require('whatsapp-web.js');
const config = require('../config');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════
//  CONFIGURATION — Edit values below to customize
// ═══════════════════════════════════════════════════════
let stickerAuthor = config.botName;
let stickerName = config.stickerName;
// ═══════════════════════════════════════════════════════

/**
 * Puppeteer sometimes throws a minified in-page object (e.g. "r: r") instead
 * of a real Error. In that case err.message is useless — pull whatever is
 * informative off the object so logs are debuggable.
 */
function describeError(err) {
    if (!err) return 'unknown error';
    if (err.message && err.message !== err.name) return err.message;
    try {
        return JSON.stringify(err, Object.getOwnPropertyNames(err));
    } catch {
        return String(err);
    }
}

/**
 * message.getQuotedMessage() occasionally fails on the first attempt because
 * WhatsApp Web's internal message store hasn't indexed the quoted message
 * yet (a timing race). Retry once after a short delay before giving up.
 */
async function getQuotedMessageWithRetry(message, attempts = 2, delayMs = 400) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await message.getQuotedMessage();
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastErr;
}

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
            logger.debug('[sticker] Fetching quoted message...');
            try {
                const quoted = await getQuotedMessageWithRetry(message);
                if (quoted && quoted.hasMedia) {
                    logger.debug(`[sticker] Downloading media from quoted message (${quoted.type})...`);
                    media = await quoted.downloadMedia();
                }
            } catch (quotedErr) {
                logger.error(`[sticker] Error fetching quoted message: ${describeError(quotedErr)}`);
                // Fallback: if getQuotedMessage fails due to WWebJS/Puppeteer bug,
                // tell user to send the image/video directly with caption.
                await message.reply('Failed to read replied message. Please send the image/video directly with the command in the caption.');
                return;
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