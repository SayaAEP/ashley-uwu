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
  browserEngine: { env: "BROWSER_ENGINE", type: "string" },
  browserExecutablePath: { env: "BROWSER_EXECUTABLE_PATH", type: "string" },
  browserFallbackExecutablePath: {
    env: "BROWSER_FALLBACK_EXECUTABLE_PATH",
    type: "string",
  },
  useWebVersionCache: { env: "USE_WEB_VERSION_CACHE", type: "boolean" },
  browserChromiumArgs: { env: "BROWSER_CHROMIUM_ARGS", type: "array" },
  browserFirefoxArgs: { env: "BROWSER_FIREFOX_ARGS", type: "array" },
  browserProtocolTimeout: { env: "BROWSER_PROTOCOL_TIMEOUT", type: "number" },
  authTimeoutMs: { env: "AUTH_TIMEOUT_MS", type: "number" },
  ffmpegPath: { env: "FFMPEG_PATH", type: "string" },
  mongoUri: { env: "MONGO_URI", type: "string" },
  backupSyncIntervalMs: { env: "BACKUP_SYNC_INTERVAL_MS", type: "number" },
  shutdownSaveTimeoutMs: { env: "SHUTDOWN_SAVE_TIMEOUT_MS", type: "number" },
  debug: { env: "DEBUG", type: "boolean" },
  cooldownMs: { env: "COOLDOWN_MS", type: "number" },
  mediaConcurrency: { env: "MEDIA_CONCURRENCY", type: "number" },
  smemeFontPath: { env: "SMEME_FONT_PATH", type: "string" },
  reconnectBaseDelayMs: { env: "RECONNECT_BASE_DELAY_MS", type: "number" },
  reconnectMaxDelayMs: { env: "RECONNECT_MAX_DELAY_MS", type: "number" },
  reconnectMaxAttempts: { env: "RECONNECT_MAX_ATTEMPTS", type: "number" },
};

/**
 * Default values committed to the repo.
 */
const DEFAULTS = {
    // ─── Identity ────────────────────────────────────────
    botName: "Ashley UwU",
    // Single source of truth: package.json. BOT_VERSION in .env can still
    // override this for a one-off local build.
    botVersion: require("./package.json").version,
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
    authStrategy: "local",

    // Path override for LocalAuth session storage
    // authDataPath: '.wwebjs_auth',
    authDataPath: ".wwebjs_auth",

    // ─── Browser ────────────────────────────────────────
    // Engine: auto | chromium | firefox
    //
    //   auto     → detect from the resolved path. Anything not recognized as
    //              Firefox-family is treated as Chromium, so forks such as
    //              Thorium / Natrium / Brave / Vivaldi work automatically.
    //   chromium → force Chromium launch options.
    //   firefox  → force Firefox launch options (experimental).
    //
    // Firefox is NOT officially supported by whatsapp-web.js. On startup
    // failure the bot falls back to Chromium once; if neither works it exits.
    browserEngine: "auto",

    // Primary browser executable (either engine).
    //
    // This bot uses puppeteer-core (no bundled browser) — a path is required
    // unless a browser is auto-detected.
    //
    // Resolution order:
    //   1. BROWSER_EXECUTABLE_PATH        (primary)
    //   2. BROWSER_FALLBACK_EXECUTABLE_PATH (secondary, e.g. Chromium fallback)
    //   3. browser-bin/<name>/            → binary in project folder
    //   4. system install                 → auto-detected
    //
    // Auto-discovered paths are saved to .env (never here, so merges stay clean).
    //
    // Use forward slashes to avoid escape-sequence problems (e.g. "\u" in
    // "E:\ungoogled-..." is an invalid JS escape).
    //
    // Examples:
    //   '/usr/bin/chromium'
    //   '/usr/bin/google-chrome-stable'
    //   'C:/Program Files/Mozilla Firefox/firefox.exe'
    //
    // Machine-specific paths belong in .env, not here.
    browserExecutablePath: undefined,

    // Second path tried when the primary is missing or fails to start.
    // Typical setup: Firefox primary + Chromium fallback.
    browserFallbackExecutablePath: undefined,

    // Cache WhatsApp Web version files locally — saves bandwidth and startup CPU.
    useWebVersionCache: true,

    // Chromium command line flags. Defaults tuned for low-RAM ARM64 SBCs.
    // If GPU accel works (Mesa Turnip on Linux), drop --disable-gpu/
    // --disable-software-rasterizer and add --ignore-gpu-blocklist/
    // --enable-gpu-rasterization.
    browserChromiumArgs: [
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
        // Low-RAM tweaks:
        "--disable-features=site-per-process", // Saves ~10-15% memory
        "--js-flags=--max-old-space-size=512", // Cap V8 heap at 512MB
    ],

    // Firefox command line flags. Firefox does not understand the Chromium
    // flags above, so they are configured separately. Empty by default;
    // Puppeteer adds "--headless" itself when headless is enabled.
    browserFirefoxArgs: [],

    // Puppeteer protocol timeout (ms). Applies to both engines. Increase for
    // slow CPU/disk (ARM SBCs), or set 0 to disable. Default: 300000 (5 min)
    browserProtocolTimeout: 300000,

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
    shutdownSaveTimeoutMs: 120000,

    // ─── Debug Mode ─────────────────────────────────────
    // Set true to print full error stack traces
    // debug: true,

    // ─── Cooldown ────────────────────────────────────────
    // Delay between commands per user (ms)
    cooldownMs: 3000,

    // ─── Reconnect ───────────────────────────────────────
    // When the connection drops, the client is rebuilt with exponential
    // backoff instead of leaving a dead process running.
    // 0 attempts = retry forever (recommended for home connections).
    reconnectBaseDelayMs: 5000,
    reconnectMaxDelayMs: 60000,
    reconnectMaxAttempts: 0,

    // ─── Media processing ────────────────────────────────
    // Maximum simultaneous FFmpeg/sharp jobs. Lower is safer on low-RAM
    // devices; higher handles bursts faster.
    mediaConcurrency: 2,

    // Optional custom font for .smeme text. When empty, the bot first tries
    // assets/ttf/impact.ttf, then the system Impact font.
    smemeFontPath: undefined,
};

// .env and real env vars override defaults
module.exports = applyEnvOverrides(DEFAULTS, CONFIG_SCHEMA);
