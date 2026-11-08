/**
 * FFmpeg runner — private helper for the media toolkit.
 *
 * Runs FFmpeg with an argument array (never a shell string). stdout/stderr are
 * redirected to temporary files instead of pipes so the process also works in
 * sandboxed/restricted environments where pipe creation is blocked.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const config = require("../../config");

const DEFAULT_TIMEOUT_MS = 120_000;
const LOG_TAIL_BYTES = 4000;

/** Absolute FFmpeg path resolved at boot, or the PATH fallback. */
function binary() {
  return config.ffmpegPath || "ffmpeg";
}

function readLogTail(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.length > LOG_TAIL_BYTES
      ? content.slice(-LOG_TAIL_BYTES)
      : content;
  } catch {
    return "";
  }
}

/**
 * Run FFmpeg.
 *
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function run(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ashley-ffmpeg-"));
  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");

  let stdoutFd;
  let stderrFd;
  let stdout = "";
  let stderr = "";

  try {
    stdoutFd = fs.openSync(stdoutPath, "w");
    stderrFd = fs.openSync(stderrPath, "w");

    await new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const child = spawn(binary(), args, {
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      if (timer.unref) timer.unref();

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      child.once("error", (err) => finish(reject, err));

      child.once("close", (code, signal) => {
        if (code === 0 && !timedOut) {
          finish(resolve);
          return;
        }

        const detail = timedOut
          ? `FFmpeg timed out after ${timeoutMs}ms`
          : `FFmpeg exited with code ${code}${signal ? ` (${signal})` : ""}`;

        const err = new Error(detail);
        err.code = timedOut ? "FFMPEG_TIMEOUT" : "FFMPEG_EXIT";
        err.exitCode = code;
        err.signal = signal;
        finish(reject, err);
      });
    });

    stdout = readLogTail(stdoutPath);
    stderr = readLogTail(stderrPath);
  } catch (err) {
    err.stdout = readLogTail(stdoutPath);
    err.stderr = readLogTail(stderrPath);
    throw err;
  } finally {
    if (stdoutFd !== undefined) {
      try {
        fs.closeSync(stdoutFd);
      } catch {
        // Already closed.
      }
    }
    if (stderrFd !== undefined) {
      try {
        fs.closeSync(stderrFd);
      } catch {
        // Already closed.
      }
    }

    await fsp.rm(logDir, { recursive: true, force: true }).catch(() => {});
  }

  return { stdout, stderr };
}

/**
 * Create a temp directory, run `fn(dir)`, then always remove the directory.
 *
 * @template T
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ashley-media-"));

  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { binary, run, withTempDir, DEFAULT_TIMEOUT_MS };
