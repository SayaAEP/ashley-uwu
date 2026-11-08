/**
 * WhatsApp Bot Core — client lifecycle, auth, reconnect, and message routing.
 *
 * Design notes:
 * - One process owns one WhatsApp session. `utils/sessionLock` refuses a second
 *   instance sharing the same project folder.
 * - Paths are anchored to the project root (`utils/paths`) so starting the bot
 *   from another working directory cannot create a second session.
 * - On disconnect/init failure the client is rebuilt with exponential backoff
 *   instead of leaving a dead process behind.
 * - `utils/selfMessageGuard` prevents the bot from reacting to its own replies.
 */

const fs = require("fs");
const path = require("path");
const { Client, LocalAuth, NoAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { loadEnv } = require("./utils/env");

// Load .env first so env values take priority over config.js
loadEnv();

const config = require("./config");
const logger = require("./utils/logger");
const pluginHandler = require("./handlers/plugin");
const { resolveChromiumPath, cleanSingletonLock } = require("./utils/chromium");
const { resolveFFmpegPath } = require("./utils/ffmpeg");
const { PROJECT_ROOT, resolveProjectPath } = require("./utils/paths");
const sessionLock = require("./utils/sessionLock");
const selfMessageGuard = require("./utils/selfMessageGuard");
const botControl = require("./utils/botControl");
const { computeReconnectDelay } = require("./utils/reconnect");

const AUTH_DATA_PATH = resolveProjectPath(
  config.authDataPath,
  resolveProjectPath(".wwebjs_auth"),
);

let client = null;
let authStrategy = null;
let instanceLock = null;
let mongoose = null;

let shuttingDown = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let reconnectBusy = false;

// ─── Small helpers ───────────────────────────────────────

/**
 * Reject if `promise` does not settle within `ms`.
 *
 * @param {Promise<*>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<*>}
 */
function withTimeout(promise, ms, label) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    if (timer.unref) timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Destroy the current client and clear the reference. Used by reconnect and
 * failed-start paths so an old Chromium process cannot keep the profile lock.
 *
 * @returns {Promise<void>}
 */
async function destroyCurrentClient() {
  if (!client) return;

  try {
    await withTimeout(client.destroy(), 15000, "client.destroy");
  } catch (err) {
    logger.debug(`Could not destroy previous client: ${err.message}`);
  } finally {
    client = null;
  }
}

/**
 * An error that retrying cannot fix (bad config, no browser installed, …).
 *
 * @param {string} message
 * @returns {Error}
 */
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

/**
 * Detect the placeholder owner number so startup can warn clearly.
 *
 * @param {string} value
 * @returns {boolean}
 */
function ownerNumberLooksUnset(value) {
  const normalized = pluginHandler.normalizeOwnerId(value);
  return !normalized || normalized.length < 5 || normalized === "1";
}

// ─── Auth strategy ───────────────────────────────────────

async function createAuthStrategy() {
  switch (config.authStrategy) {
    case "local":
      logger.info(`Auth: LocalAuth → ${AUTH_DATA_PATH}`);
      return new LocalAuth({ dataPath: AUTH_DATA_PATH });

    case "remote": {
      logger.info("Auth: RemoteAuth (MongoDB)");

      if (!config.mongoUri) {
        throw fatalError("RemoteAuth requires mongoUri (MONGO_URI).");
      }

      if (!mongoose) {
        const mongooseLib = require("mongoose");
        await mongooseLib.connect(config.mongoUri);
        mongoose = mongooseLib;
        logger.success("Connected to MongoDB");
      }

      const { RemoteAuth } = require("whatsapp-web.js");
      const { MongoStore } = require("wwebjs-mongo");
      const store = new MongoStore({ mongoose });

      return new RemoteAuth({
        store,
        dataPath: AUTH_DATA_PATH,
        backupSyncIntervalMs: config.backupSyncIntervalMs || 300000,
      });
    }

    case "none":
      logger.warn("Auth: NoAuth (QR scan required every restart)");
      return new NoAuth();

    default:
      throw fatalError(
        `Unknown authStrategy "${config.authStrategy}" (expected local, remote, or none).`,
      );
  }
}

// ─── Client factory ──────────────────────────────────────

/**
 * Build a fresh client + auth strategy. Used at boot and on every reconnect.
 *
 * @returns {Promise<Client>}
 */
async function createClient() {
  const strategy = await createAuthStrategy();
  authStrategy = strategy;

  let chromiumPath;
  try {
    chromiumPath = resolveChromiumPath(config);
  } catch (err) {
    err.fatal = true;
    throw err;
  }

  const puppeteerOpts = {
    headless: true,
    protocolTimeout:
      config.puppeteerProtocolTimeout !== undefined
        ? config.puppeteerProtocolTimeout
        : 300000,
    args: config.puppeteerArgs || [],
  };

  if (chromiumPath) {
    puppeteerOpts.executablePath = chromiumPath;
  }

  const clientOpts = {
    authStrategy: strategy,
    puppeteer: puppeteerOpts,
    authTimeoutMs:
      config.authTimeoutMs !== undefined ? config.authTimeoutMs : 300000,
  };

  if (config.useWebVersionCache) {
    clientOpts.webVersionCache = {
      type: "local",
      path: resolveProjectPath(".wwebjs_cache"),
      strict: false,
    };
  }

  const nextClient = new Client(clientOpts);
  selfMessageGuard.install(nextClient);
  attachEvents(nextClient);
  return nextClient;
}

// ─── Events ──────────────────────────────────────────────

function attachEvents(whatsappClient) {
  whatsappClient.on("qr", (qr) => {
    logger.info("QR Code received, scan with your WhatsApp app:");
    qrcode.generate(qr, { small: true });
  });

  whatsappClient.on("authenticated", () => {
    logger.success("Authentication successful!");
  });

  whatsappClient.on("auth_failure", (message) => {
    logger.error("Authentication failed:", message);
    scheduleReconnect("auth_failure");
  });

  whatsappClient.on("ready", () => {
    reconnectAttempt = 0;
    logger.success(`${config.botName} v${config.botVersion} is ready!`);
    logger.info(`Prefix: "${config.prefix}"`);
    logger.info("Listening for messages...");
  });

  whatsappClient.on("remote_session_saved", () => {
    logger.success("Remote session saved to database");
  });

  whatsappClient.on("change_state", (state) => {
    logger.debug(`Connection state: ${state}`);
  });

  whatsappClient.on("disconnected", (reason) => {
    logger.warn(`Client disconnected: ${reason}`);

    // Keep the reference: runReconnect() destroys it (idempotent) before
    // launching a new browser so the profile lock is released first.
    scheduleReconnect(`disconnected: ${reason}`);
  });

  whatsappClient.on("message_create", async (message) => {
    if (shuttingDown) return;

    if (selfMessageGuard.shouldIgnore(message)) {
      logger.debug("[message] ignored own/status message");
      return;
    }

    try {
      await pluginHandler.handleMessage(whatsappClient, message);
    } catch (err) {
      logger.error("Message handler error:", err.message);
    }
  });
}

// ─── Reconnect ───────────────────────────────────────────

function scheduleReconnect(reason) {
  if (shuttingDown || reconnectTimer || reconnectBusy) return;

  const maxAttempts = Number(config.reconnectMaxAttempts) || 0;

  if (maxAttempts > 0 && reconnectAttempt >= maxAttempts) {
    logger.error(
      `Reconnect gave up after ${reconnectAttempt} attempt(s) — ${reason}`,
    );
    void gracefulShutdown(1, "reconnect-exhausted");
    return;
  }

  const attempt = reconnectAttempt + 1;
  const delay = computeReconnectDelay(
    attempt,
    config.reconnectBaseDelayMs,
    config.reconnectMaxDelayMs,
  );

  logger.warn(
    `Reconnect: attempt ${attempt} in ${Math.round(delay / 1000)}s (${reason})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void runReconnect(reason);
  }, delay);
}

async function runReconnect(reason) {
  if (shuttingDown) return { ok: false, error: "shutting down" };
  if (reconnectBusy) return { ok: false, error: "reconnect already in progress" };

  reconnectBusy = true;
  reconnectAttempt += 1;

  let retry = false;
  let result = { ok: false, error: "unknown reconnect failure" };

  try {
    await destroyCurrentClient();

    // A crashed Chromium may leave a SingletonLock behind.
    cleanSingletonLock(config);

    const nextClient = await createClient();
    client = nextClient;
    await nextClient.initialize();

    logger.info("Reconnect: client initialized, waiting for ready...");
    result = { ok: true };
  } catch (err) {
    if (err.fatal) {
      logger.error(`Reconnect failed permanently: ${err.message}`);
      reconnectBusy = false;
      await gracefulShutdown(1, "fatal reconnect error");
      return { ok: false, error: err.message };
    }

    logger.error(`Reconnect attempt ${reconnectAttempt} failed: ${err.message}`);
    await destroyCurrentClient();
    retry = true;
    result = { ok: false, error: err.message };
  } finally {
    reconnectBusy = false;
  }

  if (retry) {
    scheduleReconnect(`retry after attempt ${reconnectAttempt}`);
  }

  return result;
}

/**
 * Manual reconnect: run now instead of waiting for the backoff timer.
 *
 * @param {string} reason
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function requestReconnect(reason = "manual") {
  if (shuttingDown) return { ok: false, error: "shutting down" };
  if (reconnectBusy) return { ok: false, error: "reconnect already in progress" };

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Start the backoff sequence from scratch for a manual request.
  reconnectAttempt = 0;
  return runReconnect(reason);
}

/**
 * Soft restart: reload plugins, then rebuild the WhatsApp client.
 *
 * @param {string} reason
 * @returns {Promise<{ ok: boolean, error?: string, loaded?: number|null }>}
 */
async function softRestart(reason = "manual") {
  if (shuttingDown) return { ok: false, error: "shutting down" };
  if (reconnectBusy) return { ok: false, error: "reconnect already in progress" };

  let loaded = null;
  try {
    loaded = pluginHandler.reloadAll().loaded;
  } catch (err) {
    logger.error("Plugin reload failed during restart:", err.message);
  }

  const result = await requestReconnect(reason);
  return { ...result, loaded };
}

// ─── RemoteAuth shutdown ─────────────────────────────────

/**
 * Files that indicate a RemoteAuth upload is still in progress.
 *
 * @param {object} strategy
 * @returns {string[]}
 */
function remoteAuthArtifacts(strategy) {
  if (!strategy) return [];

  const artifacts = [];

  if (strategy.tempDir) artifacts.push(strategy.tempDir);
  if (strategy.dataPath && strategy.sessionName) {
    artifacts.push(path.join(strategy.dataPath, `${strategy.sessionName}.zip`));
  }

  return artifacts;
}

async function waitForRemoteSessionSave(strategy) {
  const artifacts = remoteAuthArtifacts(strategy);

  if (!artifacts.some((p) => fs.existsSync(p))) {
    logger.success("Session already synced to MongoDB");
    return;
  }

  const timeoutMs = Number(config.shutdownSaveTimeoutMs) || 120000;
  const timeoutSec = Math.round(timeoutMs / 1000);

  logger.info(`Waiting for MongoDB upload to finish... (timeout: ${timeoutSec}s)`);

  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (!artifacts.some((p) => fs.existsSync(p))) {
      logger.success("Session synced to MongoDB!");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  logger.warn(`Upload timed out (${timeoutSec}s). Proceeding with shutdown...`);
}

// ─── Shutdown ────────────────────────────────────────────

/**
 * Stop everything cleanly. Safe to call from signals, terminal input, and
 * fatal error handlers.
 *
 * @param {number} [code=0] Process exit code
 * @param {string} [reason="shutdown"]
 */
async function gracefulShutdown(code = 0, reason = "shutdown") {
  if (shuttingDown) {
    logger.warn("Already shutting down — forcing exit.");
    process.exit(code || 1);
    return;
  }

  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  logger.warn(`Shutting down... (${reason})`);

  // Never let a hung destroy/upload block the process forever. This timer is
  // deliberately NOT unref'd so shutdown keeps the event loop alive until it
  // completes (or forces the exit).
  const hardExit = setTimeout(() => {
    logger.warn("Shutdown timed out — forcing exit.");
    process.exit(code || 1);
  }, 30000);

  try {
    if (authStrategy && config.authStrategy === "remote") {
      await waitForRemoteSessionSave(authStrategy);
    }

    if (client) {
      try {
        logger.info("Destroying WhatsApp client...");
        await withTimeout(client.destroy(), 15000, "client.destroy");
        logger.success("Client destroyed.");
      } catch (err) {
        logger.error("Error during shutdown:", err.message);
      }
      client = null;
    }

    if (mongoose) {
      await mongoose.disconnect().catch(() => {});
      mongoose = null;
    }
  } finally {
    if (instanceLock) {
      instanceLock.release();
      instanceLock = null;
    }
  }

  clearTimeout(hardExit);
  logger.info("Goodbye!");
  process.exit(code);
}

// ─── Process handlers ────────────────────────────────────

function registerProcessHandlers() {
  process.on("SIGINT", () => {
    void gracefulShutdown(0, "SIGINT");
  });
  process.on("SIGTERM", () => {
    void gracefulShutdown(0, "SIGTERM");
  });

  process.on("uncaughtException", (err) => {
    // RemoteAuth may try to zip a session before files exist.
    if (err.code === "ENOENT" && err.path && String(err.path).includes("RemoteAuth")) {
      logger.warn("RemoteAuth backup skipped (session file not ready yet)");
      return;
    }

    logger.error("Uncaught exception:", err);
    void gracefulShutdown(1, "uncaughtException");
  });

  process.on("unhandledRejection", (err) => {
    logger.error("Unhandled rejection:", err?.stack || err);
  });

  // Interactive terminal commands only make sense with a real TTY.
  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    logger.info("Terminal commands: exit | reload | reconnect | restart");

    process.stdin.on("data", (data) => {
      const input = data.trim().toLowerCase();
      if (!input) return;

      switch (input) {
        case "exit":
        case "quit":
        case "stop":
          void gracefulShutdown(0, `terminal: ${input}`);
          break;

        case "reload": {
          try {
            const result = pluginHandler.reloadAll();
            logger.success(`Reloaded ${result.loaded} plugin(s).`);
          } catch (err) {
            logger.error("Plugin reload failed:", err.message);
          }
          break;
        }

        case "reconnect":
          void requestReconnect("terminal: reconnect").then((result) => {
            if (result.ok) {
              logger.success("Reconnect finished.");
            } else {
              logger.error(`Reconnect failed: ${result.error}`);
            }
          });
          break;

        case "restart":
          void softRestart("terminal: restart").then((result) => {
            if (result.ok) {
              logger.success(
                `Restart finished (${result.loaded ?? "?"} plugin(s) reloaded).`,
              );
            } else {
              logger.error(`Restart failed: ${result.error}`);
            }
          });
          break;

        default:
          logger.info("Terminal commands: exit | reload | reconnect | restart");
      }
    });
    process.stdin.on("error", (err) => {
      logger.debug(`stdin error: ${err.message}`);
    });
  } else {
    logger.debug("stdin is not a TTY — terminal commands are disabled.");
  }
}

// ─── Runtime control hooks (used by owner plugins) ───────

botControl.register({
  reloadPlugins: () => pluginHandler.reloadAll(),
  reconnect: (reason) => requestReconnect(reason || "command"),
  restart: (reason) => softRestart(reason || "command"),
  status: () => ({ shuttingDown, reconnecting: reconnectBusy }),
});

// ─── Boot ────────────────────────────────────────────────

async function boot() {
  try {
    instanceLock = sessionLock.acquire(PROJECT_ROOT);
  } catch (err) {
    logger.error("Startup refused:", err.message);
    process.exit(1);
  }

  registerProcessHandlers();
  pluginHandler.loadPlugins();

  logger.info(`Starting ${config.botName}...`);

  if (ownerNumberLooksUnset(config.ownerNumber)) {
    logger.warn(
      "ownerNumber is not configured — owner-only commands will be denied.",
    );
  }

  resolveFFmpegPath(config);

  try {
    client = await createClient();
    await client.initialize();
  } catch (err) {
    if (err.fatal) {
      logger.error(`Failed to start bot: ${err.message}`);
      await gracefulShutdown(1, "fatal startup error");
      return;
    }

    logger.error(`Failed to start WhatsApp client: ${err.message}`);
    await destroyCurrentClient();
    scheduleReconnect("initial client start failed");
  }
}

boot().catch((err) => {
  logger.error("Failed to start bot:", err);
  void gracefulShutdown(1, "boot failure");
});
