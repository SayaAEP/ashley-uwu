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

        const quoted = await message.getQuotedMessage();

        if (quoted.type !== 'sticker') {
            await message.reply('The replied message is not a sticker.');
            return;
        }

        if (!quoted.hasMedia) {
            await message.reply('Failed to download sticker media.');
            return;
        }

        const media = await quoted.downloadMedia();
        if (!media) {
            await message.reply('Failed to download sticker media.');
            return;
        }

        const webpBuffer = Buffer.from(media.data, 'base64');
        const isAnimated = webpBuffer.indexOf(Buffer.from('ANIM')) !== -1;

        if (!isAnimated) {
            // Static sticker: WebP -> PNG via sharp
            const pngBuffer = await sharp(webpBuffer).png().toBuffer();
            const pngMedia = new MessageMedia('image/png', pngBuffer.toString('base64'), 'sticker.png');
            await client.sendMessage(message.from, pngMedia);
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

            await new Promise((resolve, reject) => {
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        console.error('[toimg] FFmpeg error:', stderr);
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