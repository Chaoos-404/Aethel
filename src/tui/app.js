import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  humanSize,
  iconForMime,
  sourceBadgeForItem,
} from "../core/drive-api.js";
import {
  defaultLocalRoot,
  ensureLocalDirectory,
} from "../core/local-fs.js";
import { COMMAND_CATALOG } from "./command-catalog.js";
import { parseCommandInput } from "./commands.js";
import { scrollWindow, truncate } from "./layout.js";
import { SyncView } from "./sync-view.js";

const h = React.createElement;

function renderRemoteRow(file, isCursor, isSelected, width) {
  const mark = isSelected ? "[x]" : "[ ]";
  const sourceBadge = sourceBadgeForItem(file);
  const icon = iconForMime(file.mimeType || "");
  const size = humanSize(file.size);
  const line = truncate(
    `${mark} ${sourceBadge} ${icon} ${size}  ${file.name}`,
    width
  );

  return h(
    Text,
    {
      key: file.id,
      inverse: isCursor,
      color: isSelected ? "cyan" : undefined,
      bold: isSelected,
      wrap: "truncate-end",
    },
    line
  );
}

function renderLocalRow(entry, isCursor, width) {
  const icon = entry.isDirectory ? "[DIR]" : "[FIL]";
  const line = truncate(`[LOC] ${icon} ${entry.sizeLabel}  ${entry.name}`, width);

  return h(
    Text,
    {
      key: entry.id,
      inverse: isCursor,
      color: entry.isDirectory ? "green" : undefined,
      bold: entry.isDirectory,
      wrap: "truncate-end",
    },
    line
  );
}

function renderPane({
  title,
  breadcrumb,
  focused,
  entries,
  cursor,
  renderer,
  width,
  height,
  emptyMessage,
}) {
  const bodyHeight = Math.max(height - 3, 1);
  const start = scrollWindow(entries.length, cursor, bodyHeight);
  const visibleEntries = entries.slice(start, start + bodyHeight);

  return h(
    Box,
    {
      width,
      flexDirection: "column",
      paddingRight: 1,
    },
    h(
      Text,
      {
        bold: true,
        color: focused ? "cyan" : "white",
      },
      truncate(`${focused ? ">" : " "} ${title}`, width)
    ),
    h(Text, { dimColor: true }, truncate(breadcrumb, width)),
    ...(visibleEntries.length
      ? visibleEntries.map((entry, index) =>
          renderer(entry, start + index === cursor, width)
        )
      : [
          h(
            Text,
            { key: `${title}-empty`, dimColor: true },
            truncate(emptyMessage, width)
          ),
        ])
  );
}

function renderHelp() {
  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      marginTop: 1,
      flexDirection: "column",
    },
    h(Text, { bold: true }, "Keyboard Shortcuts"),
    h(Text, null, ""),
    h(Text, { color: "cyan" }, "Navigation"),
    h(Text, null, "  Tab          Switch panes        Left/Right  Parent / Enter dir"),
    h(Text, null, "  j/k          Move cursor          /          Filter by name"),
    h(Text, null, ""),
    h(Text, { color: "cyan" }, "Local Pane"),
    h(Text, null, "  u  Upload to Drive    s  Sync dir to Drive    U  Upload by path"),
    h(Text, null, "  n  Rename             x  Delete"),
    h(Text, null, ""),
    h(Text, { color: "cyan" }, "Drive Pane"),
    h(Text, null, "  Space  Toggle select   a  Select all    t  Trash    d  Delete"),
    h(Text, null, ""),
    h(Text, { color: "cyan" }, "Sync"),
    h(Text, null, "  w  Auto-sync and conflict panel (needs an Aethel workspace)"),
    h(Text, null, ""),
    h(Text, { color: "cyan" }, "Commands"),
    h(Text, null, "  f  Open command panel             :  Run CLI command directly"),
    h(Text, null, "  r  Reload panes                   q  Quit"),
    h(Text, { dimColor: true }, "Press any key to close.")
  );
}

function renderCommandCatalog(width, height, cursor) {
  const listHeight = Math.max(height - 7, 6);
  const start = scrollWindow(COMMAND_CATALOG.length, cursor, listHeight);
  const visibleEntries = COMMAND_CATALOG.slice(start, start + listHeight);
  const currentEntry = COMMAND_CATALOG[cursor] || null;

  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      flexDirection: "column",
    },
    ...visibleEntries.map((entry, index) =>
      h(
        Text,
        {
          key: entry.name,
          inverse: start + index === cursor,
          color: start + index === cursor ? "cyan" : undefined,
          wrap: "truncate-end",
        },
        truncate(`${entry.name.padEnd(16, " ")} ${entry.description}`, width - 4)
      )
    ),
    currentEntry
      ? h(
          Text,
          { dimColor: true },
          truncate(`> aethel ${currentEntry.template}`, width - 4)
        )
      : null
  );
}

