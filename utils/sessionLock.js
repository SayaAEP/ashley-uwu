/**
 * Session Lock — prevents two bot processes from sharing (and corrupting) the
 * same WhatsApp/Chromium profile.
 *
 * The lock file stores the owner PID. A lock whose PID no longer exists is
 * considered stale and is reclaimed automatically.
 */

const fs = require("fs");
const path = require("path");

const LOCK_FILENAME = "instance.lock";

/**
 * Is a process with this PID currently alive?
 *
 * `process.kill(pid, 0)` performs an existence check without sending a signal.
 * On POSIX, EPERM means the process exists but belongs to another user.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * @param {string} lockPath
 * @returns {{ pid?: number, startedAt?: string }|null}
 */
function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the instance lock inside `lockDir`.
 *
 * @param {string} lockDir Folder that owns the lock (usually project root)
 * @returns {{ path: string, release: () => void }}
 * @throws {Error} When another live process already owns the lock
 */
function acquire(lockDir) {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, LOCK_FILENAME);

  // Two attempts: the first may find a stale lock, the second races the
  // reclaim. If the second also sees a live PID, the caller loses cleanly.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(
          fd,
          JSON.stringify(
            { pid: process.pid, startedAt: new Date().toISOString() },
            null,
            2,
          ),
        );
      } finally {
        fs.closeSync(fd);
      }

      return {
        path: lockPath,
        release() {
          try {
            const current = readLock(lockPath);
            // Only remove the lock if it is still ours.
            if (!current || current.pid === process.pid) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Lock already gone — nothing to do.
          }
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw new Error(`Could not create instance lock (${lockPath}): ${err.message}`);
      }

      const owner = readLock(lockPath);
      if (owner && isProcessAlive(owner.pid)) {
        throw new Error(
          [
            "Another Ashley UwU instance is already running.",
            `  PID : ${owner.pid}`,
            `  Lock: ${lockPath}`,
            "Stop the other instance first (or delete the lock file if it is stale).",
          ].join("\n"),
        );
      }

      // Stale lock from a crash — reclaim it.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else removed it first; retry.
      }
    }
  }

  throw new Error(`Could not acquire instance lock: ${lockPath}`);
}

module.exports = { acquire, isProcessAlive, LOCK_FILENAME };
