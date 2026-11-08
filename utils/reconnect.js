/**
 * Reconnect backoff — pure helper so the timing can be unit tested without
 * starting WhatsApp.
 */

/**
 * Exponential backoff with a ceiling.
 *
 * attempt 1 → base, attempt 2 → 2×base, attempt 3 → 4×base, … capped at max.
 *
 * @param {number} attempt 1-based reconnect attempt
 * @param {number} [baseDelayMs=5000]
 * @param {number} [maxDelayMs=60000]
 * @returns {number} Delay in milliseconds
 */
function computeReconnectDelay(attempt, baseDelayMs = 5000, maxDelayMs = 60000) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const base =
    Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? Math.floor(baseDelayMs) : 5000;
  const max =
    Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? Math.floor(maxDelayMs) : 60000;

  return Math.min(max, base * 2 ** (safeAttempt - 1));
}

module.exports = { computeReconnectDelay };
