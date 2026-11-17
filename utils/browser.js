/**
 * Browser Resolver — resolves the executable used by Puppeteer.
 *
 * Supports two engines:
 *   - chromium (default): Chrome, Chromium, Edge, Brave, Vivaldi, Opera,
 *     Thorium, Natrium, and other Chromium-based builds.
 *   - firefox (experimental): Firefox, Firefox ESR, LibreWolf, Waterfox,
 *     IceCat, Iceweasel, Basilisk, Pale Moon, Tor Browser.
 *
 * Engine selection (`BROWSER_ENGINE`):
 *   - auto     → detect from the resolved path (Firefox-family tokens),
 *                otherwise Chromium. Anything not recognized as Firefox is
 *                Chromium, so forks do not need to be listed.
 *   - chromium → force Chromium options.
 *   - firefox  → force Firefox options.
 *
 * Path priority:
 *   1. BROWSER_EXECUTABLE_PATH (primary)
 *   2. BROWSER_FALLBACK_EXECUTABLE_PATH (secondary)
 *   3. browser-bin/<name>/ inside the project
 *   4. well-known system locations + PATH
 *
 * Auto-discovered paths are saved to `.env` as BROWSER_EXECUTABLE_PATH, never
 * to config.js.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");
const logger = require("./logger");
const { writeEnvValue } = require("./env");
const { PROJECT_ROOT, resolveProjectPath } = require("./paths");

// Firefox-family tokens. Presence anywhere in the path means "Firefox".
const FIREFOX_TOKENS = [
  "firefox",
  "librewolf",
  "waterfox",
  "icecat",
  "iceweasel",
  "basilisk",
  "palemoon",
  "tor-browser",
  "torbrowser",
];

// Names to probe through the system PATH.
const CHROMIUM_KEYWORDS = [
  "chromium",
  "chromium-browser",
  "chrome",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
  "msedge",
  "brave-browser",
  "brave",
  "vivaldi",
  "vivaldi-stable",
  "opera",
  "thorium",
  "natrium",
  "ungoogled-chromium",
];

const FIREFOX_KEYWORDS = [
  "firefox",
  "firefox-esr",
  "librewolf",
  "waterfox",
  "icecat",
  "iceweasel",
];

// Well-known Chromium paths.
const LINUX_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/ungoogled-chromium",
  "/snap/bin/chromium",
  "/usr/lib/chromium/chromium",
  "/usr/lib/chromium-browser/chromium-browser",
];

const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Chromium\\Application\\chrome.exe",
];

const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

// Well-known Firefox paths.
const FIREFOX_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  ],
  darwin: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
  linux: [
    "/usr/bin/firefox",
    "/usr/local/bin/firefox",
    "/snap/bin/firefox",
    "/opt/firefox/firefox",
    "/usr/lib/firefox/firefox",
  ],
};

// Folder where users can drop their own browser binary.
const BROWSER_BIN_DIR = path.join(PROJECT_ROOT, "browser-bin");
const BROWSER_BIN_MAX_DEPTH = 3;

// Support binaries that live next to a browser and must not be picked.
const HELPER_BIN_RE =
  /(crashpad|nacl64|wow_helper|notification_helper|elevated_tracing|chrome_proxy|setup|installer|uninstall|updater|ffmpeg|ffplay|ffprobe)/i;

// Names that look like a browser (used only to rank candidates).
const BROWSER_NAME_HINTS =
  /(chrome|chromium|msedge|edge|brave|vivaldi|opera|thorium|natrium|firefox|librewolf|waterfox|icecat|basilisk|palemoon)/i;

/**
 * Check if `p` is a real, readable file.
 *
 * On Windows X_OK is ignored, so we only require that the file exists.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isExecutable(p) {
  if (!p || typeof p !== "string") return false;

  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  if (os.platform() !== "win32") {
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Is this executable Firefox-family?
 *
 * The check looks at the whole path (so `/opt/Tor Browser/...` counts) and
 * defaults everything else to Chromium.
 *
 * @param {string} execPath
 * @returns {boolean}
 */
function isFirefoxFamily(execPath) {
  const lower = String(execPath || "").toLowerCase().replace(/\\/g, "/");
  return FIREFOX_TOKENS.some((token) => lower.includes(token));
}

/**
 * @param {string} execPath
 * @returns {"firefox"|"chromium"}
 */
