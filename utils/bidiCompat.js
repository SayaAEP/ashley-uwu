/**
 * Puppeteer BiDi compatibility for whatsapp-web.js media sends.
 *
 * Firefox runs through WebDriver BiDi. Its argument serializer only accepts
 * plain objects (`obj.constructor === Object`), while whatsapp-web.js passes
 * `MessageMedia` class instances into `page.evaluate()`. Firefox therefore
 * throws:
 *
 *   Custom object serialization not possible. Use plain objects instead.
 *
 * Chromium's CDP serializer tolerates class instances, so this only breaks on
 * Firefox.
 *
 * Two idempotent patches fix it without touching node_modules:
 *   1. `instanceof MessageMedia` also accepts plain media objects, so the
 *      library's own type checks keep passing after conversion.
 *   2. `Client.prototype.sendMessage` converts MessageMedia arguments (and
 *      `options.media`) to plain objects before Puppeteer serializes them.
 *
 * The page-side consumer only reads `data`, `mimetype`, and `filename`, so a
 * plain object behaves exactly like the instance.
 */

const { Client, MessageMedia } = require("whatsapp-web.js");

const PATCHED = Symbol.for("ashley-uwu.bidi-media-compat");

/**
 * Puppeteer's own definition of a serializable object.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return (
    value !== null && typeof value === "object" && value.constructor === Object
  );
}

/**
 * Reduce a MessageMedia instance to the fields the page code uses.
 *
 * @param {MessageMedia} media
 * @returns {{ mimetype: string, data: string, filename: string|null, filesize: number|null }}
 */
function toPlainMedia(media) {
  return {
    mimetype: media.mimetype,
    data: media.data,
    filename: media.filename ?? null,
    filesize: media.filesize ?? null,
  };
}

/**
 * Let plain media objects pass `instanceof MessageMedia`.
 */
function patchInstanceOf() {
  if (Object.prototype.hasOwnProperty.call(MessageMedia, Symbol.hasInstance)) {
    return;
  }

  Object.defineProperty(MessageMedia, Symbol.hasInstance, {
    configurable: true,
    value(value) {
      return (
        value !== null &&
        typeof value === "object" &&
        typeof value.mimetype === "string" &&
        typeof value.data === "string"
      );
    },
  });
}

/**
 * Install the compatibility patches. Safe to call more than once.
 *
 * @returns {boolean} true when the patch was applied by this call
 */
function install() {
  if (Client.prototype[PATCHED]) return false;

  Object.defineProperty(Client.prototype, PATCHED, { value: true });

  patchInstanceOf();

  const original = Client.prototype.sendMessage;

  Client.prototype.sendMessage = function sendMessage(
    chatId,
    content,
    options = {},
  ) {
    let nextContent = content;
    let nextOptions = options;

    if (nextContent instanceof MessageMedia && !isPlainObject(nextContent)) {
      nextContent = toPlainMedia(nextContent);
    }

    if (
      nextOptions &&
      nextOptions.media instanceof MessageMedia &&
      !isPlainObject(nextOptions.media)
    ) {
      nextOptions = {
        ...nextOptions,
        media: toPlainMedia(nextOptions.media),
      };
    }

    return original.call(this, chatId, nextContent, nextOptions);
  };

  return true;
}

install();

module.exports = { install, toPlainMedia };
