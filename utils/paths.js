/**
 * Project Paths — every filesystem location the bot owns is anchored to the
 * project root, never to `process.cwd()`.
 *
 * Why: running `node "E:/.../ashley-uwu/index.js"` from another directory must
 * keep using the same `.wwebjs_auth` session instead of creating a new one in
 * the current working directory.
 */

const path = require("path");

/** Absolute path to the project root (the folder containing package.json). */
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Resolve a path relative to the project root.
 *
 * Absolute paths are returned normalized and untouched, so users can still
 * point `AUTH_DATA_PATH` at another drive/folder.
 *
 * @param {string} [target] Relative or absolute path
 * @param {string} [fallback] Value returned when `target` is empty
 * @returns {string} Absolute path
 */
function resolveProjectPath(target, fallback = PROJECT_ROOT) {
  if (typeof target !== "string" || target.trim().length === 0) {
    return fallback;
  }

  const value = target.trim();
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

module.exports = { PROJECT_ROOT, resolveProjectPath };
