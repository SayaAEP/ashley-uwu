/**
 * Ashley UwU — Console Logger
 * Color-coded output with timestamps and spinner support.
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function formatTag(tag, color) {
  return `${colors.gray}[${colors.reset}${color}${tag}${colors.reset}${colors.gray}]${colors.reset}`;
}

// ─── Spinner ───────────────────────────────────────────────
let _spinnerText = null;
let _spinnerInterval = null;
const _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let _spinnerIdx = 0;

function clearLine() {
  process.stdout.write('\r\x1b[K');
}

function drawSpinner() {
  if (!_spinnerText) return;
  process.stdout.write(`\r  ${_spinnerFrames[_spinnerIdx++ % _spinnerFrames.length]} ${_spinnerText}`);
}

function beforeLog() {
  if (_spinnerText) clearLine();
}

function afterLog() {
  if (_spinnerText) drawSpinner();
}

// ─── Logger ────────────────────────────────────────────────
const logger = {
  debug(message, ...args) {
    if (!require('../config').debug) return;
    beforeLog();
    console.log(
      `${colors.gray}${timestamp()}${colors.reset} ${formatTag('DEBG', colors.yellow)} ${colors.yellow}${message}${colors.reset}`,
      ...args
    );
    afterLog();
  },

  info(message, ...args) {
    beforeLog();
    console.log(
      `${colors.gray}${timestamp()}${colors.reset} ${formatTag('INFO', colors.cyan)} ${message}`,
      ...args
    );
    afterLog();
  },

  success(message, ...args) {
    beforeLog();
    console.log(
      `${colors.gray}${timestamp()}${colors.reset} ${formatTag(' OK ', colors.green)} ${colors.green}${message}${colors.reset}`,
      ...args
    );
    afterLog();
  },

  warn(message, ...args) {
    beforeLog();
    console.warn(
      `${colors.gray}${timestamp()}${colors.reset} ${formatTag('WARN', colors.yellow)} ${colors.yellow}${message}${colors.reset}`,
      ...args
    );
    afterLog();
  },

  error(message, ...args) {
    beforeLog();
    console.error(
      `${colors.gray}${timestamp()}${colors.reset} ${formatTag('ERR!', colors.red)} ${colors.red}${message}${colors.reset}`
    );
    if (args.length > 0) {
      args.forEach(arg => {
        if (arg instanceof Error) {
          console.error(`${colors.red}${arg.stack || arg.message}${colors.reset}`);
        } else {
          console.error(arg);
        }
      });
    }
    afterLog();
  },

  bot(message, ...args) {
    beforeLog();
    console.log(
      `${colors.gray}${timestamp()}${colors.reset} ${formatTag(' BOT', colors.magenta)} ${colors.magenta}${message}${colors.reset}`,
      ...args
    );
    afterLog();
  },

  startSpinner(text) {
    _spinnerText = text;
    _spinnerIdx = 0;
    _spinnerInterval = setInterval(() => drawSpinner(), 100);
    drawSpinner();
  },

  stopSpinner() {
    clearInterval(_spinnerInterval);
    _spinnerInterval = null;
    _spinnerText = null;
    clearLine();
  },
};

module.exports = logger;
