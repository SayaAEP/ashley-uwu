/**
 * Environment Loader — loads `.env` via Node's built-in `process.loadEnvFile()` (Node >= 20.12).
 *
 * `.env` is optional; values override `config.js`. Must run before `require("./config")`.
 */

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");

/**
 * Load `.env` into `process.env`.
 *
 * Must run before `require("./config")` so overrides are visible.
 *
 * @param {string} [envPath] Optional explicit path to the env file
 * @returns {boolean} true if loaded, false if absent
 */
function loadEnv(envPath = ENV_PATH) {
  try {
    process.loadEnvFile(envPath);
    return true;
  } catch (err) {
    // A missing .env is perfectly normal — only surface real problems.
    if (err.code === "ENOENT") return false;
    // eslint-disable-next-line no-console
    console.warn(`[env] Could not read ${path.basename(envPath)}: ${err.message}`);
    return false;
  }
}

/**
 * Coerce a raw environment string into the schema type.
 *
 * @param {string} raw
 * @param {"string"|"number"|"boolean"|"array"} type
 * @returns {*} Coerced value, or undefined if invalid (default kept)
 */
function coerceValue(raw, type) {
  switch (type) {
    case "number": {
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? n : undefined;
    }

    case "boolean": {
      const v = String(raw).trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(v)) return true;
      if (["false", "0", "no", "n", "off"].includes(v)) return false;
      return undefined;
    }

    case "array": {
      const t = String(raw).trim();
      if (!t) return undefined;
      // JSON array form: ["--no-sandbox","--disable-gpu"]
      if (t.startsWith("[")) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map((v) => String(v));
        } catch {
          return undefined;
        }
        return undefined;
      }
      // Comma-separated form: --no-sandbox,--disable-gpu
      const parts = t
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length > 0 ? parts : undefined;
    }

    default:
      return raw;
  }
}

/**
 * Apply environment overrides on top of defaults.
 *
 * A key is overridden only when the env var is present AND non-empty —
 * blank values in .env fall back to defaults.
 *
 * @param {object} defaults
 * @param {object} schema  Map of config key → { env, type }
 * @param {object} [env]   Environment source (defaults to process.env)
 * @returns {object} New object with overrides applied
 */
function applyEnvOverrides(defaults, schema, env = process.env) {
  const result = { ...defaults };

  for (const [key, spec] of Object.entries(schema)) {
    const raw = env[spec.env];
    if (typeof raw !== "string") continue;

    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const coerced = coerceValue(trimmed, spec.type || "string");
    if (coerced === undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `[env] Invalid value for ${spec.env} (expected ${spec.type}) — keeping default.`,
      );
      continue;
    }

    result[key] = coerced;
  }

  return result;
}

/**
 * Read a value from the environment.
 *
 * @param {string} key
 * @returns {string|undefined} Trimmed value, or undefined if unset/empty
 */
function getEnv(key) {
  const value = process.env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Quote a value so Node's `.env` parser reads it back verbatim.
 *
 * Node's parser behavior:
 *   - double quotes: keep spaces, `#`, `$`, `'` — stop at inner `"`
 *   - single quotes: keep spaces, `#`, `"`  — stop at inner `'`
 *   - bare: stop at `#` (treated as comment)
 *
 * @param {string} value
 * @returns {string}
 */
function quoteEnvValue(value) {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  // Path contains both quote types — bare is the only remaining option.
  return value;
}

/**
 * Write (or update) a key in the `.env` file.
 *
 * - Normalizes Windows backslashes to forward slashes
 * - Updates key in place or appends
 * - Atomic write (temp file + rename) — no half-written .env
 *
 * @param {string} key
 * @param {string} value
 * @param {string} [envPath] Optional explicit path to the env file
 * @returns {boolean} true on success
 */
function writeEnvValue(key, value, envPath = ENV_PATH) {
  try {
    // Forward slashes avoid invalid escape sequences like "\u" in paths.
    const normalized = String(value).replace(/\\/g, "/");
    const quoted = quoteEnvValue(normalized);

    let content = "";
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, "utf8");
    }

    const existing = new RegExp(`^([ \\t]*${key}[ \\t]*=).*$`, "m");
    if (existing.test(content)) {
      // Use a replacer function so "$" sequences in the path are not treated
      // as replacement patterns.
      content = content.replace(existing, (_match, prefix) => `${prefix}${quoted}`);
    } else {
      const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
      content += `${separator}${key}=${quoted}\n`;
    }

    // Atomic write — never leave a partially written .env.
    const tmpPath = `${envPath}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, envPath);

    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[env] Could not write ${path.basename(envPath)}: ${err.message}`);
    return false;
  }
}

module.exports = {
  loadEnv,
  getEnv,
  writeEnvValue,
  applyEnvOverrides,
  coerceValue,
  quoteEnvValue,
  ENV_PATH,
};
