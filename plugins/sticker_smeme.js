/**
 * Plugin: Sticker Smeme
 *
 * Adds Impact-style top/bottom text to an image and sends the result back as
 * a WhatsApp sticker. The canvas is built from the source image dimensions
 * (up to a safe 4096px cap); WhatsApp then converts the result into its normal
 * 512x512 sticker format, just like plugins/sticker.js does.
 *
 * Usage:
 *   - Send/reply to an image with: .smeme hello bro/ whats about the world?
 *   - One block only:               .smeme hello bro
 *
 * The renderer lives in this file on purpose: it is a single-command feature,
 * not a general media toolkit. Heavy work is still queued through utils/media.
 */

const fs = require("fs");
const { MessageMedia } = require("whatsapp-web.js");
const sharp = require("sharp");

const config = require("../config");
const logger = require("../utils/logger");
const media = require("../utils/media");
const { resolveProjectPath } = require("../utils/paths");

const MAX_DIMENSION = 4096;
const JPEG_QUALITY = 90;
const MIN_FONT_SIZE = 14;
const DEFAULT_FONT_FILE = "assets/ttf/impact.ttf";
const FALLBACK_FONT = 'Impact, "Arial Black", sans-serif';

// ─── WhatsApp helpers (kept local to this plugin) ───────

/**
 * Puppeteer sometimes throws a minified in-page object instead of a real
 * Error. Pull whatever is informative off the object so logs are debuggable.
 */
function describeError(err) {
  if (!err) return "unknown error";
  if (err.message && err.message !== err.name) return err.message;
  try {
    return JSON.stringify(err, Object.getOwnPropertyNames(err));
  } catch {
    return String(err);
  }
}

/**
 * getQuotedMessage() occasionally fails on the first attempt because WhatsApp
 * Web's message store has not indexed the quoted message yet. Retry once.
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

// ─── Renderer dependencies (lazy) ───────────────────────

let canvasLib = null;

/**
 * Load @napi-rs/canvas lazily so a missing dependency does not make the whole
 * plugin disappear from the menu; the command can reply with instructions.
 */
function getCanvasModule() {
  if (canvasLib) return canvasLib;

  try {
    canvasLib = require("@napi-rs/canvas");
  } catch (err) {
    const error = new Error(
      "The @napi-rs/canvas package is not installed. Run: npm install",
    );
    error.code = "SMEME_RENDERER_MISSING";
    error.cause = err;
    throw error;
  }

  return canvasLib;
}

// ─── Font ───────────────────────────────────────────────

let fontFamily = null;

/**
 * Register a custom font file once, then choose the CSS font family string.
 *
 * Priority: SMEME_FONT_PATH → assets/ttf/impact.ttf → system Impact → fallback.
 *
 * @param {{ GlobalFonts: object }} canvas
 * @returns {string}
 */
function ensureFontFamily(canvas) {
  if (fontFamily) return fontFamily;

  const candidates = [];
  if (config.smemeFontPath) candidates.push(config.smemeFontPath);
  candidates.push(DEFAULT_FONT_FILE);

  for (const candidate of candidates) {
    const fontPath = resolveProjectPath(candidate);

    if (!fs.existsSync(fontPath)) {
      if (candidate === config.smemeFontPath) {
        logger.warn(`[smeme] SMEME_FONT_PATH not found: ${fontPath}`);
      }
      continue;
    }

    try {
      const registered = canvas.GlobalFonts.registerFromPath(
        fontPath,
        "SmemeFont",
      );

      if (registered) {
        fontFamily = `"SmemeFont", ${FALLBACK_FONT}`;
        logger.success(`[smeme] Using custom font: ${fontPath}`);
        return fontFamily;
      }

      logger.warn(`[smeme] Could not register font: ${fontPath}`);
    } catch (err) {
      logger.warn(`[smeme] Font registration failed (${fontPath}): ${err.message}`);
    }
  }

  fontFamily = FALLBACK_FONT;
  return fontFamily;
}

// ─── Text splitting / layout ────────────────────────────

/**
 * Split meme text into top/bottom blocks.
 *
 * A `|` separator is supported as an undocumented escape hatch for text that
 * contains slashes; otherwise exactly one `/` splits top/bottom. A single
 * block with no separator is placed at the top.
 *
 * @param {string} raw
 * @returns {{ top: string, bottom: string }}
 */
