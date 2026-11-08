/**
 * Chromium Path Resolver — resolves the executable for Puppeteer.
 *
 * Uses puppeteer-core (no bundled browser). Priority:
 *   1. .env (PUPPETEER_EXECUTABLE_PATH)
 *   2. config.js (puppeteerExecutablePath)
 *   3. browser-bin/ folder
 *   4. system install
 *
 * Auto-discovered paths are saved to .env (never config.js) to keep merges clean.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");
const logger = require("./logger");
const { getEnv, writeEnvValue } = require("./env");
const { PROJECT_ROOT, resolveProjectPath } = require("./paths");

// Keywords the user explicitly requested
const BROWSER_KEYWORDS = ["chrome", "chromium", "ungoogled-chromium"];

// Well-known paths to probe on Linux (priority order)
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

// Well-known paths to probe on Windows (priority order)
const WINDOWS_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Chromium\\Application\\chrome.exe",
];

// Well-known paths to probe on macOS (priority order)
const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

// Executable names to look for inside browser-bin/ folder
const BROWSER_BIN_NAMES = {
  win32: [
    "chrome.exe",
    "chromium.exe",
    "msedge.exe",
    "brave.exe",
    "headless_shell.exe",
  ],
  linux: [
    "chrome",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "brave-browser",
  ],
  darwin: [
    "Google Chrome",
    "Chromium",
    "Brave Browser",
    "Microsoft Edge",
  ],
};

// Browser names that look valid but aren't usable with whatsapp-web.js
const INCOMPATIBLE_BROWSERS = [
  "firefox",
  "firefox-esr",
  "librewolf",
  "waterfox",
];

// Folder where users can drop their own browser binary
const BROWSER_BIN_DIR = path.join(PROJECT_ROOT, "browser-bin");

// Max depth to search inside browser-bin/<name>/
const BROWSER_BIN_MAX_DEPTH = 3;

/**
 * Check if `p` is a real, readable file.
 *
 * On Windows X_OK is ignored, so we check file existence first.
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

  // The X_OK check only carries meaning on POSIX systems.
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
 * Try `which <name>` for each browser keyword. Returns first hit or null.
 */
function searchViaWhich() {
  for (const keyword of BROWSER_KEYWORDS) {
    try {
      const result = execSync(`which ${keyword}`, { encoding: "utf8" }).trim();
      if (result && isExecutable(result)) {
        return result;
      }
    } catch {
      // `which` returns non-zero when not found — ignore
    }
  }
  return null;
}

/**
 * Probe well-known paths, then fall back to `which`. Returns path or null.
 */
function findSystemChromium() {
  for (const candidate of LINUX_CANDIDATES) {
    if (isExecutable(candidate)) return candidate;
  }
  return searchViaWhich();
}

/**
 * Find a browser in a well-known system location.
 *
 * @param {string} platform  os.platform() value
 * @returns {string|null}
 */
function findSystemBrowser(platform) {
  if (platform === "win32") {
    for (const candidate of WINDOWS_CANDIDATES) {
      if (isExecutable(candidate)) return candidate;
    }
    // LOCALAPPDATA variants (per-user installs)
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const localCandidates = [
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Chromium", "Application", "chrome.exe"),
        path.join(
          localAppData,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        ),
        path.join(
          localAppData,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe",
        ),
      ];
      for (const candidate of localCandidates) {
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  }

  if (platform === "darwin") {
    for (const candidate of MACOS_CANDIDATES) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  return findSystemChromium();
}

// ─── Project-local browser-bin/ scanner ─────────────────────

/**
 * Walk a directory tree looking for a known browser executable.
 *
 * @param {string} dir
 * @param {string[]} names    Executable names to look for
 * @param {number} depth      Remaining recursion depth
 * @returns {string|null}
 */
function findBrowserInDir(dir, names, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // Prefer files sitting directly in this directory.
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!names.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (isExecutable(full)) return full;
  }

  // macOS: also look inside "<App>.app/Contents/MacOS/<name>".
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith(".app")) continue;
    const macosDir = path.join(dir, entry.name, "Contents", "MacOS");
    const found = findBrowserInDir(macosDir, names, 1);
    if (found) return found;
  }

  if (depth <= 0) return null;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findBrowserInDir(path.join(dir, entry.name), names, depth - 1);
    if (found) return found;
  }

  return null;
}

/**
 * Scan the project's browser-bin/ folder for a Chromium-based browser.
 *
 * Users can drop their own binary in, e.g.:
 *   browser-bin/chrome-156/chrome.exe     (Windows)
 *   browser-bin/chromium-140/chrome       (Linux)
 *
 * @returns {string|null}
 */