function renderCommandActions(width, height, command, cursor) {
  const actions = [
    ...command.actions,
    { label: "Custom Command", command: command.template },
  ];
  const listHeight = Math.max(height - 8, 5);
  const start = scrollWindow(actions.length, cursor, listHeight);
  const visibleEntries = actions.slice(start, start + listHeight);
  const currentAction = actions[cursor] || null;

  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      flexDirection: "column",
    },
    h(Text, { bold: true }, truncate(`${command.name}`, width - 4)),
    ...visibleEntries.map((entry, index) =>
      h(
        Text,
        {
          key: `${command.name}-${entry.label}`,
          inverse: start + index === cursor,
          color: start + index === cursor ? "cyan" : undefined,
          wrap: "truncate-end",
        },
        truncate(entry.label, width - 4)
      )
    ),
    currentAction
      ? h(
          Text,
          { dimColor: true },
          truncate(`> aethel ${currentAction.command}`, width - 4)
        )
      : null
  );
}

function renderCommandOutput(commandResult, width, height, scroll) {
  const outputLines = commandResult.output
    ? commandResult.output.split(/\r?\n/)
    : ["(no output)"];
  const bodyHeight = Math.max(height - 8, 4);
  const maxScroll = Math.max(outputLines.length - bodyHeight, 0);
  const start = Math.min(scroll, maxScroll);
  const visibleLines = outputLines.slice(start, start + bodyHeight);

  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: commandResult.exitCode === 0 ? "cyan" : "red",
      paddingX: 1,
      marginTop: 1,
      flexDirection: "column",
    },
    h(Text, { bold: true }, truncate(`Command: aethel ${commandResult.command}`, width - 4)),
    h(
      Text,
      { color: commandResult.exitCode === 0 ? "green" : "red" },
      `Exit code: ${commandResult.exitCode}`
    ),
    ...visibleLines.map((line, index) =>
      h(
        Text,
        { key: `${start + index}`, wrap: "truncate-end" },
        truncate(line || " ", width - 4)
      )
    ),
    h(
      Text,
      { dimColor: true },
      truncate("Up/Down/PageUp/PageDown/Home/End: scroll  Enter/Esc: close", width - 4)
    )
  );
}

