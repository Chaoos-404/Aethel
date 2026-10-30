import path from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import {
  describeConflict,
  resolveConflict,
  runSyncCycle,
} from "../core/auto-sync.js";
import { watchWorkspace } from "../core/workspace-watch.js";
import { scrollWindow, truncate } from "./layout.js";

const h = React.createElement;

export const INTERVALS_SEC = [15, 30, 60, 120, 300];
const DEFAULT_INTERVAL_SEC = 60;
const MAX_LOG_LINES = 200;
// Debounce for local edits, and how long to ignore the watcher after a cycle
// so the files that cycle wrote are not mistaken for new edits.
const LOCAL_CHANGE_DEBOUNCE_MS = 2000;
const SELF_WRITE_QUIET_MS = 2500;

const CHOICE_LABEL = { local: "keep local", remote: "keep remote", both: "keep both" };
const CHOICE_KEY = { l: "local", r: "remote", b: "both" };
const LEVEL_STYLE = {
  ok: { icon: "✔", color: "green" },
  warn: { icon: "!", color: "yellow" },
  error: { icon: "✖", color: "red" },
  info: { icon: "·", color: undefined },
};

export function formatClock(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  let value = bytes;
  for (const unit of ["KB", "MB", "GB"]) {
    value /= 1024;
    if (value < 1024) {
      return `${value.toFixed(1)} ${unit}`;
    }
  }
  return `${(value / 1024).toFixed(1)} TB`;
}

/** "Local  3 B  2026-01-01 10:00  md5 ab12cd34", or that the side is gone. */
export function describeSideLine(label, side) {
  if (!side.present) {
    return `${label}  deleted`;
  }

  const parts = [
    side.isFolder ? "folder" : side.size === null ? "?" : formatSize(side.size),
    side.modifiedTime ? side.modifiedTime.replace("T", " ").slice(0, 16) : "?",
  ];
  if (side.md5) {
    parts.push(`md5 ${side.md5.slice(0, 8)}`);
  }
  return `${label}  ${parts.join("  ")}`;
}

/**
 * Turn a finished cycle into activity-log lines.
 *
 * @param {object} outcome            Result of runSyncCycle()
 * @param {number} previousConflicts  Conflicts the last cycle reported
 */
export function outcomeLogLines(outcome, previousConflicts = 0) {
  if (outcome.skipped === "no-baseline") {
    return [
      {
        level: "warn",
        text: "No baseline yet. Run `aethel pull --all` (or `aethel add -A` and `aethel commit`) once, then auto-sync can take over.",
      },
    ];
  }

  const lines = [];
  if (outcome.pulled || outcome.pushed) {
    lines.push({
      level: outcome.errors.length ? "warn" : "ok",
      text: `↓${outcome.pulled} ↑${outcome.pushed}${outcome.summary ? `  ${outcome.summary}` : ""}`,
    });
  }
  for (const error of outcome.errors) {
    lines.push({ level: "error", text: error });
  }
  if (outcome.conflicts.length > previousConflicts) {
    lines.push({
      level: "warn",
      text: `${outcome.conflicts.length} conflict(s) need a decision`,
    });
  }
  if (outcome.held) {
    lines.push({ level: "info", text: `${outcome.held} change(s) wait on conflicts` });
  }
  if (outcome.packConflicts) {
    lines.push({
      level: "warn",
      text: `${outcome.packConflicts} pack conflict(s): use \`aethel resolve\``,
    });
  }
  return lines;
}