function splitMemeText(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { top: "", bottom: "" };

  if (text.includes("|")) {
    const index = text.indexOf("|");
    return {
      top: text.slice(0, index).trim(),
      bottom: text.slice(index + 1).trim(),
    };
  }

  const slashes = (text.match(/\//g) || []).length;
  if (slashes === 1) {
    const index = text.indexOf("/");
    return {
      top: text.slice(0, index).trim(),
      bottom: text.slice(index + 1).trim(),
    };
  }

  // No separator (or slashes inside e.g. a URL): keep it as one top block.
  return { top: text, bottom: "" };
}

/**
 * Wrap text into lines that fit `maxWidth`.
 *
 * @param {(text: string) => number} measureText Width of text at current font
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapLines(measureText, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = "";

  const push = (line) => {
    if (line) lines.push(line);
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (measureText(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      push(current);
      current = "";
    }

    if (measureText(word) <= maxWidth) {
      current = word;
      continue;
    }

    // A single word wider than the block: split it by characters.
    let chunk = "";
    for (const char of word) {
      const next = chunk + char;
      if (chunk && measureText(next) > maxWidth) {
        push(chunk);
        chunk = char;
      } else {
        chunk = next;
      }
    }
    current = chunk;
  }

  push(current);
  return lines;
}

/**
 * Shorten text with an ellipsis until it fits `maxWidth`.
 */
function ellipsize(measureText, text, maxWidth) {
  const ellipsis = "…";

  if (measureText(text + ellipsis) <= maxWidth) return `${text}${ellipsis}`;

  let output = text;
  while (output.length > 0 && measureText(output + ellipsis) > maxWidth) {
    output = output.slice(0, -1);
  }

  return output ? `${output}${ellipsis}` : ellipsis;
}

/**
 * Find a font size that fits both width and height.
 *
 * @param {(text: string, size: number) => number} measureAt
 * @param {string} text
 * @param {{ maxWidth: number, maxHeight: number, initialSize: number, minSize?: number }} options
 * @returns {{ size: number, lines: string[], lineHeight: number }}
 */
function fitBlock(measureAt, text, options) {
  const {
    maxWidth,
    maxHeight,
    initialSize,
    minSize = MIN_FONT_SIZE,
  } = options;

  let size = Math.max(minSize, Math.round(initialSize));
  const step = Math.max(1, Math.round(initialSize * 0.06));

  for (;;) {
    const measureText = (value) => measureAt(value, size);
    const lines = wrapLines(measureText, text, maxWidth);
    const lineHeight = Math.max(size, Math.round(size * 1.12));

    if (lines.length * lineHeight <= maxHeight) {
      return { size, lines, lineHeight };
    }

    if (size <= minSize) {
      const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
      const kept = lines.slice(0, maxLines);

      if (kept.length > 0 && lines.length > maxLines) {
        kept[kept.length - 1] = ellipsize(
          measureText,
          kept[kept.length - 1],
          maxWidth,
        );
      }

      return { size, lines: kept, lineHeight };
    }

    size = Math.max(minSize, size - step);
  }
}

/**
 * Draw one wrapped block with a black outline and white fill.
 */
function drawBlock(ctx, block, family, centerX, startY) {
  const { size, lines, lineHeight } = block;

  ctx.font = `bold ${size}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(2, Math.round(size * 0.14));
  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#ffffff";

  for (let index = 0; index < lines.length; index++) {
    const y = startY + index * lineHeight;
    ctx.strokeText(lines[index], centerX, y);
    ctx.fillText(lines[index], centerX, y);
  }
}

// ─── Image pipeline ─────────────────────────────────────

function decodeMediaData(input) {
  if (!input || typeof input.data !== "string" || input.data.length === 0) {
    return null;
  }

  let data = input.data;
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    data = comma === -1 ? "" : data.slice(comma + 1);
  }

  return Buffer.from(data, "base64");
}

/**
 * Render the meme image.
 *
 * @param {{ data: string, mimetype?: string }} input MessageMedia-like object
 * @param {string} text Raw meme text
 * @returns {Promise<{ buffer: Buffer, mimetype: string, width: number, height: number }>}
 */
async function renderMeme(input, text) {
  const canvas = getCanvasModule();
  const family = ensureFontFamily(canvas);

  const imageBuffer = decodeMediaData(input);
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error("Image data is empty");
  }

  // Normalize decode/EXIF orientation and cap huge images before allocating.
  const normalized = await sharp(imageBuffer, { failOn: "none" })
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = normalized.info;
  const image = await canvas.loadImage(normalized.data);
  const surface = canvas.createCanvas(width, height);
  const ctx = surface.getContext("2d");

  // White background so transparent PNG/WebP does not turn black in JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  const parts = splitMemeText(text);
  if (!parts.top && !parts.bottom) {
    throw new Error("Text is empty");
  }

  const margin = Math.max(10, Math.round(Math.min(width, height) * 0.04));
  const maxWidth = Math.max(20, width - margin * 2);
  const initialSize = Math.max(
    MIN_FONT_SIZE,
    Math.round(Math.min(width * 0.1, height * 0.15)),
  );
  const both = Boolean(parts.top && parts.bottom);
  const maxBlockHeight = Math.max(
    MIN_FONT_SIZE,
    Math.round(height * (both ? 0.38 : 0.55)),
  );

  const measureAt = (value, size) => {
    ctx.font = `bold ${size}px ${family}`;
    return ctx.measureText(value).width;
  };

  const draw = (value, position) => {
    if (!value) return;

    const block = fitBlock(measureAt, value, {
      maxWidth,
      maxHeight: maxBlockHeight,
      initialSize,
      minSize: MIN_FONT_SIZE,
    });

    const startY =
      position === "top"
        ? margin
        : Math.max(margin, height - margin - block.lines.length * block.lineHeight);

    drawBlock(ctx, block, family, width / 2, startY);
  };

  draw(parts.top, "top");
  draw(parts.bottom, "bottom");

  const output = await surface.encode("jpeg", { quality: JPEG_QUALITY });

  return { buffer: output, mimetype: "image/jpeg", width, height };
}

/**
 * Find an image on the message itself or on the quoted message.
 */
async function getImageFromMessage(message) {
  if (message.hasMedia) {
    try {
      const downloaded = await message.downloadMedia();
      if (downloaded) return downloaded;
    } catch (err) {
      logger.error(`[smeme] Could not download attached media: ${describeError(err)}`);
    }
  }

  if (!message.hasQuotedMsg) return null;

  const quoted = await getQuotedMessageWithRetry(message);
  if (!quoted || !quoted.hasMedia) return null;

  return quoted.downloadMedia();
}

module.exports = {
  name: "smeme",
  aliases: ["meme"],
  description: "Add Impact-style top/bottom text to an image and send it as a sticker",
  usage: `${config.prefix}smeme <top>/ <bottom> — send or reply to an image (single text goes on top)`,
  category: "Media",
  ownerOnly: false,
  groupOnly: false,

  async handler(client, message, args) {
    const text = (args || []).join(" ").trim();

    if (!text) {
      await message.reply(
        `Usage: ${config.prefix}smeme <top>/ <bottom> — send or reply to an image.`,
      );
      return;
    }

    let input;
    try {
      input = await getImageFromMessage(message);
    } catch (err) {
      logger.error(`[smeme] Failed to read quoted media: ${describeError(err)}`);
      await message.reply(
        "Failed to read the image. Please send it again or reply to it.",
      );
      return;
    }

    if (!input) {
      await message.reply("Send an image with the command, or reply to one.");
      return;
    }

    if (!input.mimetype || !input.mimetype.startsWith("image/")) {
      await message.reply("Only images can be used for memes.");
      return;
    }

    try {
      const result = await media.run(() => renderMeme(input, text), {
        label: "smeme",
      });

      const meme = new MessageMedia(
        "image/jpeg",
        result.buffer.toString("base64"),
        "smeme.jpg",
      );

      await client.sendMessage(message.from, meme, {
        sendMediaAsSticker: true,
        stickerAuthor: config.botName,
        stickerName: config.stickerName,
      });
      logger.success(
        `[smeme] Sent sticker (source ${result.width}x${result.height}) to ${message.from}`,
      );
    } catch (err) {
      if (err.code === media.CODES.BUSY) {
        await message.reply(
          "Media queue is busy right now. Please try again in a moment.",
        );
        return;
      }

      if (err.code === "SMEME_RENDERER_MISSING") {
        await message.reply("Meme renderer is not installed. Run: npm install");
        return;
      }

      logger.error(`[smeme] Failed to create meme: ${describeError(err)}`);
      await message.reply("Failed to create meme.");
    }
  },

  // Internal helpers exposed for unit tests only; not part of the plugin API.
  _test: { splitMemeText, wrapLines, fitBlock },
};
