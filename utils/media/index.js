/**
 * Media Toolkit — the ONLY media API plugins should use.
 *
 * Plugins never talk to FFmpeg, sharp, temp files, or the queue directly.
 * They call high-level operations and receive MessageMedia ready to send:
 *
 *   const media = require("../utils/media");
 *   const sticker = await media.toSticker(inputMedia);
 *   const result  = await media.stickerToVisual(stickerMedia);
 *
 * Heavy work is serialized through a small queue so a burst of stickers cannot
 * exhaust RAM/CPU on low-end machines.
 *
 * Adding a new operation later:
 *   1. Put the transformation in `convert.js`.
 *   2. Add a wrapper here that calls `enqueue("<label>", () => ...)`.
 *   3. Document it in `docs/MEDIA.md` and add a test.
 */

const config = require("../../config");
const { createQueue } = require("../taskQueue");
const convert = require("./convert");

/** Error codes plugins can branch on without matching message strings. */
const CODES = Object.freeze({
  BUSY: "MEDIA_BUSY",
  UNSUPPORTED: "MEDIA_UNSUPPORTED",
  FFMPEG_MISSING: "MEDIA_FFMPEG_MISSING",
  CONVERT_FAILED: "MEDIA_CONVERT_FAILED",
});

class MediaError extends Error {
  /**
   * @param {string} code One of CODES
   * @param {string} message Human-readable detail (for logs)
   * @param {Error} [cause] Original error
   */
  constructor(code, message, cause) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const queue = createQueue({
  concurrency: config.mediaConcurrency || 2,
  maxPending: 10,
  name: "media",
});

/**
 * Convert internal/FFmpeg failures into typed MediaError instances.
 *
 * @param {*} err
 * @returns {MediaError}
 */
function toMediaError(err) {
  if (err instanceof MediaError) return err;

  if (err && err.code === "QUEUE_FULL") {
    return new MediaError(
      CODES.BUSY,
      "Media queue is full. Try again in a moment.",
      err,
    );
  }

  if (err && err.code === "ENOENT") {
    return new MediaError(
      CODES.FFMPEG_MISSING,
      "FFmpeg executable was not found. Install FFmpeg or set FFMPEG_PATH.",
      err,
    );
  }

  return new MediaError(
    CODES.CONVERT_FAILED,
    `Media conversion failed: ${err?.message || err}`,
    err,
  );
}

/**
 * Run a task through the shared media queue.
 *
 * @param {string} label
 * @param {Function} task
 * @returns {Promise<*>}
 */
async function enqueue(label, task) {
  try {
    return await queue.run(task, { label });
  } catch (err) {
    throw toMediaError(err);
  }
}

function assertMedia(input) {
  if (!input || typeof input !== "object" || typeof input.mimetype !== "string") {
    throw new MediaError(
      CODES.UNSUPPORTED,
      "Unsupported media: missing or invalid mimetype.",
    );
  }
}

/**
 * Prepare media so it can be sent with `sendMediaAsSticker: true`.
 *
 * - Images are passed through unchanged; WhatsApp Web applies its own sticker
 *   conversion (best fidelity, same as before).
 * - Videos are converted locally to an animated WebP sticker.
 *
 * @param {object} input MessageMedia-like object
 * @param {{ maxDurationSec?: number, fps?: number }} [options]
 * @returns {Promise<object>} MessageMedia
 */
async function toSticker(input, options = {}) {
  assertMedia(input);

  const { mimetype } = input;

  if (mimetype.startsWith("image/")) {
    return input;
  }

  if (mimetype.startsWith("video/")) {
    return enqueue("sticker-video", () => convert.videoToAnimatedWebp(input, options));
  }

  throw new MediaError(CODES.UNSUPPORTED, `Unsupported media type: ${mimetype}`);
}

/**
 * Turn a sticker into something viewable.
 *
 * @param {object} sticker MessageMedia of a WebP sticker
 * @returns {Promise<{ kind: "image"|"animation", media: object }>}
 */
async function stickerToVisual(sticker) {
  assertMedia(sticker);

  if (!sticker.mimetype.includes("webp")) {
    throw new MediaError(
      CODES.UNSUPPORTED,
      `Not a WebP sticker: ${sticker.mimetype}`,
    );
  }

  let buffer;
  try {
    buffer = convert.decodeMedia(sticker);
  } catch (err) {
    throw new MediaError(CODES.UNSUPPORTED, "Sticker has no media data.", err);
  }

  if (!convert.isAnimatedWebp(buffer)) {
    return {
      kind: "image",
      media: await enqueue("sticker-image", () => convert.webpToPng(buffer)),
    };
  }

  return {
    kind: "animation",
    media: await enqueue("sticker-animation", () => convert.webpToMp4(buffer)),
  };
}

/**
 * Queue any heavy task on the shared media lane.
 *
 * Intended for future media-heavy plugins (e.g. sticker meme generation) that
 * need to run sharp/FFmpeg/canvas work without creating a second queue.
 *
 * @param {Function} task
 * @param {{ label?: string }} [meta]
 * @returns {Promise<*>}
 */
async function run(task, meta) {
  try {
    return await queue.run(task, meta);
  } catch (err) {
    // Keep the public error contract consistent with toSticker/stickerToVisual.
    if (err && err.code === "QUEUE_FULL") {
      throw new MediaError(
        CODES.BUSY,
        "Media queue is full. Try again in a moment.",
        err,
      );
    }
    throw err;
  }
}

/** @returns {{ name: string, active: number, queued: number, concurrency: number }} */
function stats() {
  return queue.stats();
}

module.exports = {
  toSticker,
  stickerToVisual,
  run,
  stats,
  MediaError,
  CODES,
};
