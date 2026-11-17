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

const { run, withTempDir } = require("./ffmpegRunner");

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
 * Chunks are walked properly instead of scanning for the bytes "ANIM": those
 * four bytes can legitimately appear inside a static image's pixel data.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isAnimatedWebp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;

  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return false;
  }

  // Each chunk: 4-byte FourCC, uint32LE payload size, payload, then one pad
  // byte when the payload size is odd.
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "ANIM") return true;

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return false;
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

/** Alpha values at or below this are treated as empty padding. */
const ALPHA_THRESHOLD = 8;

/**
 * Union bounding box of all visible (non-transparent) pixels across every
 * frame of an animated image.
 *
 * Animated stickers are delivered as a padded 512×512 canvas, but sharp's
 * `trim()` refuses multi-page images. Reading just the alpha plane and
 * scanning it lets us crop to the real content with one shared rectangle for
 * every frame, so the animation does not jitter.
 *
 * @param {Buffer} buffer Animated WebP
 * @param {number} [threshold=ALPHA_THRESHOLD] Max alpha considered empty
 * @returns {Promise<{ left: number, top: number, width: number, height: number }|null>}
 *   null when the image is fully transparent
 */
async function findAnimatedContentBounds(buffer, threshold = ALPHA_THRESHOLD) {
  const { data, info } = await sharp(buffer, { animated: true })
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const pageHeight = info.pageHeight || info.height;
  const pages = info.pages || 1;

  let minX = width;
  let minY = pageHeight;
  let maxX = -1;
  let maxY = -1;

  for (let page = 0; page < pages; page++) {
    const pageOffset = page * pageHeight * width;

    for (let y = 0; y < pageHeight; y++) {
      const rowStart = pageOffset + y * width;

      for (let x = 0; x < width; x++) {
        if (data[rowStart + x] <= threshold) continue;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Animated WebP → GIF buffer, cropped to the real content.
 *
 * Shared by the GIF and MP4 outputs. Cropping uses one rectangle for every
 * frame (union of visible pixels), so the animation does not jitter.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
async function animatedGifBuffer(buffer) {
  const bounds = await findAnimatedContentBounds(buffer);
  const pipeline = sharp(buffer, { animated: true });

  return (bounds ? pipeline.extract(bounds) : pipeline).gif().toBuffer();
}

/**
 * Animated WebP sticker → real GIF file (image/gif).
 *
 * Keeps the sticker cropped to its content. GIF supports 1-bit transparency,
 * so transparent pixels stay transparent. Send this as a *document*: if it is
 * sent as ordinary media, WhatsApp transcodes it to MP4 on its servers.
 *
 * @param {Buffer} buffer
 * @returns {Promise<MessageMedia>}
 */
async function webpToGif(buffer) {
  const gif = await animatedGifBuffer(buffer);

  if (gif.length === 0) {
    throw new Error("sharp produced an empty GIF");
  }

  return new MessageMedia("image/gif", gif.toString("base64"), "sticker.gif");
}

/**
 * Animated WebP sticker → MP4 (sent by WhatsApp as a looping GIF).
 *
 * The intermediate GIF is produced by sharp because it handles the animated
 * WebP frame timing; FFmpeg then converts it to a WhatsApp-friendly MP4.
 *
 * The padded canvas is cropped to the sticker's real content first, so the
 * result is not a square frame with empty space around the subject.
 *
 * @param {Buffer} buffer
 * @returns {Promise<MessageMedia>}
 */
async function webpToMp4(buffer) {
  const gif = await animatedGifBuffer(buffer);

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

/**
 * Animated WebP sticker → WebM with a real alpha channel (VP9).
 *
 * MP4 (H.264 + yuv420p) cannot carry alpha, so every transparent pixel is
 * flattened to a solid colour. VP9 inside WebM supports an alpha plane, so the
 * sticker's transparency survives the conversion.
 *
 * This is meant to be sent as a document. Inline WhatsApp video/GIF playback
 * still re-encodes to MP4 and drops alpha — there is no way around that.
 *
 * @param {Buffer} buffer Animated WebP
 * @param {{ crf?: number }} [options]
 * @returns {Promise<MessageMedia>}
 */
async function webpToWebm(buffer, options = {}) {
  const crf = clampNumber(options.crf, 30, 0, 63);
  const bounds = await findAnimatedContentBounds(buffer);

  // Crop to the content, then round to even dimensions (yuv420p requires it).
  const filters = [];
  if (bounds) {
    filters.push(
      `crop=${bounds.width}:${bounds.height}:${bounds.left}:${bounds.top}`,
    );
  }
  filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  // Force an alpha-capable pixel format; without this libvpx silently encodes
  // yuv420p and the transparency is lost.
  filters.push("format=yuva420p");

  return withTempDir(async (dir) => {
    const inputPath = path.join(dir, "sticker.webp");
    const outputPath = path.join(dir, "sticker.webm");

    await fsp.writeFile(inputPath, buffer);

    await run([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      filters.join(","),
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "0",
      "-crf",
      String(crf),
      // Required: libvpx refuses transparency encoding with alt-ref enabled.
      "-auto-alt-ref",
      "0",
      "-an",
      outputPath,
      "-y",
    ]);

    const output = await fsp.readFile(outputPath);
    if (output.length === 0) {
      throw new Error("FFmpeg produced an empty WebM");
    }

    return new MessageMedia("video/webm", output.toString("base64"), "sticker.webm");
  });
}

module.exports = {
  decodeMedia,
  isAnimatedWebp,
  videoExtension,
  buildVideoToWebpArgs,
  videoToAnimatedWebp,
  webpToPng,
  webpToGif,
  webpToMp4,
  webpToWebm,
  findAnimatedContentBounds,
};
