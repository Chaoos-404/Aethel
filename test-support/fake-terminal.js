import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { render } from "ink";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Render an Ink tree on a fake TTY. `frame()` is the latest screen with colour
 * codes stripped, `press()` types one keystroke, and `waitFor()` polls the
 * screen until a condition holds.
 */
export function mountInTerminal(t, tree, { columns = 110, rows = 30 } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = rows;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  let latest = "";
  stdout.on("data", (chunk) => {
    latest = chunk.toString().replace(ANSI, "");
  });

  const instance = render(tree, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  t.after(() => instance.unmount());

  return {
    frame: () => latest,
    // One keystroke per write, as a terminal delivers them; Ink would read
    // "jr" written in one go as a single input.
    async press(keys) {
      stdin.write(keys);
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
    async waitFor(predicate, message) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (predicate(latest)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`${message}\n--- last frame ---\n${latest}`);
    },
  };
}
