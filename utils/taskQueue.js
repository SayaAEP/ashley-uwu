/**
 * Task Queue — generic FIFO concurrency limiter.
 *
 * This module is intentionally generic: media conversion uses one instance,
 * and future features can create their own without sharing limits. Plugins
 * normally never import this file; they use `utils/media` instead.
 *
 * Usage:
 *   const { createQueue } = require("../utils/taskQueue");
 *   const queue = createQueue({ concurrency: 2, maxPending: 10, name: "media" });
 *   const result = await queue.run(() => heavyWork(), { label: "convert" });
 */

/**
 * @typedef {object} QueueOptions
 * @property {number} [concurrency=1] Maximum number of tasks running at once
 * @property {number} [maxPending=Infinity] Maximum tasks waiting for a slot
 * @property {string} [name="task"] Queue name (shown in stats/logs)
 */

/**
 * Create an independent task queue.
 *
 * @param {QueueOptions} [options]
 * @returns {{ run: Function, stats: Function }}
 */
function createQueue({
  concurrency = 1,
  maxPending = Number.POSITIVE_INFINITY,
  name = "task",
} = {}) {
  const limit = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
  const pendingLimit =
    maxPending === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(Number(maxPending) || 0));

  let active = 0;
  /** @type {{ task: Function, resolve: Function, reject: Function, label: string }[]} */
  const waiting = [];

  function startNext() {
    while (active < limit && waiting.length > 0) {
      const item = waiting.shift();
      active += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          startNext();
        });
    }
  }

  /**
   * Enqueue a task. Rejects immediately with `err.code === "QUEUE_FULL"` when
   * the waiting line is full, so callers can reply to users instead of piling
   * up unbounded memory.
   *
   * @param {Function} task Function returning a promise/value
   * @param {{ label?: string }} [meta]
   * @returns {Promise<*>}
   */
  function run(task, { label = name } = {}) {
    if (typeof task !== "function") {
      return Promise.reject(new TypeError("queue.run(task) requires a function"));
    }

    return new Promise((resolve, reject) => {
      if (waiting.length >= pendingLimit) {
        const err = new Error(`Queue "${name}" is full (${pendingLimit} pending)`);
        err.code = "QUEUE_FULL";
        err.queue = name;
        err.label = label;
        reject(err);
        return;
      }

      waiting.push({ task, resolve, reject, label });
      startNext();
    });
  }

  function stats() {
    return {
      name,
      active,
      queued: waiting.length,
      concurrency: limit,
      maxPending: pendingLimit,
    };
  }

  return { run, stats };
}

module.exports = { createQueue };
