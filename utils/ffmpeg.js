/**
 * Ashley UwU — FFmpeg Path Resolver
 *
 * Automatically detects FFmpeg executable across Windows (CMD/PowerShell),
 * Linux (amd64, arm64, Ubuntu Touch), and macOS.
 *
 * Saves discovered path to config.js so subsequent starts skip probing.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");
const logger = require("./logger");

// Well-known paths to probe on Linux / Unix / Ubuntu Touch
const LINUX_FFMPEG_CANDIDATES = [
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/bin/ffmpeg",
  "/usr/sbin/ffmpeg",
  "/system/bin/ffmpeg",
  "/opt/bin/ffmpeg",
  "/snap/bin/ffmpeg",
];

/**
 * Check if a binary at `p` exists and is executable.
 */
function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test running ffmpeg command or querying binary via shell.
 */
function testFfmpegCommand(cmd) {
  try {
    const logger = require("./logger");
    logger.debug(`Testing FFmpeg command: ${cmd}`);
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find FFmpeg system path.
 */
function findSystemFFmpeg() {
  const platform = os.platform();

  if (platform === "win32") {
    // Try where command (works in CMD, PowerShell, PWSH)
    try {
      const result = execSync("where ffmpeg", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      if (result) {
        const firstLine = result.split(/\r?\n/)[0].trim();
        if (firstLine && isExecutable(firstLine)) {
          return firstLine;
        }
      }
    } catch {}

    // Fallback common windows locations if where fails
    const winCandidates = [
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
      "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
      "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe"
    ];
    for (const c of winCandidates) {
      if (isExecutable(c)) return c;
    }
    return null;
  }

  // Linux / macOS / Ubuntu Touch
  // 1. Try 'which ffmpeg'
  try {
    const whichRes = execSync("which ffmpeg", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (whichRes && isExecutable(whichRes)) {
      return whichRes;
    }
  } catch {}

  // 2. Probe well known candidate paths
  for (const candidate of LINUX_FFMPEG_CANDIDATES) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ─── Config Writer ──────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, "..", "config.js");

function writeFFmpegPathToConfig(execPath) {
  try {
    const logger = require("./logger");
    let content = fs.readFileSync(CONFIG_PATH, "utf8");
    const dateStamp = new Date().toISOString();
    const newLine = `    ffmpegPath: "${execPath.replace(/\\/g, "/")}",`;

    const activeRe = /^(\s*)ffmpegPath:\s*".*",?/m;
    const commentedRe = /^(\s*)\/\/\s*ffmpegPath:.*$/m;

    if (activeRe.test(content)) {
      content = content.replace(activeRe, newLine);
    } else if (commentedRe.test(content)) {
      content = content.replace(
        commentedRe,
        `    // Auto-detected on ${dateStamp}\n${newLine}`,
      );
    } else {
      // Inject after puppeteerExecutablePath or authStrategy
      const anchor = /^(\s*puppeteerExecutablePath:\s*".*",?|\s*authStrategy:\s*".*",?)$/m;
      if (anchor.test(content)) {
        content = content.replace(
          anchor,
          `$1\n\n    // Auto-detected on ${dateStamp}\n${newLine}`,
        );
      } else {
        content = content.replace(
          /};(\s*)$/,
          `\n    // Auto-detected on ${dateStamp}\n${newLine}\n};$1`,
        );
      }
    }

    fs.writeFileSync(CONFIG_PATH, content, "utf8");
    logger.success(`Saved ffmpegPath to config.js → ${execPath}`);
  } catch (err) {
    logger.warn("Could not write ffmpegPath to config.js:", err.message);
  }
}

/**
 * Resolve FFmpeg executable path.
 *
 * @param {object} config
 * @returns {string} resolved path or "ffmpeg" command fallback
 */
function resolveFFmpegPath(config) {
  // 1. Check config override
  if (config.ffmpegPath) {
    if (isExecutable(config.ffmpegPath)) {
      logger.info(`FFmpeg: using configured path → ${config.ffmpegPath}`);
      return config.ffmpegPath;
    }
    logger.warn(`Configured ffmpegPath not found: ${config.ffmpegPath}`);
  }

  // 2. Auto-detect
  const found = findSystemFFmpeg();
  if (found) {
    logger.success(`FFmpeg: detected system binary → ${found}`);
    writeFFmpegPathToConfig(found);
    config.ffmpegPath = found;
    return found;
  }

  // 3. Fallback check if 'ffmpeg' is globally accessible in PATH
  const isWin = os.platform() === "win32";
  const testCmd = isWin ? "ffmpeg -version" : "ffmpeg -version";
  if (testFfmpegCommand(testCmd)) {
    logger.info("FFmpeg: available in system PATH");
    return "ffmpeg";
  }

  // Not found anywhere
  logger.warn("FFmpeg was not found in your system PATH or common locations.");
  logger.warn("Sticker and media conversion (.sticker / .toimg) will fail!");
  if (isWin) {
    logger.warn("Please install FFmpeg and add it to your Windows System PATH (CMD / PowerShell / PWSH).");
  } else {
    logger.warn("Please install FFmpeg:  sudo apt install ffmpeg  (or check Ubuntu Touch package manager)");
  }

  return config.ffmpegPath || "ffmpeg";
}

module.exports = { resolveFFmpegPath };
