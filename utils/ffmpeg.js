/**
 * FFmpeg Path Resolver — auto-detects ffmpeg across Windows, Linux, macOS, Ubuntu Touch.
 *
 * Saves discovered path to .env; config.js stays untouched for clean merges.
 *
 * Priority:
 *   1. .env (FFMPEG_PATH)
 *   2. config.js (ffmpegPath)
 *   3. auto-detect (system install) → saved to .env
 *   4. "ffmpeg" from PATH
 */

const fs = require("fs");
const { execSync } = require("child_process");
const os = require("os");
const logger = require("./logger");
const { getEnv, writeEnvValue } = require("./env");

// Well-known paths to probe on Linux/Unix/Ubuntu Touch
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
 *
 * On Windows X_OK is ignored; we check file existence first.
 */
function isExecutable(p) {
  if (!p || typeof p !== "string") return false;

  try {
    if (!fs.statSync(p).isFile()) return false;
  } catch {
    return false;
  }

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

// ─── Env Writer ────────────────────────────────────────────────

/**
 * Save the discovered FFmpeg path to `.env`.
 *
 * Only the local .env is written — config.js stays clean for merges.
 *
 * @param {string} execPath
 */
function writeFFmpegPathToEnv(execPath) {
  const ok = writeEnvValue("FFMPEG_PATH", execPath);
  if (ok) {
    logger.success(`Saved FFMPEG_PATH to .env → ${execPath}`);
  } else {
    logger.warn("Could not write FFMPEG_PATH to .env");
    logger.warn("Set it manually in .env");
  }
}

/**
 * Resolve FFmpeg executable path.
 *
 * Priority:
 *   1. .env (FFMPEG_PATH)
 *   2. config.js (ffmpegPath)
 *   3. auto-detect → system install, written to .env
 *   4. "ffmpeg" from PATH
 *
 * @param {object} config
 * @returns {string} resolved path or "ffmpeg" fallback
 */
function resolveFFmpegPath(config) {
  // 1. .env — highest priority (machine-specific, git-ignored)
  const envPath = getEnv("FFMPEG_PATH");
  if (envPath) {
    if (isExecutable(envPath)) {
      logger.info(`FFmpeg: using path from .env → ${envPath}`);
      config.ffmpegPath = envPath;
      return envPath;
    }
    logger.warn(`FFMPEG_PATH in .env not found: ${envPath}`);
  }

  // 2. config.js — committed default, safe to merge
  if (config.ffmpegPath) {
    if (isExecutable(config.ffmpegPath)) {
      logger.info(`FFmpeg: using configured path → ${config.ffmpegPath}`);
      return config.ffmpegPath;
    }
    logger.warn(`Configured ffmpegPath not found: ${config.ffmpegPath}`);
  }

  // 3. Auto-detect
  const found = findSystemFFmpeg();
  if (found) {
    logger.success(`FFmpeg: detected system binary → ${found}`);
    writeFFmpegPathToEnv(found);
    config.ffmpegPath = found;
    return found;
  }

  // 4. Fallback check if 'ffmpeg' is globally accessible in PATH
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