export function AethelTui({
  repo,
  includeSharedDrives = false,
  cliPath = null,
  cliArgs = [],
  initialView = "browser",
}) {
  const { exit } = useApp();
  const syncAvailable = Boolean(repo.root);
  const [mode, setMode] = useState(
    initialView === "sync" && syncAvailable ? "sync" : "loading"
  );
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [focusPane, setFocusPane] = useState("local");
  const [account, setAccount] = useState(null);
  const [remoteFiles, setRemoteFiles] = useState([]);
  const [remoteFolderStack, setRemoteFolderStack] = useState([]);
  const [localRoot] = useState(defaultLocalRoot);
  const [localDirectory, setLocalDirectory] = useState(defaultLocalRoot);
  const [localEntries, setLocalEntries] = useState([]);
  const [remoteFilter, setRemoteFilter] = useState("");
  const [localFilter, setLocalFilter] = useState("");
  const [remoteCursor, setRemoteCursor] = useState(0);
  const [localCursor, setLocalCursor] = useState(0);
  const [selectedRemoteIds, setSelectedRemoteIds] = useState(() => new Set());
  const [status, setStatus] = useState("Loading account info...");
  const [errorMessage, setErrorMessage] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const [inputValue, setInputValue] = useState("");
  const [commandResult, setCommandResult] = useState(null);
  const [commandScroll, setCommandScroll] = useState(0);
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandActionCursor, setCommandActionCursor] = useState(0);
  const [commandReturnMode, setCommandReturnMode] = useState("normal");
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const currentRemoteFolderId = remoteFolderStack.length
    ? remoteFolderStack[remoteFolderStack.length - 1].id
    : null;
  const currentUploadParentId = currentRemoteFolderId || "root";

  const remoteFolderIds = useMemo(
    () =>
      new Set(
        remoteFiles.filter((file) => file.isFolder).map((file) => file.id)
      ),
    [remoteFiles]
  );

  const currentRemoteDirectoryEntries = useMemo(() => {
    const entries = remoteFiles.filter((file) => {
      if (!currentRemoteFolderId) {
        return (
          file.isRootLevel ||
          !file.parentId ||
          !remoteFolderIds.has(file.parentId)
        );
      }

      return file.parentId === currentRemoteFolderId;
    });

    return entries.sort((left, right) => {
      if (left.isFolder !== right.isFolder) {
        return left.isFolder ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }, [currentRemoteFolderId, remoteFiles, remoteFolderIds]);

  const filteredRemoteEntries = useMemo(() => {
    const query = remoteFilter.trim().toLowerCase();
    if (!query) {
      return currentRemoteDirectoryEntries;
    }

    return currentRemoteDirectoryEntries.filter((file) =>
      file.name.toLowerCase().includes(query)
    );
  }, [currentRemoteDirectoryEntries, remoteFilter]);

  const filteredLocalEntries = useMemo(() => {
    const query = localFilter.trim().toLowerCase();
    if (!query) {
      return localEntries;
    }

    return localEntries.filter((entry) =>
      entry.name.toLowerCase().includes(query)
    );
  }, [localEntries, localFilter]);

  const currentLocalEntry = filteredLocalEntries[localCursor] || null;
  const currentRemoteEntry = filteredRemoteEntries[remoteCursor] || null;
  const currentCatalogCommand = COMMAND_CATALOG[commandCursor] || null;
  const currentRemoteFolderMeta = currentRemoteFolderId
    ? remoteFiles.find((file) => file.id === currentRemoteFolderId) || null
    : null;
  const currentRemoteFolderWritable =
    !currentRemoteFolderMeta ||
    currentRemoteFolderMeta.capabilities?.canAddChildren !== false;

  useEffect(() => {
    setRemoteCursor((current) =>
      Math.min(current, Math.max(filteredRemoteEntries.length - 1, 0))
    );
  }, [filteredRemoteEntries.length]);

  useEffect(() => {
    setLocalCursor((current) =>
      Math.min(current, Math.max(filteredLocalEntries.length - 1, 0))
    );
  }, [filteredLocalEntries.length]);

  useEffect(() => {
    setCommandCursor((current) =>
      Math.min(current, Math.max(COMMAND_CATALOG.length - 1, 0))
    );
  }, []);

  async function loadLocalPane(nextDirectory = localDirectory) {
    const resolvedDirectory = await ensureLocalDirectory(nextDirectory);
    const items = await repo.listLocalEntries(resolvedDirectory);
    setLocalDirectory(resolvedDirectory);
    setLocalEntries(items);
    setLocalCursor(0);
  }

  async function loadAllData(nextStatus = "", preserveRemoteFolder = false) {
    const nextRemoteFolderStack = preserveRemoteFolder ? [...remoteFolderStack] : [];
    setRemoteLoading(true);

    // Load local pane immediately — it's instant (disk I/O only)
    try {
      await loadLocalPane(localDirectory);
      // Switch to normal mode so the user can browse local files while remote loads
      setMode((current) => (current === "sync" ? current : "normal"));
      setStatus("Loading Drive files...");
    } catch (error) {
      setErrorMessage(error.message);
      setMode("error");
      return;
    }

    // Fetch remote in background
    try {
      const [nextAccount, nextRemoteFiles] = await Promise.all([
        repo.getAccountInfo(),
        repo.listRemoteFiles({ includeSharedDrives }),
      ]);
      const remoteIds = new Set(nextRemoteFiles.map((file) => file.id));
      const resolvedRemoteFolderStack = nextRemoteFolderStack.filter((folder) =>
        remoteIds.has(folder.id)
      );

      setAccount(nextAccount);
      setRemoteFiles(nextRemoteFiles);
      setRemoteFolderStack(resolvedRemoteFolderStack);
      setSelectedRemoteIds(new Set());
      setRemoteLoading(false);
      setStatus(
        nextStatus || `Loaded ${nextRemoteFiles.length} Drive item(s). Press ? for help.`
      );
    } catch (error) {
      setRemoteLoading(false);
      setStatus(`Drive load failed: ${error.message}. Local pane is still usable.`);
    }
  }

  useEffect(() => {
    void loadAllData();
  }, []);

  useEffect(() => {
    let refreshTimer = null;
    let disposed = false;
    let watcher = null;

    const refreshLocalPane = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      refreshTimer = setTimeout(() => {
        if (disposed) {
          return;
        }

        loadLocalPane(localDirectory).catch((error) => {
          if (!disposed) {
            setStatus(`Local refresh failed: ${error.message}`);
          }
        });
      }, 100);
    };

    try {
      watcher = fs.watch(localDirectory, { persistent: false }, refreshLocalPane);
    } catch {
      return () => {};
    }

    return () => {
      disposed = true;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      watcher?.close();
    };
  }, [localDirectory, repo]);

  async function executeRemoteDelete(permanent) {
    const targets = remoteFiles.filter((file) => selectedRemoteIds.has(file.id));
    if (targets.length === 0) {
      setStatus("No Drive items selected.");
      return;
    }

    setMode("busy");
    try {
      const result = await repo.batchOperateFiles(targets, {
        permanent,
        includeSharedDrives,
        onProgress: (done, total, verb, name) => {
          setStatus(`[${done}/${total}] ${verb}: ${name}`);
        },
      });
      const targetIds = new Set(targets.map((file) => file.id));

      if (result.errors === 0) {
        setRemoteFiles((current) =>
          current.filter((file) => !targetIds.has(file.id))
        );
        setSelectedRemoteIds(new Set());
      }

      await loadAllData(
        `Done: ${result.success} succeeded, ${result.errors} failed.`,
        true
      );
    } catch (error) {
      setErrorMessage(error.message);
      setMode("error");
    }
  }

  async function executeUpload(targetPath) {
    const trimmedPath = targetPath.trim();
    if (!trimmedPath) {
      setMode("normal");
      setStatus("Upload cancelled.");
      return;
    }

    setMode("busy");
    try {
      const result = await repo.uploadLocalEntry(
        trimmedPath,
        currentUploadParentId,
        (verb, localPath, name) => {
          if (verb === "mkdir") {
            setStatus(`Creating remote directory: ${name}`);
            return;
          }
          setStatus(`Uploading: ${name} (${localPath})`);
        }
      );

      setInputValue("");
      await loadAllData(
        `Uploaded ${result.uploadedFiles} file(s) and ${result.uploadedDirectories} director${result.uploadedDirectories === 1 ? "y" : "ies"}.`,
        true
      );
    } catch (error) {
      setMode("normal");
      setStatus(`Upload failed: ${error.message}`);
    }
  }

  async function executeSyncDirectory(targetPath) {
    setMode("busy");
    try {
      const result = await repo.syncLocalDirectory(
        targetPath,
        currentUploadParentId,
        (verb, localPath, name) => {
          if (verb === "mkdir") {
            setStatus(`Sync mkdir: ${name}`);
            return;
          }
          setStatus(`Sync upload: ${name} (${localPath})`);
        }
      );

      await loadAllData(
        `Synced ${result.uploadedFiles} file(s) and ${result.uploadedDirectories} director${result.uploadedDirectories === 1 ? "y" : "ies"} into current Drive directory.`,
        true
      );
    } catch (error) {
      setMode("normal");
      setStatus(`Sync failed: ${error.message}`);
    }
  }

  async function executeLocalDelete(targetPath) {
    setMode("busy");
    try {
      const deletedPath = await repo.deleteLocalEntry(targetPath);
      setLocalEntries((current) =>
        current.filter((entry) => entry.absolutePath !== deletedPath)
      );
      await loadLocalPane(localDirectory);
      setMode("normal");
      setStatus(`Deleted local entry: ${path.basename(deletedPath)}`);
    } catch (error) {
      setMode("normal");
      setStatus(`Local delete failed: ${error.message}`);
    }
  }

  async function executeLocalRename(targetPath, nextName) {
    setMode("busy");
    try {
      const renamedPath = await repo.renameLocalEntry(targetPath, nextName);
      setLocalEntries((current) =>
        current.map((entry) =>
          entry.absolutePath === path.resolve(targetPath)
            ? {
                ...entry,
                id: renamedPath,
                name: path.basename(renamedPath),
                absolutePath: renamedPath,
              }
            : entry
        )
      );
      await loadLocalPane(path.dirname(renamedPath));
      setMode("normal");
      setStatus(`Renamed local entry to: ${path.basename(renamedPath)}`);
    } catch (error) {
      setMode("normal");
      setStatus(`Local rename failed: ${error.message}`);
    }
  }

  async function openLocalDirectory(nextPath) {
    try {
      await loadLocalPane(nextPath);
      setLocalFilter("");
      setStatus(`Opened local directory: ${path.basename(nextPath) || nextPath}`);
    } catch (error) {
      setStatus(`Local directory error: ${error.message}`);
    }
  }

  function switchFocus() {
    setFocusPane((current) => (current === "local" ? "remote" : "local"));
    setStatus(
      focusPane === "local"
        ? "Switched focus to Drive pane."
        : "Switched focus to Local pane."
    );
  }

  function openCommandEditor(nextValue, returnMode = "normal") {
    setInputValue(nextValue);
    setCommandReturnMode(returnMode);
    setMode("command");
    setStatus("Edit the command and press Enter to run.");
  }

  function openCommandActions(index = commandCursor) {
    setCommandCursor(index);
    setCommandActionCursor(0);
    setMode("command-actions");
    setStatus("Choose a TUI action or edit the command.");
  }

  async function executeCliCommand(rawCommand, returnMode = commandReturnMode) {
    if (!cliPath) {
      setMode("normal");
      setStatus("CLI command runner is unavailable.");
      return;
    }

    setCommandReturnMode(returnMode);

    let args;
    try {
      args = parseCommandInput(rawCommand);
    } catch (error) {
      setMode(returnMode);
      setStatus(error.message);
      return;
    }

    if (args.length === 0) {
      setMode(returnMode);
      setStatus("Command cancelled.");
      return;
    }

    setMode("busy");
    setStatus(`Running: aethel ${args.join(" ")}`);

    const output = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...cliArgs, ...args], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        stderr += `${error.message}\n`;
      });
      child.on("close", (exitCode) => {
        resolve({
          command: args.join(" "),
          exitCode: exitCode ?? 1,
          output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"),
        });
      });
    });

    setInputValue("");
    setCommandResult(output);
    setCommandScroll(
      Math.max(output.output.split(/\r?\n/).length - Math.max(height - 8, 4), 0)
    );

    if (output.exitCode === 0) {
      await loadAllData(`Command finished: aethel ${output.command}`, true);
    } else {
      setStatus(`Command failed: aethel ${output.command}`);
      setMode("normal");
    }

    setMode("command-output");
  }

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || (mode === "error" && input === "q")) {
      exit();
      return;
    }

    if (mode === "loading" || mode === "busy" || mode === "sync") {
      return;
    }

    if (mode === "error") {
      if (key.escape || input === "q" || input === "Q") {
        exit();
      }
      return;
    }

    if (mode === "help") {
      setMode("normal");
      return;
    }

    if (mode === "commands-page") {
      if (key.escape || input === "f" || input === "F") {
        setMode("normal");
        setStatus("Closed commands page.");
        return;
      }

      if (input === ":") {
        openCommandEditor("", "commands-page");
        return;
      }

      if (key.return || key.rightArrow) {
        if (currentCatalogCommand) {
          openCommandActions(commandCursor);
        }
        return;
      }

      if (key.upArrow || input === "k") {
        setCommandCursor((current) => Math.max(current - 1, 0));
        return;
      }

      if (key.downArrow || input === "j") {
        setCommandCursor((current) =>
          Math.min(current + 1, Math.max(COMMAND_CATALOG.length - 1, 0))
        );
        return;
      }

      if (key.pageUp) {
        setCommandCursor((current) =>
          Math.max(current - Math.max(height - 11, 6), 0)
        );
        return;
      }

      if (key.pageDown) {
        setCommandCursor((current) =>
          Math.min(
            current + Math.max(height - 11, 6),
            Math.max(COMMAND_CATALOG.length - 1, 0)
          )
        );
        return;
      }

      if (key.home) {
        setCommandCursor(0);
        return;
      }

      if (key.end) {
        setCommandCursor(Math.max(COMMAND_CATALOG.length - 1, 0));
      }
      return;
    }

    if (mode === "command-actions") {
      if (key.escape || key.leftArrow) {
        setMode("commands-page");
        setStatus("Back to commands list.");
        return;
      }

      if (!currentCatalogCommand) {
        setMode("commands-page");
        return;
      }

      const availableActions = [
        ...currentCatalogCommand.actions,
        { label: "Custom Command", command: currentCatalogCommand.template },
      ];
      const currentAction = availableActions[commandActionCursor] || availableActions[0];

      if (input === "e" || input === "E") {
        openCommandEditor(currentAction.command, "command-actions");
        return;
      }

      if (key.return) {
        if (currentAction.label === "Custom Command") {
          openCommandEditor(currentAction.command, "command-actions");
        } else {
          void executeCliCommand(currentAction.command, "command-actions");
        }
        return;
      }

      if (key.upArrow || input === "k") {
        setCommandActionCursor((current) => Math.max(current - 1, 0));
        return;
      }

      if (key.downArrow || input === "j") {
        setCommandActionCursor((current) =>
          Math.min(current + 1, Math.max(availableActions.length - 1, 0))
        );
        return;
      }

      if (key.pageUp) {
        setCommandActionCursor((current) =>
          Math.max(current - Math.max(height - 12, 5), 0)
        );
        return;
      }

      if (key.pageDown) {
        setCommandActionCursor((current) =>
          Math.min(
            current + Math.max(height - 12, 5),
            Math.max(availableActions.length - 1, 0)
          )
        );
        return;
      }

      if (key.home) {
        setCommandActionCursor(0);
        return;
      }

      if (key.end) {
        setCommandActionCursor(Math.max(availableActions.length - 1, 0));
      }
      return;
    }

    if (mode === "command-output") {
      if (key.escape || key.return || input === "q" || input === "Q") {
        setCommandResult(null);
        setCommandScroll(0);
        setMode(commandReturnMode);
        return;
      }

      if (key.upArrow || input === "k") {
        setCommandScroll((current) => Math.max(current - 1, 0));
        return;
      }

      if (key.downArrow || input === "j") {
        const lines = commandResult?.output?.split(/\r?\n/).length || 1;
        const maxScroll = Math.max(lines - Math.max(height - 8, 4), 0);
        setCommandScroll((current) => Math.min(current + 1, maxScroll));
        return;
      }

      if (key.pageUp) {
        setCommandScroll((current) => Math.max(current - Math.max(height - 8, 4), 0));
        return;
      }

      if (key.pageDown) {
        const lines = commandResult?.output?.split(/\r?\n/).length || 1;
        const maxScroll = Math.max(lines - Math.max(height - 8, 4), 0);
        setCommandScroll((current) =>
          Math.min(current + Math.max(height - 8, 4), maxScroll)
        );
        return;
      }

      if (key.home) {
        setCommandScroll(0);
        return;
      }

      if (key.end) {
        const lines = commandResult?.output?.split(/\r?\n/).length || 1;
        setCommandScroll(Math.max(lines - Math.max(height - 8, 4), 0));
      }
      return;
    }

    if (mode === "confirm") {
      if (input === "y" || input === "Y") {
        const action = pendingAction;
        setPendingAction(null);
        if (!action) {
          setMode("normal");
          return;
        }

        if (action.type === "remote-trash") {
          void executeRemoteDelete(false);
          return;
        }

        if (action.type === "remote-delete") {
          void executeRemoteDelete(true);
          return;
        }

        if (action.type === "local-delete") {
          void executeLocalDelete(action.targetPath);
          return;
        }

        if (action.type === "local-sync") {
          void executeSyncDirectory(action.targetPath);
          return;
        }
      }

      if (input === "n" || input === "N" || key.escape) {
        setPendingAction(null);
        setMode("normal");
        setStatus("Cancelled.");
      }
      return;
    }

    if (mode === "filter") {
      if (key.escape) {
        if (focusPane === "local") {
          setLocalFilter("");
        } else {
          setRemoteFilter("");
        }
        setMode("normal");
        setStatus("Filter cleared.");
        return;
      }

      if (key.return) {
        setMode("normal");
        setStatus("Filter applied.");
        return;
      }

      if (key.backspace || input === "\u007f") {
        if (focusPane === "local") {
          setLocalFilter((current) => current.slice(0, -1));
        } else {
          setRemoteFilter((current) => current.slice(0, -1));
        }
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        if (focusPane === "local") {
          setLocalFilter((current) => current + input);
        } else {
          setRemoteFilter((current) => current + input);
        }
      }
      return;
    }

    if (mode === "upload") {
      if (key.escape) {
        setInputValue("");
        setMode("normal");
        setStatus("Manual upload cancelled.");
      }
      return;
    }

    if (mode === "command") {
      if (key.escape) {
        setInputValue("");
        setMode(commandReturnMode);
        setStatus("Command cancelled.");
      }
      return;
    }

    if (mode === "rename") {
      if (key.escape) {
        setInputValue("");
        setPendingAction(null);
        setMode("normal");
        setStatus("Rename cancelled.");
      }
      return;
    }

    if (input === "q" || input === "Q") {
      exit();
      return;
    }

    if (key.tab || input === "\t") {
      switchFocus();
      return;
    }

    if (input === "?") {
      setMode("help");
      return;
    }

    if (input === "/") {
      setMode("filter");
      setStatus(`Type to filter the ${focusPane} pane.`);
      return;
    }

    if (input === ":") {
      openCommandEditor("", "normal");
      setStatus("Enter an Aethel command without `aethel`.");
      return;
    }

    if (input === "w" || input === "W") {
      if (!syncAvailable) {
        setStatus("Auto-sync needs an Aethel workspace. Run `aethel init` in this directory first.");
        return;
      }
      setMode("sync");
      return;
    }

    if (input === "f" || input === "F") {
      setMode("commands-page");
      setStatus("Browse commands and press Enter to edit one.");
      return;
    }

    if (input === "r" || input === "R") {
      void loadAllData("Reloaded Drive and Local panes.", true);
      return;
    }

    if (key.upArrow || input === "k") {
      if (focusPane === "local") {
        setLocalCursor((current) => Math.max(current - 1, 0));
      } else {
        setRemoteCursor((current) => Math.max(current - 1, 0));
      }
      return;
    }

    if (key.downArrow || input === "j") {
      if (focusPane === "local") {
        setLocalCursor((current) =>
          Math.min(current + 1, Math.max(filteredLocalEntries.length - 1, 0))
        );
      } else {
        setRemoteCursor((current) =>
          Math.min(current + 1, Math.max(filteredRemoteEntries.length - 1, 0))
        );
      }
      return;
    }

    if (key.pageUp) {
      const delta = Math.max(height - 13, 1);
      if (focusPane === "local") {
        setLocalCursor((current) => Math.max(current - delta, 0));
      } else {
        setRemoteCursor((current) => Math.max(current - delta, 0));
      }
      return;
    }

    if (key.pageDown) {
      const delta = Math.max(height - 13, 1);
      if (focusPane === "local") {
        setLocalCursor((current) =>
          Math.min(current + delta, Math.max(filteredLocalEntries.length - 1, 0))
        );
      } else {
        setRemoteCursor((current) =>
          Math.min(current + delta, Math.max(filteredRemoteEntries.length - 1, 0))
        );
      }
      return;
    }

    if (key.home) {
      if (focusPane === "local") {
        setLocalCursor(0);
      } else {
        setRemoteCursor(0);
      }
      return;
    }

    if (key.end) {
      if (focusPane === "local") {
        setLocalCursor(Math.max(filteredLocalEntries.length - 1, 0));
      } else {
        setRemoteCursor(Math.max(filteredRemoteEntries.length - 1, 0));
      }
      return;
    }

    if (key.leftArrow) {
      if (focusPane === "local") {
        if (
          localDirectory === localRoot ||
          localDirectory === path.dirname(localDirectory)
        ) {
          setStatus("Already at the local root directory.");
          return;
        }
        void openLocalDirectory(path.dirname(localDirectory));
        return;
      }

      if (remoteFolderStack.length === 0) {
        setStatus("Already at the Drive root directory.");
        return;
      }

      setRemoteFolderStack((current) => current.slice(0, -1));
      setRemoteCursor(0);
      setRemoteFilter("");
      setStatus("Moved to the parent Drive directory.");
      return;
    }

    if (key.rightArrow) {
      if (focusPane === "local") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }

        if (!currentLocalEntry.isDirectory) {
          setStatus("The selected local item is not a directory.");
          return;
        }

        void openLocalDirectory(currentLocalEntry.absolutePath);
        return;
      }

      if (!currentRemoteEntry) {
        setStatus("No Drive item is selected.");
        return;
      }

      if (!currentRemoteEntry.isFolder) {
        setStatus("The selected Drive item is not a directory.");
        return;
      }

      setRemoteFolderStack((current) => [
        ...current,
        { id: currentRemoteEntry.id, name: currentRemoteEntry.name },
      ]);
      setRemoteCursor(0);
      setRemoteFilter("");
      setStatus(`Entered Drive directory: ${currentRemoteEntry.name}`);
      return;
    }

    if (focusPane === "local") {
      if (input === "u") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }
        if (!currentRemoteFolderWritable) {
          setStatus(
            `Cannot upload into current Drive directory${
              currentRemoteFolderMeta?.name ? `: ${currentRemoteFolderMeta.name}` : ""
            }. This folder does not allow adding children.`
          );
          return;
        }
        void executeUpload(currentLocalEntry.absolutePath);
        return;
      }

      if (input === "s" || input === "S") {
        if (!currentLocalEntry) {
          setStatus("No local directory is selected.");
          return;
        }
        if (!currentLocalEntry.isDirectory) {
          setStatus("Batch sync requires a local directory.");
          return;
        }
        if (!currentRemoteFolderWritable) {
          setStatus(
            `Cannot sync into current Drive directory${
              currentRemoteFolderMeta?.name ? `: ${currentRemoteFolderMeta.name}` : ""
            }. This folder does not allow adding children.`
          );
          return;
        }

        setPendingAction({
          type: "local-sync",
          targetPath: currentLocalEntry.absolutePath,
        });
        setMode("confirm");
        setStatus(
          `Press y to sync contents of ${currentLocalEntry.name} into current Drive directory.`
        );
        return;
      }

      if (input === "n" || input === "N") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }

        setPendingAction({
          type: "local-rename",
          targetPath: currentLocalEntry.absolutePath,
        });
        setInputValue(currentLocalEntry.name);
        setMode("rename");
        setStatus(`Enter a new name for ${currentLocalEntry.name}.`);
        return;
      }

      if (input === "x" || input === "X") {
        if (!currentLocalEntry) {
          setStatus("No local item is selected.");
          return;
        }

        setPendingAction({
          type: "local-delete",
          targetPath: currentLocalEntry.absolutePath,
        });
        setMode("confirm");
        setStatus(
          `Press y to delete local ${currentLocalEntry.isDirectory ? "directory" : "file"} ${currentLocalEntry.name}.`
        );
        return;
      }

      return;
    }

    if (input === " ") {
      if (!currentRemoteEntry) {
        return;
      }

      setSelectedRemoteIds((current) => {
        const next = new Set(current);
        if (next.has(currentRemoteEntry.id)) {
          next.delete(currentRemoteEntry.id);
        } else {
          next.add(currentRemoteEntry.id);
        }
        return next;
      });
      return;
    }

    if (input === "a" || input === "A") {
      const visibleIds = filteredRemoteEntries.map((file) => file.id);
      const allVisibleSelected =
        visibleIds.length > 0 && visibleIds.every((id) => selectedRemoteIds.has(id));

      setSelectedRemoteIds((current) => {
        const next = new Set(current);
        if (allVisibleSelected) {
          for (const id of visibleIds) {
            next.delete(id);
          }
        } else {
          for (const id of visibleIds) {
            next.add(id);
          }
        }
        return next;
      });
      setStatus(
        allVisibleSelected
          ? "Deselected all visible Drive items."
          : `Selected ${visibleIds.length} visible Drive item(s).`
      );
      return;
    }

    if (input === "t" || input === "T") {
      if (selectedRemoteIds.size === 0) {
        setStatus("No Drive items selected.");
        return;
      }

      setPendingAction({ type: "remote-trash" });
      setMode("confirm");
      setStatus(`Press y to trash ${selectedRemoteIds.size} Drive item(s).`);
      return;
    }

    if (input === "d" || input === "D") {
      if (selectedRemoteIds.size === 0) {
        setStatus("No Drive items selected.");
        return;
      }

      setPendingAction({ type: "remote-delete" });
      setMode("confirm");
      setStatus(`Press y to permanently delete ${selectedRemoteIds.size} Drive item(s).`);
      return;
    }

    if (input === "U") {
      if (!currentRemoteFolderWritable) {
        setStatus(
          `Cannot upload into current Drive directory${
            currentRemoteFolderMeta?.name ? `: ${currentRemoteFolderMeta.name}` : ""
          }. This folder does not allow adding children.`
        );
        return;
      }
      setInputValue("");
      setMode("upload");
      setStatus("Enter a local file or directory path to upload.");
    }
  });

  const driveBreadcrumb = remoteFolderStack.length
    ? `Drive: /${remoteFolderStack.map((folder) => folder.name).join("/")}`
    : "Drive: /";
  const localBreadcrumb = `Local: ${localDirectory}`;
  const selectedCount = selectedRemoteIds.size;
  const contentHeight = Math.max(height - 7, 6);
  const paneWidth = Math.max(Math.floor((width - 3) / 2), 24);

  if (mode === "error") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: "red", bold: true }, "Aethel failed to load."),
      h(Text, null, errorMessage || "Unknown error."),
      h(Text, { dimColor: true }, "Press q or Esc to quit.")
    );
  }

  if (mode === "loading") {
    return h(
      Box,
      { flexDirection: "column" },
      h(
        Text,
        { color: "cyan" },
        h(Spinner, { type: "dots" }),
        ` ${status}`
      )
    );
  }

  if (mode === "sync") {
    return h(SyncView, {
      repo,
      width,
      height,
      onClose: () => {
        setMode("normal");
        void loadAllData("Closed auto-sync panel.", true);
      },
    });
  }

  if (mode === "commands-page") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: "cyan", bold: true }, truncate("Aethel Commands", width)),
      h(Text, { dimColor: true }, truncate(status, width)),
      renderCommandCatalog(width, height, commandCursor),
      h(
        Text,
        { dimColor: true },
        truncate("j/k:move  Enter:open  ::custom command  Esc:close", width)
      )
    );
  }

  if (mode === "command-actions" && currentCatalogCommand) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: "cyan", bold: true }, truncate("Aethel Commands", width)),
      h(Text, { dimColor: true }, truncate(status, width)),
      renderCommandActions(width, height, currentCatalogCommand, commandActionCursor),
      h(
        Text,
        { dimColor: true },
        truncate("j/k:move  Enter:run  e:edit  Esc:back", width)
      )
    );
  }

  let hints;
  if (mode === "filter") {
    hints = "Enter: apply  Esc: cancel";
  } else if (mode === "confirm") {
    hints = "y: confirm  n: cancel";
  } else if (mode === "upload") {
    hints = "Enter: upload  Esc: cancel";
  } else if (mode === "command") {
    hints = "Enter: run  Esc: cancel";
  } else if (mode === "rename") {
    hints = "Enter: rename  Esc: cancel";
  } else if (mode === "command-output") {
    hints = "j/k: scroll  Enter/Esc: close";
  } else {
    hints = focusPane === "local"
      ? "u:upload  s:sync  n:rename  x:delete  /:filter  Tab:switch  w:sync  f:Commands  ?:help  q:quit"
      : "Space:select  a:all  t:trash  d:delete  /:filter  Tab:switch  w:sync  f:Commands  ?:help  q:quit";
  }

  const headerRight = selectedCount > 0
    ? `${selectedCount} selected`
    : "";

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { justifyContent: "space-between" },
      h(
        Text,
        { color: "cyan", bold: true },
        truncate(
          account ? `Aethel  ${account.email}  ${account.usage}/${account.limit}` : "Aethel",
          width - headerRight.length - 2
        )
      ),
      headerRight
        ? h(Text, { color: "yellow" }, headerRight)
        : null
    ),
    h(
      Box,
      { flexDirection: "row" },
      renderPane({
        title: "Local",
        breadcrumb: truncate(localDirectory, paneWidth),
        focused: focusPane === "local",
        entries: filteredLocalEntries,
        cursor: localCursor,
        renderer: renderLocalRow,
        width: paneWidth,
        height: contentHeight,
        emptyMessage: localFilter
          ? "No local items match the filter."
          : "No local items found.",
      }),
      h(Text, { dimColor: true }, " | "),
      renderPane({
        title: remoteLoading ? "Drive (loading...)" : "Drive",
        breadcrumb: truncate(
          remoteFolderStack.length
            ? `/${remoteFolderStack.map((folder) => folder.name).join("/")}`
            : "/",
          paneWidth
        ),
        focused: focusPane === "remote",
        entries: filteredRemoteEntries,
        cursor: remoteCursor,
        renderer: (entry, isCursor, itemWidth) =>
          renderRemoteRow(
            entry,
            isCursor,
            selectedRemoteIds.has(entry.id),
            itemWidth
          ),
        width: paneWidth,
        height: contentHeight,
        emptyMessage: remoteFilter
          ? "No Drive items match the filter."
          : "No Drive items found.",
      })
    ),
    h(Text, { color: mode === "busy" ? "yellow" : "green" }, truncate(status, width)),
    mode === "upload"
      ? h(
          Box,
          { flexDirection: "column" },
          h(Text, { color: "cyan" }, "Local path to upload:"),
          h(TextInput, {
            value: inputValue,
            onChange: setInputValue,
            onSubmit: (value) => {
              void executeUpload(value);
            },
          })
        )
      : null,
    mode === "rename"
      ? h(
          Box,
          { flexDirection: "column" },
          h(Text, { color: "cyan" }, "New name:"),
          h(TextInput, {
            value: inputValue,
            onChange: setInputValue,
            onSubmit: (value) => {
              const action = pendingAction;
              setPendingAction(null);
              if (!action || action.type !== "local-rename") {
                setMode("normal");
                return;
              }
              void executeLocalRename(action.targetPath, value);
            },
          })
        )
      : null,
    mode === "command"
      ? h(
          Box,
          { flexDirection: "column" },
          h(Text, { color: "cyan" }, "aethel "),
          h(TextInput, {
            value: inputValue,
            onChange: setInputValue,
            onSubmit: (value) => {
              void executeCliCommand(value);
            },
          })
        )
      : null,
    h(Text, { dimColor: true }, truncate(hints, width)),
    mode === "help" ? renderHelp() : null,
    mode === "command-output" && commandResult
      ? renderCommandOutput(commandResult, width, height, commandScroll)
      : null
  );
}
