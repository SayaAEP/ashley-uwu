/**
 * Plugin: To Image
 * Convert a sticker back to a regular image or animated GIF
 *
 * Usage:
 *   - Reply to a sticker with: !toimg
 *
 * Media details (sharp, FFmpeg, temp files) live in utils/media.
 */

const config = require('../config');
const logger = require('../utils/logger');
const mediaToolkit = require('../utils/media');

/**
 * Puppeteer sometimes throws a minified in-page object (e.g. "r: r") instead
 * of a real Error when an evaluate() call fails inside WhatsApp Web's own
 * code. In that case err.message is useless — pull whatever is actually
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
 * yet (a timing race, not a real failure). Retry once after a short delay
 * before giving up.
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
    name: 'toimg',
    aliases: ['toimage', 'ti', 'togif', 'tg'],
    description: 'Convert a sticker to an image or GIF',
    usage: `${config.prefix}toimg — reply to a sticker (add "doc" to send as a lossless PNG document, e.g. ${config.prefix}toimg doc)`,
    category: 'Media',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message, args) {
        if (!message.hasQuotedMsg) {
            await message.reply('Please reply to a sticker to convert it.');
            return;
        }

        let quoted;
        try {
            quoted = await getQuotedMessageWithRetry(message);
        } catch (err) {
            logger.error(`[toimg] Error fetching quoted message: ${describeError(err)}`);
            await message.reply('Failed to read replied message. Please try replying again.');
            return;
        }

        if (quoted.type !== 'sticker') {
            await message.reply('The replied message is not a sticker.');
            return;
        }

        if (!quoted.hasMedia) {
            await message.reply('Failed to download sticker media.');
            return;
        }

        let stickerMedia;
        try {
            stickerMedia = await quoted.downloadMedia();
        } catch (err) {
            logger.error(`[toimg] Error downloading sticker media: ${describeError(err)}`);
            await message.reply('Failed to download sticker media.');
            return;
        }

        if (!stickerMedia) {
            await message.reply('Failed to download sticker media.');
            return;
        }

        try {
            const result = await mediaToolkit.stickerToVisual(stickerMedia);

            if (result.kind === 'image') {
                // WhatsApp re-encodes ordinary "photo" sends to JPEG on its own
                // media pipeline, which flattens transparency onto white.
                // Sending as a document skips that re-encode entirely, so the
                // PNG (and its alpha channel) arrives byte-for-byte untouched.
                const asDocument =
                    args[0] && ['doc', 'document', 'png'].includes(args[0].toLowerCase());

                await client.sendMessage(
                    message.from,
                    result.media,
                    asDocument ? { sendMediaAsDocument: true } : {},
                );
                return;
            }

            await client.sendMessage(message.from, result.media, {
                sendVideoAsGif: true,
            });
        } catch (err) {
            if (err.code === mediaToolkit.CODES.BUSY) {
                await message.reply('Media queue is busy right now. Please try again in a moment.');
                return;
            }

            if (err.code === mediaToolkit.CODES.FFMPEG_MISSING) {
                await message.reply(
                    'FFmpeg is not installed, so animated stickers cannot be converted.',
                );
                return;
            }

            if (err.code === mediaToolkit.CODES.UNSUPPORTED) {
                await message.reply('That sticker could not be read.');
                return;
            }

            logger.error('[toimg] Conversion failed:', describeError(err));
            await message.reply('Failed to process sticker.');
        }
    },
};