function findProjectBrowser() {
  if (!fs.existsSync(BROWSER_BIN_DIR)) return null;

  const platform = os.platform();
  const names = BROWSER_BIN_NAMES[platform] || BROWSER_BIN_NAMES.linux;

  // Skip browsers whatsapp-web.js can't drive (Firefox & friends).
  let entries;
  try {
    entries = fs.readdirSync(BROWSER_BIN_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const lower = entry.name.toLowerCase();
    if (INCOMPATIBLE_BROWSERS.some((bad) => lower.includes(bad))) {
      logger.warn(
        `Chromium: skipping browser-bin/${entry.name} — whatsapp-web.js requires a Chromium-based browser (Firefox is not supported).`,
      );
      continue;
    }

    const found = findBrowserInDir(
      path.join(BROWSER_BIN_DIR, entry.name),
      names,
      BROWSER_BIN_MAX_DEPTH,
    );
    if (found) return found;
  }

  return null;
}

/**
 * Does the installed puppeteer package ship a bundled browser?
 *
 * The full `puppeteer` package downloads Chrome on install; `puppeteer-core`
 * does not. This decides whether "no browser found" is fatal or not.
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
 * Save the discovered executable path to `.env`.
 *
 * config.js is left untouched for clean merges — only .env is written.
 *
 * @param {string} execPath
 */
function writePathToEnv(execPath) {
  const ok = writeEnvValue("PUPPETEER_EXECUTABLE_PATH", execPath);
  if (ok) {
    logger.success(`Saved PUPPETEER_EXECUTABLE_PATH to .env → ${execPath}`);
  } else {
    logger.warn("Could not write PUPPETEER_EXECUTABLE_PATH to .env");
    logger.warn("Set it manually in .env");
  }
}

// ─── Stale lock cleanup ─────────────────────────────────────

/**
 * Find and delete stale `SingletonLock` files in the session directory.
 * Prevents Chromium from hanging on startup after crashes or rapid restarts.
 *
 * The caller must already own the instance lock (`utils/sessionLock`), so this
 * never deletes a lock belonging to another live bot process.
 *
 * @param {object} config
 */
function cleanSingletonLock(config) {
  try {
    const absoluteAuthPath = resolveProjectPath(
      config.authDataPath,
      resolveProjectPath(".wwebjs_auth"),
    );
    if (!fs.existsSync(absoluteAuthPath)) return;

    const findAndUnlinkLock = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.lstatSync(fullPath);
        if (stat.isDirectory()) {
          findAndUnlinkLock(fullPath);
        } else if (file === "SingletonLock") {
          logger.info(`Chromium: cleaning up stale lock file → ${fullPath}`);
          fs.unlinkSync(fullPath);
        }
      }
    };
    findAndUnlinkLock(absoluteAuthPath);
  } catch (err) {
    logger.warn(`Chromium lock cleanup warning: ${err.message}`);
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Resolve the Chromium executable path to use.
 *
 * @param {object} config  The loaded config object
 * @returns {string|undefined} Executable path, or undefined for bundled browser
 * @throws {Error} When no browser found and puppeteer-core has no bundled browser
 */
function resolveChromiumPath(config) {
  // Clean up any stale SingletonLocks from previous crashes or rapid restarts
  cleanSingletonLock(config);

  const platform = os.platform();
  const arch = os.arch();
  const attempted = [];

  // 1. .env — highest priority (machine-specific, git-ignored)
  const envPath = getEnv("PUPPETEER_EXECUTABLE_PATH");
  if (envPath) {
    if (isExecutable(envPath)) {
      logger.info(`Chromium: using path from .env → ${envPath}`);
      return envPath;
    }
    logger.warn(`PUPPETEER_EXECUTABLE_PATH in .env not found: ${envPath}`);
    attempted.push(envPath);
  }

  // 2. config.js — committed default, safe to merge.
  //    config.js already merged in the .env value, so skip it when it is the
  //    very same path we just rejected above.
  const configuredPath = config.puppeteerExecutablePath;
  if (configuredPath && configuredPath !== envPath) {
    if (isExecutable(configuredPath)) {
      logger.info(`Chromium: using configured path → ${configuredPath}`);
      return configuredPath;
    }
    // Path was set but is no longer valid — keep searching
    logger.warn(`Configured puppeteerExecutablePath not found: ${configuredPath}`);
    attempted.push(configuredPath);
  }

  // 3. browser-bin/ inside the project folder
  const projectBrowser = findProjectBrowser();
  if (projectBrowser) {
    logger.success(`Chromium: detected browser in browser-bin → ${projectBrowser}`);
    writePathToEnv(projectBrowser);
    config.puppeteerExecutablePath = projectBrowser;
    return projectBrowser;
  }

  // 4. System install
  const systemBrowser = findSystemBrowser(platform);
  if (systemBrowser) {
    logger.success(`Chromium: detected system browser → ${systemBrowser}`);
    writePathToEnv(systemBrowser);
    config.puppeteerExecutablePath = systemBrowser;
    return systemBrowser;
  }

  // 5. Nothing found.
  if (hasBundledBrowser()) {
    logger.info("Chromium: using Puppeteer's bundled browser");
    return undefined;
  }

  // puppeteer-core has no bundled browser — this is fatal.
  if (platform === "linux" && (arch === "arm64" || arch === "arm")) {
    logger.error("No system Chromium/Chrome found on this ARM Linux system.");
  }

  const tried = attempted.length > 0 ? attempted.join(", ") : "(none configured)";

  throw new Error(
    [
      "Puppeteer-core does not include a Chromium browser, and none was found.",
      "",
      "Fix it in any of these ways:",
      "  1. Set PUPPETEER_EXECUTABLE_PATH in .env (copy .env.example to .env)",
      "  2. Set puppeteerExecutablePath in config.js",
      "  3. Put a Chromium binary in browser-bin/<name>/ (e.g. browser-bin/chrome-156/chrome.exe)",
      "  4. Install a browser (Linux ARM: sudo apt install chromium-browser)",
      "",
      `Paths tried: ${tried}`,
    ].join("\n"),
  );
}

module.exports = { resolveChromiumPath, cleanSingletonLock };