function detectEngineFromPath(execPath) {
  return isFirefoxFamily(execPath) ? "firefox" : "chromium";
}

/**
 * Create an error tagged with the engine that failed.
 *
 * @param {"chromium"|"firefox"} engine
 * @param {string} message
 * @param {boolean} [fatal=false] Stop the process instead of reconnecting
 * @returns {Error}
 */
function browserError(engine, message, fatal = false) {
  const err = new Error(message);
  err.engine = engine;
  if (fatal) err.fatal = true;
  return err;
}

/**
 * `where <name>` on Windows, `which <name>` elsewhere.
 *
 * @param {string[]} names
 * @returns {string|null}
 */
function searchPathCommand(names) {
  const cmd = os.platform() === "win32" ? "where" : "which";

  for (const name of names) {
    try {
      const result = execSync(`${cmd} ${name}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();

      const firstLine = result.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (firstLine && isExecutable(firstLine)) return firstLine;
    } catch {
      // Not found — try the next name.
    }
  }

  return null;
}

/**
 * Find a Chromium-based browser installed in a well-known system location.
 *
 * @param {string} platform os.platform() value
 * @returns {string|null}
 */
function findSystemBrowser(platform) {
  if (platform === "win32") {
    for (const candidate of WINDOWS_CANDIDATES) {
      if (isExecutable(candidate)) return candidate;
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const localCandidates = [
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Chromium", "Application", "chrome.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(localAppData, "Thorium", "Application", "thorium.exe"),
      ];
      for (const candidate of localCandidates) {
        if (isExecutable(candidate)) return candidate;
      }
    }

    return searchPathCommand(CHROMIUM_KEYWORDS);
  }

  if (platform === "darwin") {
    for (const candidate of MACOS_CANDIDATES) {
      if (isExecutable(candidate)) return candidate;
    }
    return searchPathCommand(CHROMIUM_KEYWORDS);
  }

  for (const candidate of LINUX_CANDIDATES) {
    if (isExecutable(candidate)) return candidate;
  }
  return searchPathCommand(CHROMIUM_KEYWORDS);
}

/**
 * Find a Firefox-family browser installed in a well-known system location.
 *
 * @param {string} platform os.platform() value
 * @returns {string|null}
 */
function findSystemFirefox(platform) {
  const candidates = FIREFOX_CANDIDATES[platform] || FIREFOX_CANDIDATES.linux;

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const name of ["Mozilla Firefox", "LibreWolf", "Waterfox"]) {
        const candidate = path.join(localAppData, name, "firefox.exe");
        if (isExecutable(candidate)) return candidate;
      }
    }
  }

  return searchPathCommand(FIREFOX_KEYWORDS);
}

// ─── Project-local browser-bin/ scanner ─────────────────────

/**
 * Walk a directory tree collecting executable files.
 *
 * @param {string} dir
 * @param {number} depth Remaining recursion depth
 * @param {string[]} out
 */
function collectExecutables(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const full = path.join(dir, entry.name);

    if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (os.platform() === "win32" && !lower.endsWith(".exe")) continue;
      if (HELPER_BIN_RE.test(lower)) continue;
      if (isExecutable(full)) out.push(full);
      continue;
    }

    if (!entry.isDirectory()) continue;

    // macOS: look inside "<App>.app/Contents/MacOS/".
    if (entry.name.endsWith(".app")) {
      collectExecutables(path.join(full, "Contents", "MacOS"), 0, out);
      continue;
    }

    if (depth > 0) collectExecutables(full, depth - 1, out);
  }
}

/**
 * Find a browser inside the project's `browser-bin/` folder.
 *
 * Users can drop any Chromium- or Firefox-based binary there, e.g.:
 *   browser-bin/chrome-156/chrome.exe
 *   browser-bin/librewolf-141/librewolf.exe
 *
 * @param {"chromium"|"firefox"|null} [engine] Filter by engine, or null for any
 * @returns {string|null}
 */
function findProjectBrowser(engine = null) {
  if (!fs.existsSync(BROWSER_BIN_DIR)) return null;

  const found = [];

  let entries;
  try {
    entries = fs.readdirSync(BROWSER_BIN_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    collectExecutables(
      path.join(BROWSER_BIN_DIR, entry.name),
      BROWSER_BIN_MAX_DEPTH,
      found,
    );
  }

  const filtered = engine
    ? found.filter((candidate) => detectEngineFromPath(candidate) === engine)
    : found;

  // Prefer files whose name actually looks like a browser.
  filtered.sort((a, b) => {
    const aScore = BROWSER_NAME_HINTS.test(path.basename(a)) ? 1 : 0;
    const bScore = BROWSER_NAME_HINTS.test(path.basename(b)) ? 1 : 0;
    return bScore - aScore;
  });

  return filtered[0] || null;
}

/**
 * Does the installed puppeteer package ship a bundled browser?
 *
 * @returns {boolean}
 */
function hasBundledBrowser() {
  try {
    return require("puppeteer/package.json").name === "puppeteer";
  } catch {
    return false;
  }
}

// ─── Env Writer ─────────────────────────────────────────────

/**
 * Save a discovered executable path to `.env` as BROWSER_EXECUTABLE_PATH.
 *
 * @param {string} execPath
 */
function writePathToEnv(execPath) {
  const ok = writeEnvValue("BROWSER_EXECUTABLE_PATH", execPath);
  if (ok) {
    logger.success(`Saved BROWSER_EXECUTABLE_PATH to .env → ${execPath}`);
  } else {
    logger.warn("Could not write BROWSER_EXECUTABLE_PATH to .env");
    logger.warn("Set it manually in .env");
  }
}

// ─── Stale profile lock cleanup ─────────────────────────────

/**
 * Persistent profile directories for the active auth strategy.
 *
 * Mirrors the `userDataDir` set by whatsapp-web.js:
 *   local  → <auth>/session
 *   remote → <auth>/RemoteAuth (and RemoteAuth-<clientId>)
 *   none   → no persistent profile
 *
 * @param {object} config
 * @returns {string[]}
 */
function profileDirs(config) {
  const basePath = resolveProjectPath(
    config.authDataPath,
    resolveProjectPath(".wwebjs_auth"),
  );

  if (config.authStrategy === "local") {
    return [path.join(basePath, "session")];
  }

  if (config.authStrategy === "remote") {
    try {
      return fs
        .readdirSync(basePath)
        .filter(
          (name) => name === "RemoteAuth" || name.startsWith("RemoteAuth-"),
        )
        .map((name) => path.join(basePath, name));
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Remove stale browser profile locks.
 *
 * Chromium leaves `SingletonLock` behind after a crash; Firefox leaves `lock`
 * and `.parentlock`. Removing them is only safe because `utils/sessionLock`
 * guarantees this process is the only bot instance.
 *
 * Only the known profile directories are checked — walking the whole profile
 * tree on every connect is both slower and unnecessary.
 *
 * @param {object} config
 * @param {"chromium"|"firefox"} [engine="chromium"]
 */
function cleanProfileLocks(config, engine = "chromium") {
  const lockNames =
    engine === "firefox" ? ["lock", ".parentlock"] : ["SingletonLock"];

  for (const dir of profileDirs(config)) {
    for (const name of lockNames) {
      const lockPath = path.join(dir, name);

      try {
        fs.unlinkSync(lockPath);
        logger.info(`Browser: cleaned stale ${name} → ${lockPath}`);
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger.warn(
            `Browser lock cleanup warning (${lockPath}): ${err.message}`,
          );
        }
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Configured paths in priority order: primary first, fallback second.
 *
 * @param {object} config
 * @returns {string[]}
 */
function configuredPaths(config) {
  const paths = [];

  for (const candidate of [
    config.browserExecutablePath,
    config.browserFallbackExecutablePath,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      paths.push(candidate.trim());
    }
  }

  return paths;
}

/**
 * @param {"chromium"|"firefox"} engine
 * @param {string} execPath
 * @returns {{ engine: "chromium"|"firefox", executablePath: string }}
 */
function adopt(engine, execPath) {
  writePathToEnv(execPath);
  logger.success(`Browser: detected ${engine} → ${execPath}`);
  return { engine, executablePath: execPath };
}

/**
 * Resolve a Chromium executable (explicit engine mode).
 *
 * @param {object} config
 * @returns {{ engine: "chromium", executablePath: string|undefined }}
 * @throws {Error} When no browser is found
 */
function resolveChromiumPath(config) {
  const projectBrowser = findProjectBrowser("chromium");
  if (projectBrowser) return adopt("chromium", projectBrowser);

  const systemBrowser = findSystemBrowser(os.platform());
  if (systemBrowser) return adopt("chromium", systemBrowser);

  if (hasBundledBrowser()) {
    logger.info("Browser: using Puppeteer's bundled Chromium");
    return { engine: "chromium", executablePath: undefined };
  }

  throw browserError(
    "chromium",
    [
      "No Chromium-based browser found.",
      "",
      "Fix it in any of these ways:",
      "  1. Set BROWSER_EXECUTABLE_PATH in .env",
      "  2. Put a browser in browser-bin/<name>/",
      "  3. Install Chrome/Chromium/Edge/Brave",
    ].join("\n"),
    true,
  );
}

/**
 * Resolve a Firefox-family executable (explicit engine mode).
 *
 * @param {object} config
 * @returns {{ engine: "firefox", executablePath: string }}
 * @throws {Error} When no Firefox is found
 */
function resolveFirefoxPath(config) {
  const projectBrowser = findProjectBrowser("firefox");
  if (projectBrowser) return adopt("firefox", projectBrowser);

  const systemBrowser = findSystemFirefox(os.platform());
  if (systemBrowser) return adopt("firefox", systemBrowser);

  throw browserError(
    "firefox",
    [
      "No Firefox-based browser found.",
      "",
      "Fix it in any of these ways:",
      "  1. Set BROWSER_EXECUTABLE_PATH in .env (e.g. Firefox, LibreWolf, Waterfox)",
      "  2. Put a Firefox binary in browser-bin/<name>/",
      "  3. Install Firefox",
    ].join("\n"),
    true,
  );
}

/**
 * Resolve the browser engine and executable.
 *
 * @param {object} config
 * @returns {{ engine: "chromium"|"firefox", executablePath: string|undefined }}
 * @throws {Error} When the setting is invalid or no browser is found
 */
function resolveBrowser(config) {
  const setting = String(config.browserEngine || "auto").trim().toLowerCase();

  if (!["auto", "chromium", "firefox"].includes(setting)) {
    const err = new Error(
      `Unknown browserEngine "${config.browserEngine}" (expected auto, chromium, or firefox).`,
    );
    err.fatal = true;
    throw err;
  }

  // 1. Configured paths: primary, then fallback.
  const configured = configuredPaths(config);

  for (const candidate of configured) {
    if (!isExecutable(candidate)) {
      logger.warn(`Configured browser path not found: ${candidate}`);
      continue;
    }

    const detected = detectEngineFromPath(candidate);

    // A forced engine must not launch a binary of the other engine.
    if (setting !== "auto" && detected !== setting) {
      logger.warn(
        `Configured path looks like ${detected}, but BROWSER_ENGINE=${setting}; ignoring it.`,
      );
      continue;
    }

    const engine = setting === "auto" ? detected : setting;
    logger.info(`Browser: using ${engine} (configured path) → ${candidate}`);
    return { engine, executablePath: candidate };
  }

  // Explicit engine + invalid/mismatched configured path: fall through to
  // detection for that engine instead of failing immediately.
  if (setting === "firefox") return resolveFirefoxPath(config);
  if (setting === "chromium") return resolveChromiumPath(config);

  // 2. Auto: prefer Chromium (the well-supported engine), then Firefox.
  const projectChromium = findProjectBrowser("chromium");
  if (projectChromium) return adopt("chromium", projectChromium);

  const systemChromium = findSystemBrowser(os.platform());
  if (systemChromium) return adopt("chromium", systemChromium);

  const projectFirefox = findProjectBrowser("firefox");
  if (projectFirefox) return adopt("firefox", projectFirefox);

  const systemFirefox = findSystemFirefox(os.platform());
  if (systemFirefox) return adopt("firefox", systemFirefox);

  if (hasBundledBrowser()) {
    logger.info("Browser: using Puppeteer's bundled Chromium");
    return { engine: "chromium", executablePath: undefined };
  }

  const err = new Error(
    [
      "No browser found (Chromium or Firefox).",
      "",
      "Fix it in any of these ways:",
      "  1. Set BROWSER_EXECUTABLE_PATH in .env",
      "  2. Put a browser in browser-bin/<name>/",
      "  3. Install Chrome/Chromium/Edge/Brave or Firefox",
    ].join("\n"),
  );
  err.fatal = true;
  throw err;
}

module.exports = {
  resolveBrowser,
  resolveChromiumPath,
  resolveFirefoxPath,
  detectEngineFromPath,
  cleanProfileLocks,
  isExecutable,
};
