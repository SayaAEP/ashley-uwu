/**
 * Ashley UwU — Bot Configuration
 *
 * Every setting can be supplied in two ways:
 *
 *   1. This file (config.js)      — committed defaults, safe to merge
 *   2. A local .env file          — per-machine overrides, git-ignored
 *
 * `.env` ALWAYS wins over the values below. That lets someone fork this bot
 * and deploy it with nothing but a `.env` file — no need to touch config.js,
 * so `git pull` of upstream updates never conflicts with local settings.
 *
 * See `.env.example` for the full list of supported variables.
 *
 * NOTE: real environment variables (set by your host / Docker / CI) also win
 * over `.env`, so deployment platforms can override anything without a file.
 */

const { loadEnv, applyEnvOverrides } = require("./utils/env");

// Load .env early so every module requiring config.js gets the overrides.
loadEnv();

/**
 * Schema: maps each config key to its env var and type.
 */
const CONFIG_SCHEMA = {
  botName: { env: "BOT_NAME", type: "string" },
  botVersion: { env: "BOT_VERSION", type: "string" },
  stickerName: { env: "STICKER_NAME", type: "string" },
  prefix: { env: "PREFIX", type: "string" },
  second_prefix: { env: "SECOND_PREFIX", type: "string" },
  ownerNumber: { env: "OWNER_NUMBER", type: "string" },
  authStrategy: { env: "AUTH_STRATEGY", type: "string" },
  authDataPath: { env: "AUTH_DATA_PATH", type: "string" },
  puppeteerExecutablePath: { env: "PUPPETEER_EXECUTABLE_PATH", type: "string" },
  useWebVersionCache: { env: "USE_WEB_VERSION_CACHE", type: "boolean" },
  puppeteerArgs: { env: "PUPPETEER_ARGS", type: "array" },
  puppeteerProtocolTimeout: { env: "PUPPETEER_PROTOCOL_TIMEOUT", type: "number" },
  authTimeoutMs: { env: "AUTH_TIMEOUT_MS", type: "number" },
  ffmpegPath: { env: "FFMPEG_PATH", type: "string" },
  mongoUri: { env: "MONGO_URI", type: "string" },
  backupSyncIntervalMs: { env: "BACKUP_SYNC_INTERVAL_MS", type: "number" },
  shutdownSaveTimeoutMs: { env: "SHUTDOWN_SAVE_TIMEOUT_MS", type: "number" },
  debug: { env: "DEBUG", type: "boolean" },
  cooldownMs: { env: "COOLDOWN_MS", type: "number" },
};

/**
 * Default values committed to the repo.
 */
const DEFAULTS = {
    // ─── Identity ────────────────────────────────────────
    botName: "Ashley UwU",
    botVersion: "1.0.2-something_new",
    stickerName: "Made with magic sparkle",

    // ─── Command Prefixes ────────────────────────────────
    prefix: ".",
    second_prefix: "!",

    // ─── Owner ───────────────────────────────────────────
    // Format: <country_code><number>@c.us
    ownerNumber: "1@c.us",

    // ─── Auth Strategy ───────────────────────────────────
    // Options: 'local' | 'remote' | 'none'
    // local  - Session saved to disk (.wwebjs_auth/)
    // remote - Session saved to MongoDB (needs wwebjs-mongo + mongoose)
    // none   - No session persistence, QR scan every restart
    authStrategy: "",

    // Path override for LocalAuth session storage
    // authDataPath: '.wwebjs_auth',
    authDataPath: ".wwebjs_auth",

    // ─── Chromium / Chrome ──────────────────────────────
    // Path to a Chromium/Chrome executable.
    //
    // This bot uses puppeteer-core (no bundled browser) — a path is required.
    //
    // Priority:
    //   1. .env                    → PUPPETEER_EXECUTABLE_PATH
    //   2. this value              → puppeteerExecutablePath
    //   3. browser-bin/<name>/     → binary in project folder
    //   4. system install          → auto-detected
    //
    // Auto-discovered paths are saved to .env (never here, so merges stay clean).
    //
    // Use forward slashes to avoid escape-sequence problems (e.g. "\u" in
    // "E:\ungoogled-..." is an invalid JS escape).
    //
    // Examples:
    //   '/usr/bin/chromium'
    //   '/usr/bin/google-chrome-stable'
    //   '/usr/bin/ungoogled-chromium'
    //   'E:/ungoogled-chromium-portable-win64-140.0.7339.137-21/app/chrome.exe'
    //
    // Machine-specific paths belong in .env, not here.
    puppeteerExecutablePath: undefined,

    // Cache WhatsApp Web version files locally — saves bandwidth and startup CPU.
    useWebVersionCache: true,

    // Custom Chromium flags. Defaults tuned for low-RAM ARM64 SBCs.
    // If GPU accel works (Mesa Turnip on Linux), drop --disable-gpu/
    // --disable-software-rasterizer and add --ignore-gpu-blocklist/
    // --enable-gpu-rasterization.
    puppeteerArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu", // Remove if Turnip Mesa GPU accel works
        "--no-zygote",
        "--disable-default-apps",
        "--disable-software-rasterizer", // Remove if GPU accel works
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-extensions",
        "--disable-plugins",
        "--disable-translate",
        "--disable-web-security",
        // Low-RAM tweaks:
        "--disable-features=site-per-process", // Saves ~10-15% memory
        "--js-flags=--max-old-space-size=512", // Cap V8 heap at 512MB
    ],

    // CDP command timeout (ms). Increase for slow CPU/disk (ARM SBCs),
    // or set 0 to disable. Default: 300000 (5 min)
    puppeteerProtocolTimeout: 300000,

    // WhatsApp Web auth timeout (ms). Increase for extremely slow devices,
    // or set 0 to disable. Default: 300000 (5 min)
    authTimeoutMs: 300000,

    // FFmpeg path (auto-detected on start if empty). Auto-detected paths
    // are written to .env, never here.
    ffmpegPath: undefined,

    // MongoDB connection string for RemoteAuth
    // mongoUri: 'mongodb://localhost:27017/ashley-uwu',
    mongoUri: undefined,

    // RemoteAuth backup interval (ms, min: 60000)
    backupSyncIntervalMs: 300000,

    // Max time to wait for session upload on shutdown (ms)
    shutdownSaveTimeoutMs: 1200000,

    // ─── Debug Mode ─────────────────────────────────────
    // Set true to print full error stack traces
    // debug: true,

    // ─── Cooldown ────────────────────────────────────────
    // Delay between commands per user (ms)
    cooldownMs: 3000,
};

// .env and real env vars override defaults
module.exports = applyEnvOverrides(DEFAULTS, CONFIG_SCHEMA);
