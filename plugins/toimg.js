/**
 * Plugin: To Image
 * Convert a sticker back to a regular image or animated GIF
 *
 * Usage:
 *   - Reply to a sticker with: !toimg
 */

const { MessageMedia } = require('whatsapp-web.js');
const config = require('../config');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

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

        const logger = require('../utils/logger');

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

        let media;
        try {
            media = await quoted.downloadMedia();
        } catch (err) {
            logger.error(`[toimg] Error downloading sticker media: ${describeError(err)}`);
            await message.reply('Failed to download sticker media.');
            return;
        }
        if (!media) {
            await message.reply('Failed to download sticker media.');
            return;
        }

        const webpBuffer = Buffer.from(media.data, 'base64');
        const isAnimated = webpBuffer.indexOf(Buffer.from('ANIM')) !== -1;

        if (!isAnimated) {
            // Static sticker: WebP -> PNG via sharp.
            //
            // WA stickers are always stored on a 512x512 canvas, padded with
            // transparent pixels around the actual content (e.g. a 16:9 video
            // sticker sits in the middle of a square frame). Converting the
            // raw webp straight to PNG preserves that full square + padding,
            // which is correct resolution-wise but looks "squashed into 1:1"
            // with a visible background once something flattens the alpha.
            // .trim() crops that transparent border back down to the real
            // content bounding box before we ever flatten/send anything.
            const pngBuffer = await sharp(webpBuffer).trim().png().toBuffer();
            const pngMedia = new MessageMedia('image/png', pngBuffer.toString('base64'), 'sticker.png');

            // WhatsApp re-encodes ordinary "photo" sends to JPEG on its own
            // media pipeline (not just a client-side thing — it happens even
            // if we send a perfectly good PNG), which flattens any remaining
            // transparency onto a white background. Sending as a document
            // skips that re-encode entirely, so the PNG (and its alpha
            // channel) arrives byte-for-byte untouched. Request it with:
            //   .toimg doc
            const asDocument = args[0] && ['doc', 'document', 'png'].includes(args[0].toLowerCase());
            await client.sendMessage(message.from, pngMedia, asDocument ? { sendMediaAsDocument: true } : {});
            return;
        }

        // Animated sticker: WebP -> GIF (sharp) -> MP4 (FFmpeg) -> send as video GIF
        const tempId = crypto.randomBytes(6).toString('hex');
        const tempGif = path.join(os.tmpdir(), `sticker_${tempId}.gif`);
        const tempMp4 = path.join(os.tmpdir(), `sticker_${tempId}.mp4`);

        try {
            // Step 1: Convert animated WebP to GIF using sharp
            const gifBuffer = await sharp(webpBuffer, { animated: true })
                .gif()
                .toBuffer();
            fs.writeFileSync(tempGif, gifBuffer);

            // Step 2: Convert GIF to MP4 using FFmpeg
            const ffmpegBin = config.ffmpegPath || 'ffmpeg';
            const command = `"${ffmpegBin}" -i "${tempGif}" -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "${tempMp4}" -y`;

            logger.debug(`[toimg] Executing FFmpeg: ${command}`);

            await new Promise((resolve, reject) => {
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        logger.debug(`[toimg] FFmpeg stdout: ${stdout}`);
                        logger.debug(`[toimg] FFmpeg stderr: ${stderr}`);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            // Step 3: Send MP4 as looping GIF
            const mp4Data = fs.readFileSync(tempMp4).toString('base64');
            const videoMedia = new MessageMedia('video/mp4', mp4Data, 'sticker.mp4');
            await client.sendMessage(message.from, videoMedia, {
                sendVideoAsGif: true,
            });

        } catch (err) {
            console.error('[toimg] Conversion failed:', err.message);
            await message.reply('Failed to process animated sticker.');
        } finally {
            if (fs.existsSync(tempGif)) fs.unlinkSync(tempGif);
            if (fs.existsSync(tempMp4)) fs.unlinkSync(tempMp4);
        }
    },
};