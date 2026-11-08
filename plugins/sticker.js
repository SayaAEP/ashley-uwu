/**
 * Plugin: Sticker — convert images/videos/GIFs to WhatsApp stickers.
 *
 * Usage: send/reply to an image/video/GIF with !s or !sticker
 *
 * Media details (FFmpeg, queue, temp files) live in utils/media; this plugin
 * only handles WhatsApp-specific concerns.
 */

const config = require('../config');
const logger = require('../utils/logger');
const mediaToolkit = require('../utils/media');

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

/**
 * Find the image/video to convert: the message itself first, then the quoted
 * message. Throws only when the quoted message cannot be read at all.
 *
 * @returns {Promise<object|null>} MessageMedia or null
 */
async function getInputMedia(message) {
    if (message.hasMedia) {
        try {
            const media = await message.downloadMedia();
            if (media) return media;
        } catch (err) {
            logger.error(`[sticker] Could not download attached media: ${describeError(err)}`);
        }
    }

    if (!message.hasQuotedMsg) return null;

    logger.debug('[sticker] Fetching quoted message...');
    const quoted = await getQuotedMessageWithRetry(message);

    if (!quoted || !quoted.hasMedia) return null;

    logger.debug(`[sticker] Downloading media from quoted message (${quoted.type})...`);
    return quoted.downloadMedia();
}

module.exports = {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    description: 'Convert an image or video to a sticker',
    usage: `${config.prefix}sticker — send/reply to an image or video`,
    category: 'Media',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message) {
        let input;

        try {
            input = await getInputMedia(message);
        } catch (err) {
            logger.error(`[sticker] Error fetching quoted message: ${describeError(err)}`);
            await message.reply(
                'Failed to read replied message. Please send the image/video directly with the command in the caption.',
            );
            return;
        }

        if (!input) {
            await message.reply('Send an image or video with the command, or reply to one.');
            return;
        }

        try {
            const sticker = await mediaToolkit.toSticker(input);

            logger.debug(`[sticker] Sending media as sticker to ${message.from}...`);
            await client.sendMessage(message.from, sticker, {
                sendMediaAsSticker: true,
                stickerAuthor: stickerAuthor,
                stickerName: stickerName,
            });
            logger.success(`[sticker] Sticker sent successfully to ${message.from}`);
        } catch (err) {
            if (err.code === mediaToolkit.CODES.BUSY) {
                await message.reply('Media queue is busy right now. Please try again in a moment.');
                return;
            }

            if (err.code === mediaToolkit.CODES.UNSUPPORTED) {
                await message.reply('Only images and videos can be converted to stickers.');
                return;
            }

            if (err.code === mediaToolkit.CODES.FFMPEG_MISSING) {
                await message.reply(
                    'FFmpeg is not installed, so video stickers cannot be created. Please install FFmpeg.',
                );
                return;
            }

            logger.error('[sticker] Failed to create sticker:', describeError(err));
            throw err;
        }
    },
};
