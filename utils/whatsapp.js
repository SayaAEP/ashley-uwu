/**
 * WhatsApp Helpers — small shims around whatsapp-web.js quirks shared by the
 * media plugins.
 *
 * Kept separate from `utils/media` because these are about the WhatsApp layer
 * (message objects, Puppeteer/WA-Web errors), not about transcoding.
 */

/**
 * Turn whatever WhatsApp Web handed us into a loggable string.
 *
 * Puppeteer sometimes throws a minified in-page object (e.g. `{ r: r }`)
 * instead of a real Error, in which case `err.message` is useless. Error
 * properties are non-enumerable, so `Object.getOwnPropertyNames` is passed
 * explicitly to keep them in the JSON output.
 *
 * @param {*} err
 * @returns {string}
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
 * `message.getQuotedMessage()` occasionally fails on the first attempt because
 * WhatsApp Web's internal message store has not indexed the quoted message yet
 * (a timing race, not a real failure). Retry with a short delay.
 *
 * @param {import("whatsapp-web.js").Message} message
 * @param {number} [attempts=2]
 * @param {number} [delayMs=400]
 * @returns {Promise<import("whatsapp-web.js").Message>}
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

module.exports = { describeError, getQuotedMessageWithRetry };
