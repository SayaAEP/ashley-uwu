/**
 * Media conversions — private implementation details of the media toolkit.
 *
 * Everything here works on in-memory buffers/MessageMedia; file handling only
 * happens in the temporary directory because FFmpeg needs real paths.
 */

const { MessageMedia } = require("whatsapp-web.js");
const sharp = require("sharp");
const fsp = require("fs/promises");
const path = require("path");

const { run, withTempDir } = require("./ffmpeg");

/** `data:` URI prefix, if present, is not part of the base64 payload. */
function stripDataUri(data) {
  if (typeof data !== "string") return "";
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    return comma === -1 ? "" : data.slice(comma + 1);
  }
  return data;
}

/**
 * Decode a MessageMedia (or media-like object) into a Buffer.
 *
 * @param {{ data?: string, mimetype?: string }} media
 * @returns {Buffer}
 */
function decodeMedia(media) {
  if (!media || typeof media.data !== "string" || media.data.length === 0) {
    throw new TypeError("Media has no base64 data");
  }

  return Buffer.from(stripDataUri(media.data), "base64");
}

/**
 * WhatsApp animated stickers contain an `ANIM` chunk in the WebP container.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isAnimatedWebp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  return buffer.indexOf(Buffer.from("ANIM", "ascii")) !== -1;
}

/**
 * Pick a file extension FFmpeg understands for a video mimetype.
 *
 * @param {string} mimetype
 * @returns {string}
 */
function videoExtension(mimetype) {
  const known = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/3gpp": "3gp",
    "video/mpeg": "mpeg",
    "video/ogg": "ogv",
  };

  if (known[mimetype]) return known[mimetype];

  const subtype = String(mimetype)
    .split("/")[1]
    ?.split(";")[0]
    ?.replace(/[^a-z0-9]/gi, "");

  return subtype || "mp4";
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build the FFmpeg argument list for video → animated WebP.
 *
 * The filter chain mirrors what whatsapp-web.js used so sticker output keeps
 * the same framing/padding (300px content inside a 512×512 canvas, 5s max).
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ maxDurationSec?: number, fps?: number }} [options]
 * @returns {string[]}
 */
function buildVideoToWebpArgs(inputPath, outputPath, options = {}) {
  const duration = clampNumber(options.maxDurationSec, 5, 0.1, 10);
  const fps = clampNumber(options.fps, 10, 1, 30);

  // `\\,` becomes `\,` for FFmpeg's filter parser (commas separate filters).
  const filter =
    `scale='iw*min(300/iw\\,300/ih)':'ih*min(300/iw\\,300/ih)',` +
    `format=rgba,pad=300:300:'(300-iw)/2':'(300-ih)/2':'#00000000',` +
    `setsar=1,fps=${fps}`;

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vcodec",
    "libwebp",
    "-vf",
    filter,
    "-loop",
    "0",
    "-ss",
    "00:00:00.0",
    "-t",
    String(duration),
    "-preset",
    "default",
    "-an",
    "-s",
    "512:512",
    outputPath,
    "-y",
  ];
}

/**
 * Video → animated WebP sticker.
 *
 * @param {object} media MessageMedia-like object
 * @param {{ maxDurationSec?: number, fps?: number }} [options]
 * @returns {Promise<MessageMedia>}
 */
async function videoToAnimatedWebp(media, options = {}) {
  const input = decodeMedia(media);
  const extension = videoExtension(media.mimetype);

  return withTempDir(async (dir) => {
    const inputPath = path.join(dir, `input.${extension}`);
    const outputPath = path.join(dir, "sticker.webp");

    await fsp.writeFile(inputPath, input);
    await run(buildVideoToWebpArgs(inputPath, outputPath, options));

    const output = await fsp.readFile(outputPath);
    if (output.length === 0) {
      throw new Error("FFmpeg produced an empty WebP sticker");
    }

    return new MessageMedia("image/webp", output.toString("base64"), "sticker.webp");
  });
}

/**
 * Static WebP sticker → transparent PNG.
 *
 * `.trim()` removes the transparent 512×512 canvas padding so the actual
 * content is not surrounded by empty space.
 *
 * @param {Buffer} buffer
 * @returns {Promise<MessageMedia>}
 */
async function webpToPng(buffer) {
  const png = await sharp(buffer).trim().png().toBuffer();

  if (png.length === 0) {
    throw new Error("sharp produced an empty PNG");
  }

  return new MessageMedia("image/png", png.toString("base64"), "sticker.png");
}

/**
 * Animated WebP sticker → MP4 (sent by WhatsApp as a looping GIF).
 *
 * The intermediate GIF is produced by sharp because it handles the animated
 * WebP frame timing; FFmpeg then converts it to a WhatsApp-friendly MP4.
 *
 * @param {Buffer} buffer
 * @returns {Promise<MessageMedia>}
 */
async function webpToMp4(buffer) {
  const gif = await sharp(buffer, { animated: true }).gif().toBuffer();

  return withTempDir(async (dir) => {
    const gifPath = path.join(dir, "sticker.gif");
    const mp4Path = path.join(dir, "sticker.mp4");

    await fsp.writeFile(gifPath, gif);
    await run([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      gifPath,
      "-movflags",
      "faststart",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      mp4Path,
      "-y",
    ]);

    const mp4 = await fsp.readFile(mp4Path);
    if (mp4.length === 0) {
      throw new Error("FFmpeg produced an empty MP4");
    }

    return new MessageMedia("video/mp4", mp4.toString("base64"), "sticker.mp4");
  });
}

module.exports = {
  decodeMedia,
  isAnimatedWebp,
  videoExtension,
  buildVideoToWebpArgs,
  videoToAnimatedWebp,
  webpToPng,
  webpToMp4,
};
