/**
 * Lightweight terminal progress indicators (spinner + bar).
 * Writes to stderr so stdout stays clean for piped output.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;
const BAR_WIDTH = 25;

const isTTY = process.stderr.isTTY;

function clearLine() {
  if (isTTY) process.stderr.write("\r\x1b[K");
}

export function createSpinner(message) {
  if (!isTTY) {
    process.stderr.write(`${message}\n`);
    return {
      update() {},
      succeed(msg) { if (msg) process.stderr.write(`${msg}\n`); },
      fail(msg) { if (msg) process.stderr.write(`${msg}\n`); },
      stop() {},
    };
  }

  let frame = 0;
  let currentMessage = message;

  const timer = setInterval(() => {
    clearLine();
    process.stderr.write(`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${currentMessage}`);
    frame++;
  }, SPINNER_INTERVAL);

  return {
    update(msg) { currentMessage = msg; },
    succeed(msg) {
      clearInterval(timer);
      clearLine();
      process.stderr.write(`✔ ${msg || currentMessage}\n`);
    },
    fail(msg) {
      clearInterval(timer);
      clearLine();
      process.stderr.write(`✖ ${msg || currentMessage}\n`);
    },
    stop() {
      clearInterval(timer);
      clearLine();
    },
  };
}

export function createProgressBar(label, total, { stream = process.stderr, now = Date.now } = {}) {
  let lastRendered = -1;
  let lastOutputAt = Number.NEGATIVE_INFINITY;

  function render(current) {
    const processed = Math.max(0, Math.min(current, total));
    if (processed === lastRendered) return;
    const timestamp = now();
    // Piped/scheduled runs still report progress, without one line per file.
    if (!stream.isTTY && processed !== total && timestamp - lastOutputAt < 1000) return;
    lastRendered = processed;
    lastOutputAt = timestamp;
    const ratio = total > 0 ? processed / total : 1;
    const filled = Math.round(BAR_WIDTH * ratio);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const line = `${label} [${bar}] ${processed}/${total} (${Math.round(ratio * 100)}%)`;
    stream.write(stream.isTTY ? `\r\x1b[K${line}` : `${line}\n`);
  }

  render(0);
  return {
    update(current) { render(current); },
    done(msg) {
      render(total);
      stream.write(stream.isTTY ? `\r\x1b[K${msg || label}\n` : `${msg || label}\n`);
    },
  };
}
