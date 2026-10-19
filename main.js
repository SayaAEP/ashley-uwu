/**
 * Ashley UwU — WhatsApp Bot Core
 *
 * Client initialization, authentication,
 * and message routing through the plugin system.
 */

const { Client, LocalAuth, NoAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const config = require("./config");
const logger = require("./utils/logger");
const pluginHandler = require("./handlers/plugin");
const { resolveChromiumPath } = require("./utils/chromium");
const { resolveFFmpegPath } = require("./utils/ffmpeg");

// ─── Load Plugins ────────────────────────────────────────
pluginHandler.loadPlugins();

// ─── Auth Strategy ───────────────────────────────────────

async function createAuthStrategy() {
  switch (config.authStrategy) {
    case "local":
      logger.info("Auth: LocalAuth (session saved to disk)");
      return new LocalAuth(
        config.authDataPath ? { dataPath: config.authDataPath } : {},
      );

    case "remote": {
      logger.info("Auth: RemoteAuth (session saved to MongoDB)");
      try {
        const { RemoteAuth } = require("whatsapp-web.js");
        const { MongoStore } = require("wwebjs-mongo");
        const mongoose = require("mongoose");

        if (!config.mongoUri) {
          logger.error("RemoteAuth requires mongoUri in config.js");
          process.exit(1);
        }

        await mongoose.connect(config.mongoUri);
        logger.success("Connected to MongoDB");

        const store = new MongoStore({ mongoose });

        return new RemoteAuth({
          store,
          dataPath: "./",
          backupSyncIntervalMs: config.backupSyncIntervalMs || 300000,
        });
      } catch (err) {
        logger.error("RemoteAuth failed — missing dependencies?");
        logger.error("Run: npm install wwebjs-mongo mongoose");
        logger.error(err.message);
        process.exit(1);
      }
    }

    case "none":
      logger.warn("Auth: NoAuth (QR scan required every restart)");
      return new NoAuth();

    default:
      logger.warn(
        `Unknown authStrategy "${config.authStrategy}", falling back to LocalAuth`,
      );
      return new LocalAuth();
  }
}

// ─── Boot ────────────────────────────────────────────────

async function boot() {
  const authStrategy = await createAuthStrategy();

  // Resolve Chromium path (auto-detect on Linux, bundled on Windows)
  const chromiumPath = resolveChromiumPath(config);

  // Resolve FFmpeg path (cross-platform check & auto-detect)
  resolveFFmpegPath(config);

  const puppeteerOpts = {
    headless: true,
    protocolTimeout: config.puppeteerProtocolTimeout !== undefined ? config.puppeteerProtocolTimeout : 300000,
    args: config.puppeteerArgs || [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
      "--no-zygote",
      "--disable-default-apps",
      "--disable-software-rasterizer",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-extensions",
      "--disable-plugins",
      "--disable-translate",
      "--disable-web-security",
    ],
  };

  if (chromiumPath) {
    puppeteerOpts.executablePath = chromiumPath;
  }

  const clientOpts = {
    authStrategy,
    puppeteer: puppeteerOpts,
    authTimeoutMs: config.authTimeoutMs !== undefined ? config.authTimeoutMs : 300000,
  };

  if (config.useWebVersionCache) {
    clientOpts.webVersionCache = {
      type: "local",
      path: "./.wwebjs_cache/",
      strict: false,
    };
  }

  const client = new Client(clientOpts);

  // ─── Events ──────────────────────────────────────────

  client.on("qr", (qr) => {
    logger.info("QR Code received, scan with your WhatsApp app:");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    logger.success("Authentication successful!");
  });

  client.on("auth_failure", (msg) => {
    logger.error("Authentication failed:", msg);
    process.exit(1);
  });

  client.on("ready", () => {
    logger.success(`${config.botName} v${config.botVersion} is ready!`);
    logger.info(`Prefix: "${config.prefix}"`);
    logger.info("Listening for messages...");
  });

  client.on("remote_session_saved", () => {
    logger.success("Remote session saved to database");
  });

  client.on("disconnected", (reason) => {
    logger.warn("Client disconnected:", reason);
  });

  // ─── Message Handler ─────────────────────────────────

  client.on("message_create", async (message) => {
    try {
      await pluginHandler.handleMessage(client, message);
    } catch (err) {
      logger.error("Message handler error:", err.message);
    }
  });

  // ─── Shutdown ────────────────────────────────────────

  let isShuttingDown = false;

  async function shutdown(reason, { destroyClient = false } = {}) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.warn(`Shutting down... (${reason})`);

    if (destroyClient) {
      // Check if RemoteAuth backup needs to finish uploading
      if (config.authStrategy === "remote") {
        const fs = require("fs");
        const tempDir = "./wwebjs_temp_session_undefined";
        const zipFile = "./RemoteAuth.zip";

        const hasTempDir = fs.existsSync(tempDir);
        const hasZip = fs.existsSync(zipFile);

        if (!hasTempDir && !hasZip) {
          logger.success("Session already synced to MongoDB");
        } else {
          const timeoutMs = config.shutdownSaveTimeoutMs || 120000;
          const timeoutSec = Math.round(timeoutMs / 1000);
          logger.info(`Waiting for MongoDB upload to finish... (timeout: ${timeoutSec}s)`);

          logger.startSpinner("Uploading session...");

          await new Promise((resolve) => {
            const startTime = Date.now();

            const checkInterval = setInterval(() => {
              const stillUploading = fs.existsSync(tempDir) || fs.existsSync(zipFile);
              const elapsed = Date.now() - startTime;

              if (!stillUploading) {
                clearInterval(checkInterval);
                logger.stopSpinner();
                logger.success("Session synced to MongoDB!");
                resolve();
              } else if (elapsed >= timeoutMs) {
                clearInterval(checkInterval);
                logger.stopSpinner();
                logger.warn(`Upload timed out (${timeoutSec}s). Proceeding with shutdown...`);
                resolve();
              }
            }, 2000);
          });
        }
      }

      try {
        logger.info("Destroying WhatsApp client...");
        await client.destroy();
        logger.success("Client destroyed.");
      } catch (err) {
        logger.error("Error during shutdown:", err.message);
      }
    }

    logger.info("Goodbye!");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Terminal input: "exit", "quit", or "stop"
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    const input = data.trim().toLowerCase();
    if (input === "exit" || input === "quit" || input === "stop") {
      shutdown(`terminal: ${input}`, { destroyClient: true });
    }
  });

  // ─── Start ───────────────────────────────────────────
  logger.info(`Starting ${config.botName}...`);
  client.initialize();

  module.exports = client;
}

// ─── Global Error Handlers ─────────────────────────────────

process.on("uncaughtException", (err) => {
  // RemoteAuth may try to zip a session before files exist
  if (err.code === "ENOENT" && err.path && err.path.includes("RemoteAuth")) {
    logger.warn("RemoteAuth backup skipped (session file not ready yet)");
    return;
  }
  logger.error("Uncaught exception:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logger.error("Unhandled rejection:", err.message || err);
});

boot().catch((err) => {
  logger.error("Failed to start bot:", err.message);
  process.exit(1);
});
