/**
 * Ashley UwU — Bot Configuration
 */

module.exports = {
    // ─── Identity ────────────────────────────────────────
    botName: "Ashley UwU",
    botVersion: "1.0.1",

    // ─── Command Prefixes ────────────────────────────────
    prefix: ".",
    second_prefix: "!",

    // ─── Owner ───────────────────────────────────────────
    // Format: <country_code><number>@c.us
    ownerNumber: "1@c.us",

    // ─── Auth Strategy ───────────────────────────────────
    // Options: 'local' | 'remote' | 'none'
    //
    // local  - Session saved to disk (.wwebjs_auth/)
    // remote - Session saved to MongoDB (requires wwebjs-mongo + mongoose)
    // none   - No session persistence, QR scan on every restart
    authStrategy: "local",

    // Path override for LocalAuth session storage
    // authDataPath: '.wwebjs_auth',

    // ─── Chromium / Chrome ──────────────────────────────
    // Path to a system-installed Chromium or Chrome executable.
    // On Linux (especially ARM64), the bot auto-detects and writes
    // this value on first run. Set it manually if auto-detect fails.
    // On Windows this is ignored (Puppeteer's bundled Chrome is used).
    // Examples:
    //   '/usr/bin/chromium'
    //   '/usr/bin/google-chrome-stable'
    //   '/usr/bin/ungoogled-chromium'
    // puppeteerExecutablePath: '',

    // Enable local caching of WhatsApp Web version files.
    // This avoids downloading the web client assets from the internet on every start,
    // saving bandwidth and reducing startup CPU load dramatically.
    useWebVersionCache: true,

    // Custom Chromium command line flags.
    // Optimized for low-end / low-RAM ARM64 SBCs by default.
    // If you have GPU acceleration working (like Mesa Turnip on Linux),
    // you can remove '--disable-gpu' and '--disable-software-rasterizer'
    // and add '--ignore-gpu-blocklist' and '--enable-gpu-rasterization'.
    puppeteerArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu", // Remove this if Turnip Mesa GPU accel is working
        "--no-zygote",
        "--disable-default-apps",
        "--disable-software-rasterizer", // Remove this if GPU accel is working
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-extensions",
        "--disable-plugins",
        "--disable-translate",
        "--disable-web-security",
        // Additional low-RAM performance tweaks:
        "--disable-features=site-per-process", // Saves ~10-15% memory by merging processes
        "--js-flags=--max-old-space-size=512", // Caps V8 heap size to 512MB
    ],

    // Timeout for Chromium DevTools Protocol (CDP) commands (ms).
    // If your device has slow CPU/Disk (like ARM SBCs), increase this
    // or set it to 0 to disable protocol timeouts completely.
    // Default: 300000 (5 minutes)
    puppeteerProtocolTimeout: 300000,

    // Timeout for WhatsApp Web authentication process (ms).
    // If the device is extremely slow to load the page, increase this
    // or set it to 0 to disable authentication timeout completely.
    // Default: 300000 (5 minutes)
    authTimeoutMs: 300000,

    // Path to FFmpeg executable (auto-detected on start if left commented)
    // ffmpegPath: '',
    
    // MongoDB connection string for RemoteAuth
    // mongoUri: 'mongodb://localhost:27017/ashley-uwu',

    // How often RemoteAuth backs up the session (ms, min: 60000)
    backupSyncIntervalMs: 300000,

    // Max time to wait for session upload on shutdown (ms)
    // Increase this if you have slow upload speeds
    shutdownSaveTimeoutMs: 1200000,

    // ─── Cooldown ────────────────────────────────────────
    // Delay between commands per user (ms)
    cooldownMs: 3000,
};