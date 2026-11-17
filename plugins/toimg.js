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
const { describeError, getQuotedMessageWithRetry } = require('../utils/whatsapp');

module.exports = {
    name: 'toimg',
    aliases: ['toimage', 'ti', 'togif', 'tg'],
    description: 'Convert a sticker to an image or GIF',
    usage: `${config.prefix}toimg — reply to a sticker`,
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
            // Undocumented escape hatch: "doc" sends the file untouched.
            //   static  → PNG document (alpha preserved)
            //   animated → real GIF document (stays GIF; WhatsApp would
            //              otherwise transcode it to MP4)
            const asDocument = (args[0] || '').toLowerCase() === 'doc';

            const result = await mediaToolkit.stickerToVisual(stickerMedia, {
                animation: asDocument ? 'gif' : 'mp4',
            });

            if (result.kind === 'image') {
                // WhatsApp re-encodes ordinary "photo" sends to JPEG on its own
                // media pipeline, which flattens transparency onto white.
                // Sending as a document skips that re-encode entirely, so the
                // PNG (and its alpha channel) arrives byte-for-byte untouched.
                await client.sendMessage(
                    message.from,
                    result.media,
                    asDocument
                        ? {
                              sendMediaAsDocument: true,
                              quotedMessageId: message.id?._serialized,
                          }
                        : { quotedMessageId: message.id?._serialized },
                );
                return;
            }

            if (asDocument) {
                await client.sendMessage(message.from, result.media, {
                    sendMediaAsDocument: true,
                    quotedMessageId: message.id?._serialized,
                });
                return;
            }

            // Default: inline MP4 (WhatsApp plays it as a GIF in chat).
            await client.sendMessage(message.from, result.media, {
                sendVideoAsGif: true,
                quotedMessageId: message.id?._serialized,
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