function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Split `text` into rows of at most `width` characters, breaking on spaces where possible. */
export function wrapText(text, width) {
  const size = Math.max(width, 1);
  const rows = [];
  let rest = String(text);
  while (rest.length > size) {
    const breakAt = rest.lastIndexOf(" ", size);
    const cut = breakAt > 0 ? breakAt : size;
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  rows.push(rest);
  return rows;
}

/** Log entries as display rows; a long message continues on indented rows. */
function logRows(log, width) {
  const rows = [];
  for (const entry of log) {
    const style = LEVEL_STYLE[entry.level] || LEVEL_STYLE.info;
    const prefix = `${formatClock(entry.at)} ${style.icon} `;
    const indent = " ".repeat(prefix.length);
    wrapText(entry.text, width - prefix.length).forEach((row, index) => {
      rows.push({
        key: `${entry.id}-${index}`,
        color: style.color,
        text: `${index === 0 ? prefix : indent}${row}`,
      });
    });
  }
  return rows;
}

function renderActivity({ log, width, height }) {
  const bodyHeight = Math.max(height - 3, 1);
  const rows = logRows(log, width - 4);
  return h(
    Box,
    {
      width,
      height,
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1,
      flexDirection: "column",
    },
    h(Text, { bold: true }, "Activity"),
    ...(rows.length
      ? rows.slice(-bodyHeight).map((row) =>
          h(Text, { key: row.key, color: row.color, wrap: "truncate-end" }, row.text)
        )
      : [h(Text, { key: "empty", dimColor: true }, "Waiting for the first sync...")])
  );
}

function renderConflictPanel({ conflicts, cursor, width, height }) {
  const innerWidth = width - 4;
  const hasConflicts = conflicts.length > 0;
  const detail = hasConflicts ? describeConflict(conflicts[cursor] || conflicts[0]) : null;
  // Borders (2), title (1) and the detail block (blank, kind, local, Drive and
  // up to two lines of choices) take the rest of the panel.
  const listHeight = Math.max(Math.min(conflicts.length, height - 9), 1);
  const start = scrollWindow(conflicts.length, cursor, listHeight);

  const choiceLine = detail
    ? ["local", "remote", "both"].map((choice) => {
        const key = choice[0];
        const available = detail.choices.includes(choice);
        return h(
          Text,
          { key: choice, dimColor: !available, color: available ? "cyan" : undefined },
          `[${key}] ${CHOICE_LABEL[choice]}  `
        );
      })
    : null;

  return h(
    Box,
    {
      width,
      height,
      borderStyle: "round",
      borderColor: hasConflicts ? "yellow" : "green",
      paddingX: 1,
      flexDirection: "column",
    },
    h(
      Text,
      { bold: true, color: hasConflicts ? "yellow" : "green" },
      `Conflicts (${conflicts.length})`
    ),
    ...(hasConflicts
      ? conflicts.slice(start, start + listHeight).map((conflict, index) =>
          h(
            Text,
            {
              key: conflict.path,
              inverse: start + index === cursor,
              wrap: "truncate-end",
            },
            truncate(`!! ${conflict.path}`, innerWidth)
          )
        )
      : [
          h(
            Text,
            { key: "none", dimColor: true, wrap: "truncate-end" },
            truncate("Nothing to resolve. One-sided changes sync on their own.", innerWidth)
          ),
        ]),
    detail
      ? h(
          Box,
          { flexDirection: "column", marginTop: 1 },
          h(Text, { color: "yellow", wrap: "truncate-end" }, truncate(detail.kind, innerWidth)),
          h(Text, { wrap: "truncate-end" }, truncate(describeSideLine("Local ", detail.local), innerWidth)),
          h(Text, { wrap: "truncate-end" }, truncate(describeSideLine("Drive ", detail.remote), innerWidth)),
          h(Box, { flexWrap: "wrap" }, ...choiceLine)
        )
      : null
  );
}

/**
 * Full-screen panel that keeps a workspace in sync and surfaces the files
 * that changed on both sides, so each can be resolved without leaving the TUI.
 *
 * @param {object} props
 * @param {import("../core/repository.js").Repository} props.repo  Workspace repository
 * @param {() => void} props.onClose
 * @param {number} props.width
 * @param {number} props.height
 * @param {boolean} [props.autoStart]     Begin syncing as soon as the panel opens
 * @param {boolean} [props.watchLocal]    Sync shortly after local files change
 * @param {number} [props.intervalSec]    Initial polling interval for Drive changes
 * @param {typeof runSyncCycle} [props.runCycle]  Injected for tests
 */
export function SyncView({
  repo,
  onClose,
  width,
  height,
  autoStart = true,
  watchLocal = true,
  intervalSec: initialIntervalSec = DEFAULT_INTERVAL_SEC,
  runCycle = runSyncCycle,
}) {
  const [auto, setAuto] = useState(autoStart);
  const [intervalSec, setIntervalSec] = useState(initialIntervalSec);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [log, setLog] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [totals, setTotals] = useState({ pulled: 0, pushed: 0 });
  const [notice, setNotice] = useState("");
  const [confirmChoice, setConfirmChoice] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const autoRef = useLatest(auto);
  const intervalRef = useLatest(intervalSec);
  const conflictsRef = useLatest(conflicts);
  const startCycleRef = useRef(null);
  const runningRef = useRef(false);
  const queuedRef = useRef(null);
  const mountedRef = useRef(true);
  const nextAtRef = useRef(Date.now());
  const quietUntilRef = useRef(0);
  const logIdRef = useRef(0);
  const lastQuietRef = useRef(false);

  function addLog(level, text) {
    logIdRef.current += 1;
    const entry = { id: logIdRef.current, at: new Date(), level, text };
    setLog((current) => [...current, entry].slice(-MAX_LOG_LINES));
  }

  async function startCycle(reason) {
    if (runningRef.current) {
      queuedRef.current = reason;
      return;
    }

    runningRef.current = true;
    setRunning(true);
    setNotice("");
    setPhase("Scanning local files and Drive...");
    const previousConflicts = conflictsRef.current.length;

    try {
      const outcome = await runCycle(repo, {
        onPhase: (next) =>
          setPhase(next === "scan" ? "Scanning local files and Drive..." : "Applying changes..."),
        progress: (done, total, verb, name) => setProgress({ done, total, verb, name }),
      });
      if (!mountedRef.current) return;

      setConflicts(outcome.conflicts);
      setTotals((current) => ({
        pulled: current.pulled + outcome.pulled,
        pushed: current.pushed + outcome.pushed,
      }));
      setLastRun({ at: new Date(), ok: outcome.errors.length === 0 && !outcome.skipped });

      const lines = outcomeLogLines(outcome, previousConflicts);
      if (lines.length) {
        lastQuietRef.current = false;
        for (const line of lines) addLog(line.level, line.text);
      } else if (!lastQuietRef.current) {
        // Say "up to date" once, not on every poll.
        lastQuietRef.current = true;
        addLog("info", `Up to date (${reason})`);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      lastQuietRef.current = false;
      setLastRun({ at: new Date(), ok: false });
      addLog("error", `Sync failed: ${error.message}`);
    } finally {
      runningRef.current = false;
      quietUntilRef.current = Date.now() + SELF_WRITE_QUIET_MS;
      nextAtRef.current = Date.now() + intervalRef.current * 1000;
      if (mountedRef.current) {
        setRunning(false);
        setProgress(null);
        setPhase("");
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued) void startCycleRef.current(queued);
      }
    }
  }
  startCycleRef.current = startCycle;

  useEffect(() => {
    mountedRef.current = true;
    if (autoRef.current) {
      void startCycleRef.current("opened");
    }
    const timer = setInterval(() => {
      setNow(Date.now());
      if (
        autoRef.current &&
        !runningRef.current &&
        Date.now() >= nextAtRef.current
      ) {
        void startCycleRef.current("scheduled");
      }
    }, 1000);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!watchLocal || !repo.root) {
      return undefined;
    }

    let debounce = null;
    let watcher = null;
    const onChange = () => {
      if (!autoRef.current || Date.now() < quietUntilRef.current) return;
      clearTimeout(debounce);
      debounce = setTimeout(
        () => void startCycleRef.current("local change"),
        LOCAL_CHANGE_DEBOUNCE_MS
      );
    };

    try {
      watcher = watchWorkspace(repo.root, onChange);
      if (watcher.truncated) {
        addLog("info", `Watching ${watcher.watched} folders; polling covers the rest`);
      }
    } catch {
      // No file watching here: the polling interval still picks changes up.
    }

    return () => {
      clearTimeout(debounce);
      watcher?.close();
    };
  }, [repo.root, watchLocal]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(conflicts.length - 1, 0)));
  }, [conflicts.length]);

  function resolveOne(choice) {
    const conflict = conflicts[cursor];
    if (!conflict) {
      setNotice("No conflict is selected.");
      return;
    }
    if (runningRef.current) {
      setNotice("A sync is running. Try again when it finishes.");
      return;
    }

    try {
      resolveConflict(repo, conflict, choice);
    } catch (error) {
      setNotice(error.message);
      return;
    }

    setConflicts((current) => current.filter((entry) => entry.path !== conflict.path));
    addLog("info", `${CHOICE_LABEL[choice]}: ${conflict.path}`);
    void startCycleRef.current("resolved conflict");
  }

  function resolveAll(choice) {
    if (runningRef.current) {
      setNotice("A sync is running. Try again when it finishes.");
      return;
    }

    const pending = conflictsRef.current;
    const resolved = new Set();
    let firstError = "";
    for (const conflict of pending) {
      try {
        resolveConflict(repo, conflict, choice);
        resolved.add(conflict.path);
      } catch (error) {
        firstError ||= error.message;
      }
    }

    setConflicts(pending.filter((entry) => !resolved.has(entry.path)));
    if (resolved.size) {
      addLog("info", `${CHOICE_LABEL[choice]}: ${resolved.size} conflict(s)`);
      void startCycleRef.current("resolved conflicts");
    }
    if (resolved.size < pending.length) {
      setNotice(`Skipped ${pending.length - resolved.size}: ${firstError}`);
    }
  }

  useInput((input, key) => {
    if (key.ctrl) {
      return;
    }

    if (confirmChoice) {
      if (input === "y" || input === "Y") {
        const choice = confirmChoice;
        setConfirmChoice(null);
        resolveAll(choice);
      } else if (input === "n" || input === "N" || key.escape) {
        setConfirmChoice(null);
        setNotice("Cancelled.");
      }
      return;
    }

    setNotice("");

    if (key.escape || input === "q" || input === "Q") {
      if (runningRef.current) {
        setNotice("A sync is running. Close the panel when it finishes.");
        return;
      }
      onClose();
      return;
    }

    if (input === "s") {
      void startCycleRef.current("manual");
      return;
    }

    if (input === "p" || input === "P") {
      const next = !autoRef.current;
      setAuto(next);
      if (next) {
        nextAtRef.current = Date.now();
      }
      addLog("info", next ? "Auto-sync resumed" : "Auto-sync paused");
      return;
    }

    if (input === "+" || input === "=" || input === "-") {
      const index = INTERVALS_SEC.indexOf(intervalRef.current);
      const base = index === -1 ? INTERVALS_SEC.indexOf(DEFAULT_INTERVAL_SEC) : index;
      const nextIndex = Math.min(
        Math.max(base + (input === "-" ? -1 : 1), 0),
        INTERVALS_SEC.length - 1
      );
      setIntervalSec(INTERVALS_SEC[nextIndex]);
      nextAtRef.current = Date.now() + INTERVALS_SEC[nextIndex] * 1000;
      return;
    }

    if (key.upArrow || input === "k") {
      setCursor((current) => Math.max(current - 1, 0));
      return;
    }

    if (key.downArrow || input === "j") {
      setCursor((current) => Math.min(current + 1, Math.max(conflicts.length - 1, 0)));
      return;
    }

    if (CHOICE_KEY[input]) {
      resolveOne(CHOICE_KEY[input]);
      return;
    }

    const bulkChoice = CHOICE_KEY[input.toLowerCase()];
    if (bulkChoice) {
      if (conflicts.length === 0) {
        setNotice("No conflicts to resolve.");
        return;
      }
      setConfirmChoice(bulkChoice);
    }
  });

  const workspaceName = repo.root ? path.basename(repo.root) : "";
  const secondsLeft = Math.max(Math.ceil((nextAtRef.current - now) / 1000), 0);
  const bodyHeight = Math.max(height - 5, 8);
  const leftWidth = Math.max(Math.floor(width * 0.42), 24);
  const rightWidth = Math.max(width - leftWidth, 30);

  const modeLabel = auto ? `AUTO every ${intervalSec}s` : "PAUSED";
  let statusLine;
  if (running) {
    const working = progress
      ? `[${progress.done}/${progress.total}] ${progress.verb} ${progress.name}`
      : phase;
    statusLine = h(
      Text,
      { color: "cyan", wrap: "truncate-end" },
      h(Spinner, { type: "dots" }),
      truncate(` ${working}${notice ? `  |  ${notice}` : ""}`, width - 3)
    );
  } else {
    const last = lastRun
      ? `last sync ${formatClock(lastRun.at)} ${lastRun.ok ? "ok" : "had problems"}`
      : "not synced yet";
    const next = auto ? `next in ${secondsLeft}s` : "paused";
    statusLine = h(
      Text,
      { dimColor: !notice, color: notice ? "yellow" : undefined, wrap: "truncate-end" },
      truncate(
        notice || `${last}  |  ${next}  |  session: ↓${totals.pulled} ↑${totals.pushed}`,
        width
      )
    );
  }

  let hints = "s:sync  p:pause  -/+:interval  j/k:select  l/r/b:keep local/remote/both  L/R/B:all  Esc:back";
  if (confirmChoice) {
    hints = `${CHOICE_LABEL[confirmChoice]} for all ${conflicts.length} conflict(s)?  y:yes  n:no`;
  }

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { justifyContent: "space-between" },
      h(
        Text,
        { color: "cyan", bold: true },
        truncate(`Aethel Sync  ${workspaceName}`, width - modeLabel.length - 3)
      ),
      h(Text, { color: auto ? "green" : "yellow", bold: true }, `● ${modeLabel}`)
    ),
    statusLine,
    h(
      Box,
      { flexDirection: "row" },
      renderActivity({ log, width: leftWidth, height: bodyHeight }),
      renderConflictPanel({
        conflicts,
        cursor,
        width: rightWidth,
        height: bodyHeight,
      })
    ),
    h(
      Text,
      { color: confirmChoice ? "yellow" : undefined, dimColor: !confirmChoice },
      truncate(hints, width)
    )
  );
}
