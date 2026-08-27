#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  initWorkspace,
  readConfig,
  requireRoot,
} from "./core/config.js";
import { createDefaultIgnoreFile, loadIgnoreRules } from "./core/ignore.js";
import { createProgressBar, createSpinner } from "./core/progress.js";
import { summarizeChanges, summarizeStagedEntries } from "./core/change-summary.js";
import { remoteCacheEnabledByDefault } from "./core/sync-cache-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

let authModulePromise;
let diffModulePromise;
let driveApiModulePromise;
let refsModulePromise;
let repositoryModulePromise;
let stagingModulePromise;
let tuiModulePromise;

function lazyImport(currentPromise, modulePath) {
  return currentPromise || import(modulePath);
}

async function loadAuthModule() {
  authModulePromise = lazyImport(authModulePromise, "./core/auth.js");
  return authModulePromise;
}

async function loadDiffModule() {
  diffModulePromise = lazyImport(diffModulePromise, "./core/diff.js");
  return diffModulePromise;
}

async function loadDriveApiModule() {
  driveApiModulePromise = lazyImport(driveApiModulePromise, "./core/drive-api.js");
  return driveApiModulePromise;
}

async function loadRefsModule() {
  refsModulePromise = lazyImport(refsModulePromise, "./core/refs.js");
  return refsModulePromise;
}

async function loadRepositoryClass() {
  repositoryModulePromise = lazyImport(repositoryModulePromise, "./core/repository.js");
  return (await repositoryModulePromise).Repository;
}

async function loadStagingModule() {
  stagingModulePromise = lazyImport(stagingModulePromise, "./core/staging.js");
  return stagingModulePromise;
}

async function loadTuiModule() {
  tuiModulePromise = lazyImport(tuiModulePromise, "./tui/index.js");
  return tuiModulePromise;
}

async function createRepository(root, options = {}) {
  const Repository = await loadRepositoryClass();
  return new Repository(root, options);
}

function getGitHash() {
  const repoRoot = path.resolve(__dirname, "..");
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return null;
  }

  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return null;
  }
}

const gitHash = process.argv.includes("--version") ? getGitHash() : null;
const versionString = gitHash ? `${pkg.version} (${gitHash})` : pkg.version;

const REQUIRED_CONFIRMATION = "DELETE ALL MY GOOGLE DRIVE FILES";
const REQUIRED_IGNORED_CONFIRMATION = "DELETE IGNORED GOOGLE DRIVE FILES";

function debugEnabled(options = {}) {
  const env = String(process.env.AETHEL_DEBUG || "").toLowerCase();
  return Boolean(options.debug) || ["1", "true", "yes", "on"].includes(env);
}

function formatDebugMs(ms) {
  return `${Math.round(ms)}ms`;
}

function debugMemory() {
  const usage = process.memoryUsage();
  return `rss=${Math.round(usage.rss / 1024 / 1024)}MB heap=${Math.round(usage.heapUsed / 1024 / 1024)}MB`;
}

function createDebugLogger(options = {}) {
  const enabled = debugEnabled(options);
  const startedAt = Date.now();
  let previousAt = startedAt;

  return (message, details = {}) => {
    if (!enabled) {
      return;
    }

    const now = Date.now();
    const fields = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    process.stderr.write(
      `[aethel:debug +${formatDebugMs(now - startedAt)} Δ${formatDebugMs(now - previousAt)}] ` +
        `${message}${fields ? ` ${fields}` : ""} ${debugMemory()}\n`
    );
    previousAt = now;
  };
}

function parseDryRunLimit(value) {
  if (value === undefined || value === null || value === "") {
    return Infinity;
  }

  const limit = Number.parseInt(String(value), 10);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`Invalid --dry-run-limit '${value}'. Expected a non-negative integer.`);
  }
  return limit;
}

function printChangePreview({ label, changes, debug, dryRunLimit }) {
  const limit = parseDryRunLimit(dryRunLimit);
  const visible = Number.isFinite(limit) ? changes.slice(0, limit) : changes;
  debug("dry-run render start", { total: changes.length, visible: visible.length });

  console.log(`Would ${label} ${changes.length} change(s):`);
  let rendered = 0;
  for (const c of visible) {
    console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
    rendered++;
    if (rendered % 1000 === 0) {
      debug("dry-run render progress", { rendered, total: visible.length });
    }
  }

  if (visible.length < changes.length) {
    console.log(`  ... ${changes.length - visible.length} more change(s) hidden by --dry-run-limit`);
  }

  debug("dry-run render done", { rendered: visible.length, total: changes.length });
}

function addAuthOptions(command) {
  return command
    .option("--credentials <path>", "Path to OAuth client credentials JSON")
    .option("--token <path>", "Path to cached OAuth token JSON");
}

async function openRepo(options, { requireWorkspace = true, silent = false, connect = true } = {}) {
  const root = requireWorkspace ? requireRoot() : null;
  const repo = await createRepository(root, {
    credentials: options.credentials,
    token: options.token,
    forceAuth: options.forceAuth,
  });
  if (!connect) {
    return repo;
  }
  const spinner = silent ? null : createSpinner("Connecting to Google Drive...");
  try {
    await repo.connect();
    spinner?.succeed("Connected to Google Drive");
  } catch (err) {
    spinner?.fail("Connection failed");
    throw err;
  }
  return repo;
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function loadStateWithProgress(repo, opts) {
  const spinner = createSpinner("Loading workspace state...");
  try {
    const state = await repo.loadState({
      ...opts,
      onPhase(phase, ms) {
        if (phase === "local") spinner.update(`Scanned local files (${fmtMs(ms)}), waiting for remote...`);
        else if (phase === "remote") spinner.update(`Fetched remote state (${fmtMs(ms)}), computing diff...`);
      },
    });
    const { timings, diff } = state;
    const n = diff.changes.length;

    const parts = [
      `${timings.localFiles} local`,
      `${timings.remoteFiles} remote`,
    ];
    const times = [
      `scan ${fmtMs(timings.localMs)}`,
      timings.remoteCached ? `remote cache hit` : `fetch ${fmtMs(timings.remoteMs)}`,
      `diff ${fmtMs(timings.diffMs)}`,
      `total ${fmtMs(timings.totalMs)}`,
    ];

    const summary = n ? `${n} change(s)` : "up to date";
    spinner.succeed(`${summary} (${parts.join(", ")}) [${times.join(" | ")}]`);
    return state;
  } catch (err) {
    spinner.fail("Failed to load workspace state");
    throw err;
  }
}

function assertInsideRoot(root, targetPath) {
  const abs = path.resolve(root, targetPath);
  const resolvedRoot = path.resolve(root);
  if (!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) {
    throw new Error(`Path traversal blocked: '${targetPath}' resolves outside workspace`);
  }
  return abs;
}

function matchesPattern(targetPath, pattern) {
  const normalizedTarget = targetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

  if (
    normalizedTarget === normalizedPattern ||
    normalizedTarget.startsWith(`${normalizedPattern}/`)
  ) {
    return true;
  }

  const expression = normalizedPattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${expression}$`).test(normalizedTarget);
}

function printChangeDetail(change) {
  console.log(`  ${change.shortStatus} ${change.path}`);
  console.log(`       ${change.description}`);

  if (change.remoteMeta) {
    const remoteMd5 = change.remoteMeta.md5Checksum || "?";
    console.log(
      `       remote: md5=${String(remoteMd5).slice(0, 8)}  modified=${
        change.remoteMeta.modifiedTime || "?"
      }`
    );
  }

  if (change.localMeta) {
    const localMd5 = change.localMeta.md5 || "?";
    console.log(
      `       local:  md5=${String(localMd5).slice(0, 8)}  modified=${
        change.localMeta.modifiedTime || "?"
      }`
    );
  }

  if (change.snapshotMeta) {
    const snapshotMd5 =
      change.snapshotMeta.md5Checksum || change.snapshotMeta.md5 || "?";
    console.log(`       snap:   md5=${String(snapshotMd5).slice(0, 8)}`);
  }
}

function printChangeSummaryEntry(entry) {
  console.log(`  ${entry.shortStatus} ${entry.path}  (${entry.description})`);
}

function printChangeSummaryEntries(changes, options = {}) {
  for (const entry of summarizeChanges(changes, options)) {
    printChangeSummaryEntry(entry);
  }
}

function printStagedEntries(staged, { verbose = true, detail = false } = {}) {
  if (!staged.length) {
    console.log("No staged changes.");
    return;
  }

  if (verbose) {
    console.log(`\nStaged changes (${staged.length}):`);
  }
  for (const entry of summarizeStagedEntries(staged, { detail })) {
    const countLabel = entry.count > 1 ? `  (${entry.description})` : "";
    console.log(`  ${entry.action.padStart(15, " ")}  ${entry.path}${countLabel}`);
  }
}

function snapshotRef(snapshot) {
  return String(snapshot.timestamp || "snapshot").replace(/[-:TZ.]/g, "").slice(0, 12);
}

function snapshotFileCount(snapshot) {
  return Object.keys(snapshot.files || {}).length;
}

function snapshotLocalFileCount(snapshot) {
  return Object.keys(snapshot.localFiles || {}).length;
}

function printSnapshotStat(snapshot) {
  const remoteCount = snapshotFileCount(snapshot);
  const localCount = snapshotLocalFileCount(snapshot);
  console.log(` ${remoteCount} remote file(s), ${localCount} local file(s)`);
}

function printCleanerPlan(files, { permanent, execute }) {
  const action = permanent ? "permanently delete" : "move to trash";
  const mode = execute ? "EXECUTION" : "DRY RUN";

  console.log(`${mode}: the script will ${action} ${files.length} file(s).`);
  for (const file of files) {
    console.log(`- ${file.path || file.name} | id=${file.id} | mimeType=${file.mimeType}`);
  }
}

function requireConfirmation(options, phrase = REQUIRED_CONFIRMATION) {
  if (!options.execute) {
    return;
  }

  if (options.confirm !== phrase) {
    throw new Error(
      `The confirmation phrase is incorrect. Pass --confirm "${phrase}" to execute.`
    );
  }
}

function parseDriveRemote(remote) {
  const value = String(remote || "").trim();
  if (!value || ["my-drive", "root", "drive://root"].includes(value.toLowerCase())) {
    return null;
  }

  const folderMatch = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    return folderMatch[1];
  }

  const queryMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) {
    return queryMatch[1];
  }

  return value.replace(/^drive:\/\//, "");
}

async function handleAuth(options) {
  const repo = await openRepo({ ...options, forceAuth: true }, { requireWorkspace: false });
  const spinner = createSpinner("Fetching account info...");
  const account = await repo.getAccountInfo();
  spinner.succeed(`Authenticated as ${account.email}`);

  const { persistCredentials, resolveCredentialsPath, resolveTokenPath } =
    await loadAuthModule();
  const credentialsPath = resolveCredentialsPath(options.credentials);
  await persistCredentials(credentialsPath);

  console.log("OAuth initialization completed.");
  console.log(`Credentials path: ${credentialsPath}`);
  console.log(`Token path: ${resolveTokenPath(options.token)}`);
  console.log(`Authenticated user: ${account.name}`);
  console.log(`Authenticated email: ${account.email}`);
  console.log(`Storage usage: ${account.usage}`);
  console.log(`Storage limit: ${account.limit}`);
}

async function handleClone(remote, directory, options) {
  const driveFolderId = parseDriveRemote(remote);
  const displayName = options.driveFolderName || (driveFolderId ? driveFolderId : "My Drive");
  const localPath = path.resolve(directory || displayName);

  if (!fs.existsSync(localPath)) {
    await fs.promises.mkdir(localPath, { recursive: true });
  }

  const root = initWorkspace(localPath, driveFolderId, displayName);
  createDefaultIgnoreFile(root);

  console.log(`Cloned Drive remote into ${root}`);
  if (driveFolderId) {
    console.log(`  Remote: origin -> drive://${driveFolderId}`);
  } else {
    console.log("  Remote: origin -> drive://root");
  }

  if (options.checkout === false) {
    console.log("  Checkout skipped. Run 'aethel pull --all' inside the workspace to hydrate files.");
    return;
  }

  const repo = await createRepository(root, {
    credentials: options.credentials,
    token: options.token,
  });
  const spinner = createSpinner("Connecting to Google Drive...");
  await repo.connect();
  spinner.succeed("Connected to Google Drive");

  const fetchSpinner = createSpinner("Fetching remote file list...");
  const remoteState = await repo.getRemoteState({ useCache: false });
  fetchSpinner.succeed(`Found ${remoteState.files.length} remote item(s)`);

  if (remoteState.files.length === 0) {
    await repo.saveSnapshot(options.message || "clone", { remote: remoteState });
    console.log("Remote is empty. Snapshot saved.");
    return;
  }

  const count = repo.stageRemoteFilesForDownload(remoteState.files);
  console.log(`Staged ${count} remote item(s). Checking out files...`);
  await handleCommit({ ...options, message: options.message || "clone" }, {
    repo,
    snapshotHint: { remote: remoteState },
  });
}

async function handleRemote(subcommand, args, options) {
  const root = requireRoot();
  const config = readConfig(root);
  const name = options.remoteName || "origin";
  const driveFolderId = config.drive_folder_id || null;
  const driveRef = driveFolderId ? `drive://${driveFolderId}` : "drive://root";
  const displayName = config.drive_folder_name || "My Drive";
  const command = subcommand || (options.verbose ? "-v" : null);

  if (!command) {
    console.log(name);
    return;
  }

  if (command === "-v" || command === "verbose") {
    console.log(`${name}\t${driveRef} (fetch)`);
    console.log(`${name}\t${driveRef} (push)`);
    return;
  }

  if (command === "get-url") {
    const target = args[0] || name;
    if (target !== name) {
      throw new Error(`Unknown remote '${target}'. Aethel workspaces expose '${name}'.`);
    }
    console.log(driveRef);
    return;
  }

  if (command === "show") {
    const target = args[0] || name;
    if (target !== name) {
      throw new Error(`Unknown remote '${target}'. Aethel workspaces expose '${name}'.`);
    }
    console.log(`* remote ${name}`);
    console.log(`  Drive folder: ${displayName}`);
    console.log(`  Drive ref:    ${driveRef}`);
    console.log(`  Workspace:    ${root}`);
    console.log("  Fetch:        aethel fetch / aethel pull");
    console.log("  Push:         aethel push");
    return;
  }

  throw new Error("Usage: aethel remote [-v] | remote show [origin] | remote get-url [origin]");
}

async function handleBranch(args, options) {
  const {
    createBranch,
    deleteBranch,
    getBranches,
  } = await loadRefsModule();
  const root = requireRoot();
  const config = readConfig(root);
  const remote = config.drive_folder_id ? `drive://${config.drive_folder_id}` : "drive://root";
  const state = getBranches(root);

  if (options.delete) {
    for (const name of args) {
      if (deleteBranch(root, name)) {
        console.log(`Deleted branch '${name}'.`);
      } else {
        console.log(`Branch '${name}' not found.`);
      }
    }
    return;
  }

  if (args.length > 0) {
    const [name, ref = "HEAD"] = args;
    const branch = createBranch(root, name, ref, { force: Boolean(options.force) });
    console.log(`Created branch ${name} at ${branch.ref}.`);
    return;
  }

  const names = Object.keys(state.branches).sort();
  for (const name of names) {
    const marker = name === state.current ? "*" : " ";
    const branch = state.branches[name] || {};
    if (options.all || options.verbose) {
      console.log(`${marker} ${name} ${branch.ref || "(no snapshot)"} ${remote}`);
    } else {
      console.log(`${marker} ${name}`);
    }
  }
}

async function handleSwitch(branchName, options) {
  const { switchBranch } = await loadRefsModule();
  const root = requireRoot();
  const branch = switchBranch(root, branchName, {
    create: Boolean(options.create),
    ref: options.startPoint || "HEAD",
  });

  console.log(`Switched to branch '${branchName}'.`);
  if (branch.ref) {
    console.log(`  Branch points to ${branch.ref}.`);
    console.log("  Working files are unchanged; run 'aethel restore --source HEAD <path>' or 'aethel pull' when needed.");
    return;
  }
  console.log("  Branch has no snapshot yet.");
}

async function handleTag(args, options) {
  const { createTag, deleteTag, getTags } = await loadRefsModule();
  const root = requireRoot();
  const tags = getTags(root);

  if (options.delete) {
    for (const name of args) {
      if (deleteTag(root, name)) {
        console.log(`Deleted tag '${name}'.`);
      } else {
        console.log(`Tag '${name}' not found.`);
      }
    }
    return;
  }

  if (options.list || args.length === 0) {
    const names = Object.keys(tags).sort();
    if (!names.length) {
      return;
    }
    for (const name of names) {
      if (options.verbose) {
        const tag = tags[name];
        console.log(`${name.padEnd(20, " ")} ${tag.ref} ${tag.message || ""}`);
      } else {
        console.log(name);
      }
    }
    return;
  }

  const [name, ref = "HEAD"] = args;
  const tag = createTag(root, name, ref, { force: Boolean(options.force) });
  console.log(`Tagged ${tag.ref} as ${name}.`);
}

async function handleClean(options) {
  const ignoredMode = Boolean(options.ignored);
  requireConfirmation(
    options,
    ignoredMode ? REQUIRED_IGNORED_CONFIRMATION : REQUIRED_CONFIRMATION
  );
  const repo = await openRepo(options, { requireWorkspace: ignoredMode });
  const spinner = createSpinner(
    ignoredMode ? "Listing ignored remote files..." : "Listing remote files..."
  );
  const files = ignoredMode
    ? await repo.listIgnoredRemoteItems(loadIgnoreRules(repo.root), {
        includeSharedDrives: Boolean(options.sharedDrives),
      })
    : await repo.listRemoteFiles({ includeSharedDrives: Boolean(options.sharedDrives) });
  spinner.succeed(
    ignoredMode
      ? `Found ${files.length} ignored file(s) on Drive`
      : `Found ${files.length} file(s) on Drive`
  );

  printCleanerPlan(files, options);

  if (files.length === 0) {
    console.log(ignoredMode
      ? "No ignored non-trashed files were found."
      : "No non-trashed files were found.");
    return;
  }

  if (!options.execute) {
    console.log("Dry run completed. Re-run with --execute to perform the operation.");
    return;
  }

  const bar = createProgressBar(`Cleaning ${files.length} file(s)`, files.length);
  const result = await repo.batchOperateFiles(files, {
    permanent: Boolean(options.permanent),
    includeSharedDrives: Boolean(options.sharedDrives),
    onProgress: (done) => {
      bar.update(done);
    },
  });
  bar.done(`Cleaned ${files.length} file(s)`);

  if (result.errors) {
    console.log(`Completed with ${result.errors} error(s) out of ${files.length} file(s).`);
  }

  console.log("Operation completed.");
  if (ignoredMode) {
    repo.invalidateRemoteCache();
  }
}

async function handleInit(options) {
  const localPath = path.resolve(options.localPath);
  let driveFolderId = options.driveFolder || null;
  let driveFolderName = options.driveFolderName || null;

  // Interactive folder selection when no --drive-folder is provided
  if (!driveFolderId) {
    const repo = await openRepo(options, { requireWorkspace: false });
    const spinner = createSpinner("Fetching root-level Drive folders...");
    const folders = await repo.listRootFolders();
    spinner.succeed(`Found ${folders.length} folder(s) in Drive root`);

    if (folders.length === 0) {
      console.log("No folders found in Drive root. Syncing entire My Drive.");
      driveFolderName = "My Drive";
    } else {
      console.log("\nDrive folders:");
      console.log("  0) My Drive (entire drive)");
      for (const [i, folder] of folders.entries()) {
        console.log(`  ${i + 1}) ${folder.name}`);
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`\nSelect a folder [0-${folders.length}]: `);
        const index = Number.parseInt(answer, 10);

        if (index === 0 || answer.trim() === "") {
          driveFolderName = "My Drive";
        } else if (index >= 1 && index <= folders.length) {
          const selected = folders[index - 1];
          driveFolderId = selected.id;
          driveFolderName = selected.name;
        } else {
          console.log("Invalid selection. Aborting.");
          return;
        }
      } finally {
        rl.close();
      }
    }
  }

  if (!fs.existsSync(localPath)) {
    await fs.promises.mkdir(localPath, { recursive: true });
  }

  const root = initWorkspace(localPath, driveFolderId, driveFolderName || "My Drive");

  const created = createDefaultIgnoreFile(root);
  console.log(`\nInitialised Aethel workspace at ${root}`);
  if (created) {
    console.log("  Created .aethelignore with default patterns");
  }
  if (driveFolderId) {
    console.log(`  Drive folder: ${driveFolderName} (${driveFolderId})`);
  } else {
    console.log("  Syncing entire My Drive");
  }
}

async function handleStatus(options) {
  // `status` is read-only and usually served straight from the remote cache,
  // so let Repository authenticate lazily — only if it actually has to fetch.
  const repo = await openRepo(options, { connect: false });
  const { diff } = await loadStateWithProgress(repo, {
    useCache: remoteCacheEnabledByDefault("status"),
    remoteCacheTtlMs: Number.POSITIVE_INFINITY,
  });
  const staged = repo.getStagedEntries();

  const hasPackChanges = diff.hasPackChanges || (options.verbose && diff.syncedPacks?.length > 0);

  if (diff.isClean && staged.length === 0 && !hasPackChanges) {
    console.log("Everything up to date.");
    return;
  }

  if (options.short) {
    for (const entry of staged) {
      console.log(`S  ${entry.action}  ${entry.path}`);
    }
    const stagedPaths = new Set(staged.map((e) => e.path));
    const unstaged = diff.changes.filter((c) => !stagedPaths.has(c.path));
    for (const entry of summarizeChanges(unstaged, { detail: options.detail })) {
      const countLabel = entry.count > 1 ? ` (${entry.count} changes)` : "";
      console.log(`${entry.shortStatus.padEnd(2, " ")} ${entry.path}${countLabel}`);
    }
    for (const change of [...(diff.pendingPackChanges || []), ...(diff.packConflicts || [])]) {
      console.log(`${change.shortStatus.padEnd(2, " ")} ${change.path}`);
    }
    return;
  }

  if (staged.length) {
    printStagedEntries(staged, { detail: options.detail });
  }

  const stagedPaths = new Set(staged.map((e) => e.path));
  const unstagedRemote = diff.remoteChanges.filter((c) => !stagedPaths.has(c.path));
  const unstagedLocal = diff.localChanges.filter((c) => !stagedPaths.has(c.path));
  const unstagedConflicts = diff.conflicts.filter((c) => !stagedPaths.has(c.path));

  if (unstagedRemote.length) {
    console.log(`\nRemote changes (${unstagedRemote.length}):`);
    printChangeSummaryEntries(unstagedRemote, { detail: options.detail });
  }

  if (unstagedLocal.length) {
    console.log(`\nLocal changes (${unstagedLocal.length}):`);
    printChangeSummaryEntries(unstagedLocal, { detail: options.detail });
  }

  if (unstagedConflicts.length) {
    console.log(`\nConflicts (${unstagedConflicts.length}):`);
    printChangeSummaryEntries(unstagedConflicts, { detail: options.detail });
  }

  // Display pack changes
  const pendingPacks = diff.pendingPackChanges || [];
  const packConflicts = diff.packConflicts || [];
  const syncedPacks = diff.syncedPacks || [];

  if (pendingPacks.length) {
    console.log(`\nPack changes (${pendingPacks.length}):`);
    for (const change of pendingPacks) {
      console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  if (packConflicts.length) {
    console.log(`\nPack conflicts (${packConflicts.length}):`);
    for (const change of packConflicts) {
      console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }

  if (options.verbose && syncedPacks.length) {
    console.log(`\nSynced packs (${syncedPacks.length}):`);
    for (const change of syncedPacks) {
      console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
    }
  }
}

async function handleDiff(options) {
  const repo = await openRepo(options);
  const { diff } = await loadStateWithProgress(repo);
  const staged = repo.getStagedEntries();

  if (options.staged || options.cached) {
    printStagedEntries(staged, { detail: options.detail });
    return;
  }

  if (diff.isClean) {
    console.log("No changes detected.");
    return;
  }

  const showRemote = options.side === "all" || options.side === "remote";
  const showLocal = options.side === "all" || options.side === "local";

  if (showRemote && diff.remoteChanges.length) {
    console.log("Remote changes:");
    if (options.detail) {
      for (const change of diff.remoteChanges) {
        printChangeDetail(change);
      }
    } else {
      printChangeSummaryEntries(diff.remoteChanges);
    }
  }

  if (showLocal && diff.localChanges.length) {
    console.log("Local changes:");
    if (options.detail) {
      for (const change of diff.localChanges) {
        printChangeDetail(change);
      }
    } else {
      printChangeSummaryEntries(diff.localChanges);
    }
  }

  if (diff.conflicts.length) {
    console.log("Conflicts:");
    if (options.detail) {
      for (const change of diff.conflicts) {
        printChangeDetail(change);
      }
    } else {
      printChangeSummaryEntries(diff.conflicts);
    }
  }
}

async function handleAdd(paths, options) {
  const repo = await openRepo(options);
  const { diff } = await loadStateWithProgress(repo, {
    useCache: remoteCacheEnabledByDefault("add"),
  });

  if (options.all || options.A) {
    const toStage = diff.changes.filter(
      (change) => change.suggestedAction !== "conflict"
    );
    const count = repo.stageChanges(toStage);
    console.log(`Staged ${count} change(s).`);
    return;
  }

  const changesByPath = new Map(diff.changes.map((change) => [change.path, change]));
  let stagedCount = 0;

  for (const pattern of paths || []) {
    const matched = [...changesByPath.entries()]
      .filter(([changePath]) => matchesPattern(changePath, pattern))
      .map(([, change]) => change);

    if (matched.length === 0) {
      console.log(`  No changes match '${pattern}'`);
      continue;
    }

    for (const change of matched) {
      if (change.suggestedAction === "conflict") {
        console.log(`  !! ${change.path} is conflicted - resolve before staging`);
        continue;
      }

      repo.stageChange(change);
      stagedCount += 1;
      console.log(`  Staged: ${change.path}`);
    }
  }

  console.log(`Staged ${stagedCount} change(s).`);
}

async function handleReset(paths, options) {
  const { unstageAll, unstagePath } = await loadStagingModule();
  const root = requireRoot();
  const resetPaths = [...(paths || [])];
  if (resetPaths[0] === "HEAD" || resetPaths[0] === "--") {
    resetPaths.shift();
  }

  if (options.all || resetPaths.length === 0) {
    const count = unstageAll(root);
    console.log(`Unstaged ${count} change(s).`);
    return;
  }

  for (const targetPath of resetPaths) {
    if (unstagePath(root, targetPath)) {
      console.log(`  Unstaged: ${targetPath}`);
      continue;
    }

    console.log(`  Not staged: ${targetPath}`);
  }
}

async function handleCommit(options, { repo: existingRepo, snapshotHint } = {}) {
  const repo = existingRepo || await openRepo(options);
  const staged = repo.getStagedEntries();

  if (!staged.length) {
    console.log("Nothing staged. Use 'aethel add' first.");
    return;
  }

  const message = options.message || "sync";
  const bar = createProgressBar(`Syncing ${staged.length} change(s)`, staged.length);

  const result = await repo.executeStaged((done) => {
    bar.update(done + 1);
  });

  bar.done(`Commit complete: ${result.summary}`);
  if (result.errors.length) {
    for (const error of result.errors) {
      console.log(`  ERROR: ${error}`);
    }
    console.log("Snapshot not saved because some staged changes failed.");
    return;
  }

  const snapshotStart = Date.now();
  const spinner = createSpinner("Saving snapshot...");
  // snapshotHint lets callers (pull/push) pass pre-loaded state
  // so saveSnapshot skips redundant API calls / fs scans.
  await repo.saveSnapshot(message, snapshotHint);
  const skipped = [];
  if (snapshotHint?.remote) skipped.push("remote reused");
  if (snapshotHint?.local) skipped.push("local reused");
  const hint = skipped.length ? ` (${skipped.join(", ")})` : "";
  spinner.succeed(`Snapshot saved in ${fmtMs(Date.now() - snapshotStart)}${hint}`);
}

async function handleLog(options) {
  const { getHistory } = await loadRefsModule();
  const root = requireRoot();
  const entries = getHistory(root, options.limit || 10);

  if (!entries.length) {
    console.log("No commits yet.");
    return;
  }

  for (const snapshot of entries) {
    if (options.oneline) {
      console.log(`${snapshotRef(snapshot)} ${snapshot.message || "(no message)"}`);
      continue;
    }

    console.log(`commit ${snapshotRef(snapshot)}`);
    console.log(`Date:   ${snapshot.timestamp || "?"}`);
    console.log(`\n    ${snapshot.message || "(no message)"}`);
    if (options.stat) {
      console.log("");
      printSnapshotStat(snapshot);
    }
    console.log("");
  }
}

async function handleFetch(options) {
  const repo = await openRepo(options);

  repo.invalidateRemoteCache();
  const fetchStart = Date.now();
  const spinner = createSpinner("Fetching remote file list...");

  // The local scan is pure filesystem work and the remote listing is pure
  // network work — overlap them instead of paying for both end to end.
  const snapshot = repo.getSnapshot();
  const [remoteResult, localResult] = await Promise.allSettled([
    repo.getRemoteState({ useCache: false, snapshot }),
    snapshot ? repo.scanLocal() : Promise.resolve(null),
  ]);

  if (remoteResult.status === "rejected") {
    spinner.fail("Failed to fetch remote file list");
    throw remoteResult.reason;
  }
  const remote = remoteResult.value.files;
  spinner.succeed(`Found ${remote.length} file(s) on Drive [${fmtMs(Date.now() - fetchStart)}]`);

  if (localResult.status === "rejected") {
    throw localResult.reason;
  }

  if (snapshot) {
    const diff = repo.computeDiff(snapshot, remote, localResult.value);
    const remoteChanges = diff.remoteChanges;
    const conflicts = diff.conflicts;

    if (remoteChanges.length === 0 && conflicts.length === 0) {
      console.log("\nRemote is up to date with last snapshot.");
    } else {
      if (remoteChanges.length) {
        console.log(`\nRemote changes since last commit (${remoteChanges.length}):`);
        for (const c of remoteChanges) {
          console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
        }
      }
      if (conflicts.length) {
        console.log(`\nConflicts detected (${conflicts.length}):`);
        for (const c of conflicts) {
          console.log(`  ${c.shortStatus} ${c.path}  (${c.description})`);
        }
      }
      console.log("\nUse 'aethel pull' to apply remote changes, or 'aethel resolve' for conflicts.");
    }
  } else {
    console.log("\nNo snapshot yet. Use 'aethel pull --all' or 'aethel add --all && aethel commit' to create initial snapshot.");
  }
}

async function handlePull(paths, options) {
  const { ChangeType } = await loadDiffModule();
  const { conflictResolutionChange } = await loadStagingModule();
  const debug = createDebugLogger(options);
  debug("pull start", {
    force: Boolean(options.force),
    dryRun: Boolean(options.dryRun),
    paths: paths?.length || 0,
  });
  const repo = await openRepo(options);
  const { diff, remoteState } = await loadStateWithProgress(repo, {
    useCache: remoteCacheEnabledByDefault("pull"),
  });
  debug("pull state loaded", {
    changes: diff.changes.length,
    conflicts: diff.conflicts.length,
    remoteFiles: remoteState.files.length,
  });

  if (options.all) {
    let remoteFiles = remoteState.files;
    let remoteDeletions = diff.changes.filter(
      (change) => change.changeType === ChangeType.REMOTE_DELETED
    );
    let remoteRenames = diff.changes.filter(
      (change) => change.changeType === ChangeType.REMOTE_RENAMED
    );

    if (paths && paths.length > 0) {
      remoteFiles = remoteFiles.filter((file) =>
        paths.some((p) => matchesPattern(file.path, p))
      );
      remoteDeletions = remoteDeletions.filter((change) =>
        paths.some((p) => matchesPattern(change.path, p))
      );
      remoteRenames = remoteRenames.filter((change) =>
        paths.some((p) => matchesPattern(change.path, p))
      );
    }

    if (!remoteFiles.length && !remoteDeletions.length && !remoteRenames.length) {
      console.log("No remote changes matched.");
      return;
    }

    if (options.dryRun) {
      console.log(
        `Would pull ${remoteFiles.length} remote item(s) and apply ` +
        `${remoteDeletions.length} remote deletion(s) and ` +
        `${remoteRenames.length} remote rename(s):`
      );
      for (const file of remoteFiles) {
        console.log(`  +R ${file.path}  (full remote download)`);
      }
      for (const change of remoteDeletions) {
        console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
      }
      for (const change of remoteRenames) {
        console.log(`  ${change.shortStatus} ${change.path}  (${change.description})`);
      }
      return;
    }

    const count = repo.stageFullRemotePull(remoteFiles, remoteDeletions, remoteRenames);
    console.log(`Staged ${count} remote change(s). Committing...`);
    await handleCommit({ ...options, message: options.message || "pull" }, {
      repo,
      snapshotHint: {
        remote: remoteState,
        pullChanges: [
          ...remoteFiles.map((remoteFile) => ({
            suggestedAction: "download",
            path: remoteFile.path,
            remoteMeta: remoteFile,
          })),
          ...remoteDeletions,
          ...remoteRenames,
        ],
      },
    });
    return;
  }

  let remoteChanges = diff.changes.filter((change) =>
    [
      ChangeType.REMOTE_ADDED,
      ChangeType.REMOTE_MODIFIED,
      ChangeType.REMOTE_DELETED,
      ChangeType.REMOTE_RENAMED,
    ].includes(change.changeType)
  );
  let forcedPullConflictChanges = [];
  debug("pull base changes selected", { remoteChanges: remoteChanges.length });

  if (options.force) {
    debug("pull force conflict conversion start", { conflicts: diff.conflicts.length });
    forcedPullConflictChanges = diff.conflicts.map((conflict) =>
      conflictResolutionChange(conflict, "theirs")
    );
    if (forcedPullConflictChanges.length) {
      remoteChanges = [
        ...remoteChanges,
        ...forcedPullConflictChanges,
      ];
    }
    debug("pull force conflict conversion done", {
      forcedConflicts: forcedPullConflictChanges.length,
      remoteChanges: remoteChanges.length,
    });
  }

  if (paths && paths.length > 0) {
    debug("pull path filter start", { paths: paths.length, before: remoteChanges.length });
    remoteChanges = remoteChanges.filter((change) =>
      paths.some((p) => matchesPattern(change.path, p))
    );
    forcedPullConflictChanges = forcedPullConflictChanges.filter((change) =>
      paths.some((p) => matchesPattern(change.path, p))
    );
    debug("pull path filter done", { after: remoteChanges.length });
  }

  if (forcedPullConflictChanges.length) {
    console.log(`Force-pulling ${forcedPullConflictChanges.length} conflict(s) (remote wins)...`);
  }

  if (!remoteChanges.length && !options.force) {
    console.log("Already up to date.");
    if (diff.conflicts.length) {
      console.log(`  (${diff.conflicts.length} conflict(s) exist — use --force to accept remote versions)`);
    }
    return;
  }

  if (options.dryRun) {
    printChangePreview({
      label: "pull",
      changes: remoteChanges,
      debug,
      dryRunLimit: options.dryRunLimit,
    });
    return;
  }

  debug("pull staging start", { changes: remoteChanges.length });
  const count = repo.stageChanges(remoteChanges);
  debug("pull staging done", { staged: count });
  console.log(`Staged ${count} remote change(s). Committing...`);
  // Pull downloads remote→local: remote state unchanged, only re-scan local
  await handleCommit({ ...options, message: options.message || "pull" }, {
    repo,
    snapshotHint: { remote: remoteState, pullChanges: remoteChanges },
  });
}

async function handlePush(paths, options) {
  const { ChangeType, changesWithLocalAuthority } = await loadDiffModule();
  const { conflictResolutionChange } = await loadStagingModule();
  const debug = createDebugLogger(options);
  debug("push start", {
    force: Boolean(options.force),
    dryRun: Boolean(options.dryRun),
    paths: paths?.length || 0,
  });
  const repo = await openRepo(options);
  const { diff, local } = await loadStateWithProgress(repo, {
    useCache: remoteCacheEnabledByDefault("push"),
  });
  debug("push state loaded", {
    changes: diff.changes.length,
    conflicts: diff.conflicts.length,
    localEntries: Object.keys(local?.files ?? local ?? {}).length,
  });

  let localChanges = diff.changes.filter((change) =>
    [
      ChangeType.LOCAL_ADDED,
      ChangeType.LOCAL_MODIFIED,
      ChangeType.LOCAL_DELETED,
      ChangeType.LOCAL_RENAMED,
    ].includes(change.changeType)
  );
  let forcedPushConflictChanges = [];
  debug("push base changes selected", { localChanges: localChanges.length });

  if (options.force) {
    const remoteAdditions = diff.remoteChanges.filter(
      (change) => change.changeType === ChangeType.REMOTE_ADDED
    );
    const localFiles = local?.files ?? local ?? {};
    debug("push remote additions conversion start", { remoteAdditions: remoteAdditions.length });
    localChanges = [
      ...localChanges,
      ...changesWithLocalAuthority(remoteAdditions, {
        pathExists: (relativePath) =>
          fs.existsSync(path.join(repo.root, ...relativePath.split("/"))),
        getLocalMeta: (relativePath) => localFiles[relativePath] || null,
      }),
    ];
    debug("push remote additions conversion done", { localChanges: localChanges.length });

    debug("push force conflict conversion start", { conflicts: diff.conflicts.length });
    forcedPushConflictChanges = diff.conflicts.map((conflict) =>
      conflictResolutionChange(conflict, "ours")
    );
    if (forcedPushConflictChanges.length) {
      localChanges = [
        ...localChanges,
        ...forcedPushConflictChanges,
      ];
    }
    debug("push force conflict conversion done", {
      forcedConflicts: forcedPushConflictChanges.length,
      localChanges: localChanges.length,
    });
  }

  if (paths && paths.length > 0) {
    debug("push path filter start", { paths: paths.length, before: localChanges.length });
    localChanges = localChanges.filter((change) =>
      paths.some((p) => matchesPattern(change.path, p))
    );
    forcedPushConflictChanges = forcedPushConflictChanges.filter((change) =>
      paths.some((p) => matchesPattern(change.path, p))
    );
    debug("push path filter done", { after: localChanges.length });
  }

  if (forcedPushConflictChanges.length) {
    console.log(`Force-pushing ${forcedPushConflictChanges.length} conflict(s) (local wins)...`);
  }

  if (!localChanges.length && !options.force) {
    console.log("Nothing to push.");
    if (diff.conflicts.length) {
      console.log(`  (${diff.conflicts.length} conflict(s) exist — use --force to push local versions)`);
    }
    return;
  }

  if (options.dryRun) {
    printChangePreview({
      label: "push",
      changes: localChanges,
      debug,
      dryRunLimit: options.dryRunLimit,
    });
    return;
  }

  debug("push staging start", { changes: localChanges.length });
  const count = repo.stageChanges(localChanges);
  debug("push staging done", { staged: count });
  console.log(`Staged ${count} local change(s). Committing...`);
  // Push uploads local→remote: local state unchanged, only re-fetch remote
  await handleCommit({ ...options, message: options.message || "push" }, {
    repo,
    snapshotHint: { local },
  });
}

async function handleResolve(paths, options) {
  const { conflictResolutionChange } = await loadStagingModule();
  const repo = await openRepo(options);
  const { diff } = await loadStateWithProgress(repo);
  const conflicts = diff.conflicts;

  if (conflicts.length === 0) {
    console.log("No conflicts to resolve.");
    return;
  }

  // Determine strategy
  const keep = options.keep || null;
  const strategy = options.ours
    ? "ours"
    : options.theirs
      ? "theirs"
      : options.both
        ? "both"
        : keep === "local"
          ? "ours"
          : keep === "remote"
            ? "theirs"
            : keep === "both"
              ? "both"
              : null;

  if (keep && !["local", "remote", "both"].includes(keep)) {
    throw new Error("--keep must be one of: local, remote, both");
  }

  if (!strategy) {
    console.log(`Conflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      printChangeDetail(c);
    }
    console.log("\nResolve with:");
    console.log("  aethel resolve --ours [paths...]     Keep local version (upload)");
    console.log("  aethel resolve --theirs [paths...]   Keep remote version (download)");
    console.log("  aethel resolve --both [paths...]     Keep both (remote saved as .remote copy)");
    console.log("  aethel resolve --keep local [paths...]  Git-style alias for --ours");
    return;
  }

  // Filter to specific paths or resolve all
  let toResolve = conflicts;
  if (paths && paths.length > 0) {
    toResolve = conflicts.filter((c) =>
      paths.some((p) => matchesPattern(c.path, p))
    );

    if (toResolve.length === 0) {
      console.log("No conflicts match the given path(s).");
      console.log("Current conflicts:");
      for (const c of conflicts) {
        console.log(`  ${c.shortStatus} ${c.path}`);
      }
      return;
    }
  }

  const strategyLabel = { ours: "local wins", theirs: "remote wins", both: "keep both" };

  for (const conflict of toResolve) {
    repo.stageConflictResolution(conflict, strategy);
    console.log(`  Resolved: ${conflict.path} → ${strategyLabel[strategy]}`);
  }

  console.log(`\nResolved ${toResolve.length} conflict(s) with strategy: ${strategyLabel[strategy]}`);
  console.log("Run 'aethel commit' to apply.");
}

function handleIgnore(subcommand, args) {
  const root = requireRoot();
  const rules = loadIgnoreRules(root);

  if (subcommand === "list") {
    if (rules.userPatterns.length === 0) {
      console.log("No user-defined ignore patterns (.aethelignore is empty or missing).");
    } else {
      console.log("User-defined patterns:");
      for (const p of rules.userPatterns) {
        console.log(`  ${p}`);
      }
    }
    console.log("\nBuiltin patterns (always ignored):");
    for (const p of [".aethel", ".git", "node_modules", ".DS_Store", "Thumbs.db"]) {
      console.log(`  ${p}`);
    }
    return;
  }

  if (subcommand === "test") {
    for (const testPath of args) {
      const ignored = rules.ignores(testPath);
      console.log(`  ${ignored ? "ignored" : "tracked"}  ${testPath}`);
    }
    return;
  }

  if (subcommand === "create") {
    const created = createDefaultIgnoreFile(root);
    if (created) {
      console.log("Created .aethelignore with default patterns.");
    } else {
      console.log(".aethelignore already exists.");
    }
    return;
  }

  console.log("Usage: aethel ignore <list|test|create> [paths...]");
}

async function handleShow(ref, options) {
  const { getHistory, getSnapshotByRef } = await loadRefsModule();
  const root = requireRoot();

  const snapshot = getSnapshotByRef(root, ref);

  if (!snapshot) {
    if (!ref || ref === "HEAD" || ref === "latest") {
      console.log("No commits yet.");
    } else {
      console.log(`No snapshot matching '${ref}' found.`);
      const history = getHistory(root, 10);
      if (history.length) {
        console.log("Available snapshots:");
        for (const s of history) {
          console.log(`  ${s.timestamp || "?"}`);
        }
      }
    }
    return;
  }

  if (options.oneline) {
    console.log(`${snapshotRef(snapshot)} ${snapshot.message || "(no message)"}`);
    return;
  }

  console.log(`Snapshot: ${snapshot.timestamp || "?"}`);
  console.log(`Message:  ${snapshot.message || "(no message)"}`);

  const remoteFiles = Object.values(snapshot.files || {});
  const localFiles = Object.keys(snapshot.localFiles || {});

  if (options.stat) {
    console.log("");
    printSnapshotStat(snapshot);
    return;
  }

  console.log(`\nRemote files (${remoteFiles.length}):`);
  if (options.verbose) {
    for (const f of remoteFiles) {
      const md5 = f.md5Checksum ? f.md5Checksum.slice(0, 8) : "--------";
      console.log(`  ${md5}  ${f.path || f.name}`);
    }
  } else {
    for (const f of remoteFiles.slice(0, 20)) {
      console.log(`  ${f.path || f.name}`);
    }
    if (remoteFiles.length > 20) {
      console.log(`  ... and ${remoteFiles.length - 20} more`);
    }
  }

  console.log(`\nLocal files (${localFiles.length}):`);
  if (options.verbose) {
    for (const p of localFiles) {
      const meta = snapshot.localFiles[p];
      const md5 = meta.md5 ? meta.md5.slice(0, 8) : "--------";
      console.log(`  ${md5}  ${p}`);
    }
  } else {
    for (const p of localFiles.slice(0, 20)) {
      console.log(`  ${p}`);
    }
    if (localFiles.length > 20) {
      console.log(`  ... and ${localFiles.length - 20} more`);
    }
  }
}

async function handleRevParse(refs, options) {
  const { getBranches, getSnapshotByRef } = await loadRefsModule();
  const root = requireRoot();
  const targets = refs.length ? refs : ["HEAD"];

  if (options.abbrevRef) {
    const { current, branches } = getBranches(root);
    for (const ref of targets) {
      if (ref === "HEAD") {
        console.log(current || "main");
      } else if (branches[ref]) {
        console.log(ref);
      } else {
        throw new Error(`No branch matching '${ref}' found.`);
      }
    }
    return;
  }

  for (const ref of targets) {
    const snapshot = getSnapshotByRef(root, ref);
    if (!snapshot) {
      throw new Error(`No snapshot matching '${ref}' found.`);
    }

    const resolved = snapshotRef(snapshot);
    console.log(options.short ? resolved.slice(0, 7) : resolved);
  }
}

function formatCliError(error) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "Unknown error");

  if (error?.code === "invalid_grant" || /\binvalid_grant\b/i.test(message)) {
    return (
      "Google OAuth token is invalid or expired (invalid_grant).\n" +
      "Run `aethel auth` to sign in again. If that still fails, delete the saved token.json and retry."
    );
  }

  return message;
}

async function handleRestore(paths, options) {
  if (options.staged) {
    await handleReset(paths, { all: paths.length === 0 });
    return;
  }

  const source = options.source || "HEAD";
  const rootForSnapshot = requireRoot();
  const { getSnapshotByRef } = await loadRefsModule();
  const snapshot = getSnapshotByRef(rootForSnapshot, source);

  if (!snapshot) {
    if (source === "HEAD" || source === "latest") {
      console.log("No snapshot to restore from. Run 'aethel commit' first.");
    } else {
      console.log(`No snapshot matching '${source}' found.`);
    }
    return;
  }

  const repo = await openRepo(options);
  const root = repo.root;
  const remoteFiles = snapshot.files || {};

  for (const targetPath of paths) {
    // Find the file in the snapshot by path
    const entry = Object.values(remoteFiles).find(
      (f) => f.path === targetPath || f.localPath === targetPath
    );

    if (!entry) {
      console.log(`  Not found in snapshot: ${targetPath}`);
      continue;
    }

    const localDest = assertInsideRoot(root, entry.localPath || entry.path);
    const spinner = createSpinner(`Restoring ${targetPath}...`);

    try {
      const meta = await repo.drive.files.get({
        fileId: entry.id,
        fields: "id,name,mimeType",
      });

      const { downloadFile } = await import("./core/drive-api.js");
      await downloadFile(repo.drive, { ...meta.data, id: entry.id }, localDest);
      spinner.succeed(`Restored: ${targetPath}`);
    } catch (err) {
      spinner.fail(`Failed to restore ${targetPath}: ${err.message}`);
    }
  }
}

async function handleCheckout(args, options) {
  const targets = [...(args || [])];
  if (targets[0] === "--") {
    targets.shift();
  }

  if (options.branch) {
    await handleSwitch(options.branch, { create: true, startPoint: targets[0] || "HEAD" });
    return;
  }

  if (targets.length === 1) {
    const root = requireRoot();
    const { getBranches } = await loadRefsModule();
    if (getBranches(root).branches[targets[0]]) {
      await handleSwitch(targets[0], { create: false });
      return;
    }
  }

  if (targets.length === 0) {
    throw new Error("checkout requires a branch name, -b <branch>, or path.");
  }

  await handleRestore(targets, { ...options, source: "HEAD" });
}

async function handleRm(paths, options) {
  const { ChangeType } = await loadDiffModule();
  const repo = await openRepo(options);
  const { diff } = await loadStateWithProgress(repo);
  const root = repo.root;

  for (const targetPath of paths) {
    const localAbs = assertInsideRoot(root, targetPath);
    if (fs.existsSync(localAbs)) {
      await fs.promises.rm(localAbs, { recursive: true });
      console.log(`  Deleted locally: ${targetPath}`);
    }

    const remoteChange = diff.changes.find(
      (c) => c.path === targetPath && c.fileId
    );
    if (remoteChange) {
      repo.stageChange({
        ...remoteChange,
        changeType: ChangeType.LOCAL_DELETED,
        suggestedAction: "delete_remote",
      });
      console.log(`  Staged remote deletion: ${targetPath}`);
    } else {
      // After local delete, rescan will pick it up as local_deleted
      console.log(`  Removed: ${targetPath} (re-run 'aethel status' to see changes)`);
    }
  }
}

async function handleMv(source, dest, options) {
  const root = requireRoot();

  const srcAbs = assertInsideRoot(root, source);
  const destAbs = assertInsideRoot(root, dest);

  if (!fs.existsSync(srcAbs)) {
    console.log(`Source not found: ${source}`);
    return;
  }

  // Ensure destination directory exists
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await fs.promises.rename(srcAbs, destAbs);
  console.log(`  Moved: ${source} → ${dest}`);
  console.log("  Run 'aethel status' to see the resulting changes (old path deleted, new path added).");
}

async function handleVerify(options) {
  const checkRemote = Boolean(options.remote);
  const repo = checkRemote
    ? await openRepo(options)
    : await createRepository(requireRoot());

  const snapshot = repo.getSnapshot();
  if (!snapshot) {
    console.log("No snapshot to verify. Run 'aethel commit' first.");
    return;
  }

  const localCount = Object.keys(snapshot.localFiles || {}).filter(
    (k) => !snapshot.localFiles[k].isFolder
  ).length;
  const remoteCount = checkRemote ? Object.keys(snapshot.files || {}).length : 0;
  const total = localCount + remoteCount;

  const bar = createProgressBar("Verifying", total);
  const result = await repo.verify({
    checkRemote,
    onProgress(done) { bar.update(done); },
  });

  // Snapshot integrity
  if (result.snapshot.valid) {
    bar.done(`Verification complete`);
    console.log(`\n  Snapshot: ✔ ${result.snapshot.reason}`);
  } else {
    bar.done(`Verification found issues`);
    console.log(`\n  Snapshot: ✖ ${result.snapshot.reason}`);
  }

  // Local issues
  if (result.local.length) {
    console.log(`\n  Local issues (${result.local.length}):`);
    for (const e of result.local) {
      if (e.status === "missing") {
        console.log(`    ✖ ${e.path}  — file missing`);
      } else if (e.status === "modified") {
        console.log(`    ✖ ${e.path}  — md5 mismatch (expected ${e.expected.slice(0, 8)}, got ${e.actual.slice(0, 8)})`);
      }
    }
  } else {
    console.log(`  Local files: ✔ ${localCount} file(s) verified`);
  }

  // Remote issues
  if (checkRemote) {
    if (result.remote.length) {
      console.log(`\n  Remote issues (${result.remote.length}):`);
      for (const e of result.remote) {
        if (e.status === "deleted_remote") {
          console.log(`    ✖ ${e.path}  — deleted on Drive`);
        } else if (e.status === "modified_remote") {
          console.log(`    ✖ ${e.path}  — md5 mismatch (expected ${e.expected.slice(0, 8)}, got ${e.actual.slice(0, 8)})`);
        }
      }
    } else {
      console.log(`  Remote files: ✔ ${remoteCount} file(s) verified`);
    }
  }

  if (result.ok) {
    console.log("\n✔ All integrity checks passed.");
  } else {
    console.log("\n✖ Integrity issues detected. Run 'aethel status' to review.");
    process.exitCode = 1;
  }
}

async function handleTui(options) {
  const repo = await openRepo(options, { requireWorkspace: false, silent: true });
  const { runTui } = await loadTuiModule();
  const cliArgs = [];
  if (options.credentials) {
    cliArgs.push("--credentials", options.credentials);
  }
  if (options.token) {
    cliArgs.push("--token", options.token);
  }
  await runTui({
    repo,
    includeSharedDrives: Boolean(options.sharedDrives),
    cliPath: path.resolve(process.argv[1]),
    cliArgs,
  });
}

function printDedupeSummary(result) {
  for (const group of result.duplicateFolders) {
    console.log(
      `- ${group.path} | canonical=${group.canonical.id} | duplicates=${group.folders.length}`
    );
  }
  console.log(`Duplicate paths: ${result.duplicatePaths}`);
  console.log(`Moved items: ${result.movedItems}`);
  console.log(`Trashed duplicate files: ${result.trashedDuplicateFiles}`);
  console.log(`Trashed folders: ${result.trashedFolders}`);
  console.log(`Skipped conflicts: ${result.skippedConflicts}`);
  console.log(`Remaining duplicate paths: ${result.remainingDuplicateFolders.length}`);
}

function printDedupeFilesSummary(result) {
  for (const group of result.duplicateFiles) {
    console.log(
      `- ${group.path} | latest=${group.latest.id} | duplicates=${group.files.length}`
    );
    for (const older of group.older) {
      console.log(
        `    older=${older.id} modified=${older.modifiedTime || "unknown"}`
      );
    }
  }
  console.log(`Duplicate file paths: ${result.duplicatePaths}`);
  console.log(`Kept latest files: ${result.keptFiles}`);
  console.log(`Trashed older files: ${result.trashedFiles}`);
  console.log(`Errors: ${result.errors.length}`);
  console.log(`Remaining duplicate file paths: ${result.remainingDuplicateFiles.length}`);
}

async function handleDedupeFolders(options) {
  const { dedupeDuplicateFolders, DuplicateFoldersError } = await loadDriveApiModule();
  const repo = await openRepo(options);
  const config = repo.getConfig();
  const rootFolderId = config.drive_folder_id || null;
  const ignoreRules = loadIgnoreRules(repo.root);
  const dedupeSpinner = createSpinner("Scanning for duplicate folders...");
  const result = await dedupeDuplicateFolders(repo.drive, rootFolderId, {
    execute: Boolean(options.execute),
    ignoreRules,
    onProgress: (event) => {
      if (!options.execute) {
        return;
      }

      if (event.type === "move") {
        console.log(`  moved ${event.itemType}: ${event.path}`);
        return;
      }

      if (event.type === "trash_duplicate_file") {
        console.log(`  trashed duplicate file: ${event.path}`);
        return;
      }

      if (event.type === "trash_folder") {
        console.log(`  trashed folder: ${event.path}`);
        return;
      }

      if (event.type === "skip_conflict") {
        console.log(`  skipped conflict: ${event.path}`);
      }
    },
  });

  dedupeSpinner.succeed(`Scan complete — ${result.duplicateFolders.length} duplicate group(s) found`);

  if (result.duplicateFolders.length === 0) {
    return;
  }

  console.log(options.execute ? "Execution summary:" : "Dry run summary:");
  printDedupeSummary(result);

  if (options.execute) {
    repo.invalidateRemoteCache();
    if (result.remainingDuplicateFolders.length > 0) {
      throw new DuplicateFoldersError(result.remainingDuplicateFolders);
    }
  }
}

async function handleDedupeFiles(options) {
  const { dedupeDuplicateFiles } = await loadDriveApiModule();
  const repo = await openRepo(options);
  const config = repo.getConfig();
  const rootFolderId = config.drive_folder_id || null;
  const ignoreRules = loadIgnoreRules(repo.root);
  const dedupeSpinner = createSpinner("Scanning for duplicate files...");
  const result = await dedupeDuplicateFiles(repo.drive, rootFolderId, {
    execute: Boolean(options.execute),
    ignoreRules,
    onProgress: (event) => {
      if (!options.execute) {
        return;
      }

      if (event.type === "trash_duplicate_file") {
        console.log(`  trashed older file: ${event.path} (${event.fileId})`);
        return;
      }

      if (event.type === "error") {
        console.log(`  ERROR: ${event.path} (${event.fileId}) ${event.message}`);
      }
    },
  });

  dedupeSpinner.succeed(`Scan complete - ${result.duplicateFiles.length} duplicate file group(s) found`);

  if (result.duplicateFiles.length === 0) {
    return;
  }

  console.log(options.execute ? "Execution summary:" : "Dry run summary:");
  printDedupeFilesSummary(result);

  if (options.execute) {
    repo.invalidateRemoteCache();
  }
}

async function main() {
  const program = new Command();

  program
    .name("aethel")
    .version(versionString, "--version")
    .description("Git-like Google Drive sync management and cleanup")
    .showHelpAfterError();

  addAuthOptions(
    program
      .command("auth")
      .description("Run OAuth initialization and verify Google Drive access")
  ).action(handleAuth);

  addAuthOptions(
    program
      .command("clone")
      .description("Clone a Drive folder into a new Aethel workspace")
      .argument("<drive-folder>", "Drive folder ID, Drive folder URL, or my-drive")
      .argument("[directory]", "Directory to create")
      .option("--drive-folder-name <name>", "Display name for the Drive folder")
      .option("--no-checkout", "Create the workspace without downloading files")
      .option("-m, --message <message>", "Snapshot message", "clone")
  ).action((remote, directory, options) => handleClone(remote, directory, options));

  addAuthOptions(
    program
      .command("clean")
      .description("List accessible Drive files and optionally trash or delete them")
      .option("--ignored", "Only clean remote files that match this workspace's .aethelignore")
      .option("--shared-drives", "Include shared drives")
      .option("--permanent", "Permanently delete files instead of moving them to trash")
      .option("--execute", "Execute the selected operation")
      .option("--confirm <phrase>", "Confirmation phrase required for --execute", "")
  ).action(handleClean);

  addAuthOptions(
    program
      .command("init")
      .description("Initialise a sync workspace")
      .option("--local-path <path>", "Local directory to sync", ".")
      .option("--drive-folder <id>", "Drive folder ID to sync (omit for interactive selection)")
      .option("--drive-folder-name <name>", "Display name for the Drive folder")
  ).action(handleInit);

  addAuthOptions(
    program.command("status").description("Show sync status")
      .option("-v, --verbose", "Show all pack states including synced")
      .option("-s, --short", "Give the output in short format")
      .option("--detail", "Show every file-level change instead of folder summaries")
  ).action(handleStatus);

  addAuthOptions(
    program
      .command("diff")
      .description("Show detailed changes")
      .option("--side <side>", "Which side to show: remote, local, or all", "all")
      .option("--staged", "Show staged sync operations")
      .option("--cached", "Alias for --staged")
      .option("--detail", "Show every file-level change with metadata")
  ).action(handleDiff);

  addAuthOptions(
    program
      .command("add")
      .description("Stage changes for commit")
      .argument("[paths...]", "Paths or glob patterns to stage")
      .option("--all, -a", "Stage all changes")
      .option("-A", "Alias for --all")
  ).action((paths, options) => handleAdd(paths, options));

  program
    .command("reset")
    .description("Unstage changes")
    .argument("[paths...]", "Paths to unstage; accepts optional HEAD like git reset HEAD <path>")
    .option("--all", "Unstage everything")
    .action((paths, options) => handleReset(paths, options));

  addAuthOptions(
    program
      .command("commit")
      .description("Apply staged changes and save snapshot")
      .option("-m, --message <message>", "Commit message")
  ).action(handleCommit);

  program
    .command("log")
    .description("Show commit history")
    .option("-n, --limit <number>", "Number of entries to show", Number, 10)
    .option("--oneline", "Show one compact line per snapshot")
    .option("--stat", "Show snapshot file counts")
    .action(handleLog);

  program
    .command("branch")
    .description("List, create, or delete Aethel branch refs")
    .argument("[args...]", "Branch name and optional start point")
    .option("-a, --all", "Show all known branches")
    .option("-v, --verbose", "Show branch remote target")
    .option("-d, --delete", "Delete branches")
    .option("-f, --force", "Replace an existing branch when creating")
    .action((args, options) => handleBranch(args, options));

  program
    .command("switch")
    .description("Switch Aethel's current branch ref")
    .argument("<branch>", "Branch to switch to")
    .argument("[start-point]", "Snapshot ref for -c")
    .option("-c, --create", "Create the branch before switching")
    .action((branch, startPoint, options) => handleSwitch(branch, { ...options, startPoint }));

  program
    .command("tag")
    .description("Create, list, or delete snapshot tags")
    .argument("[args...]", "Tag name and optional snapshot ref")
    .option("-l, --list", "List tags")
    .option("-d, --delete", "Delete tags")
    .option("-f, --force", "Replace an existing tag")
    .option("-v, --verbose", "Show tag refs and messages")
    .action((args, options) => handleTag(args, options));

  program
    .command("remote")
    .description("Manage or inspect the Drive remote")
    .argument("[subcommand]", "show, get-url, or omitted")
    .argument("[args...]", "Remote arguments")
    .option("-v, --verbose", "Show fetch and push URLs")
    .option("--remote-name <name>", "Remote name to display", "origin")
    .action((subcommand, args, options) => handleRemote(subcommand, args, options));

  addAuthOptions(program.command("fetch").description("Check remote state")).action(
    handleFetch
  );

  addAuthOptions(
    program
      .command("dedupe-folders")
      .description("Detect and optionally remediate duplicate remote folders")
      .option("--execute", "Move items and trash empty duplicate folders")
  ).action(handleDedupeFolders);

  addAuthOptions(
    program
      .command("dedupe-files")
      .description("Detect duplicate remote files and trash older copies")
      .option("--execute", "Trash older duplicate files, keeping the latest modified file")
  ).action(handleDedupeFiles);

  addAuthOptions(
    program
      .command("pull")
      .description("Download remote changes")
      .argument("[paths...]", "Specific paths to pull (default: all)")
      .option("--all", "Download all remote files regardless of snapshot state")
      .option("-m, --message <message>", "Commit message")
      .option("--force", "Force-pull conflicts (remote wins)")
      .option("--dry-run", "Preview changes without applying")
      .option("--dry-run-limit <number>", "Limit dry-run preview entries")
      .option("--debug", "Show debug timings on stderr")
  ).action((paths, options) => handlePull(paths, options));

  addAuthOptions(
    program
      .command("push")
      .description("Upload local changes")
      .argument("[paths...]", "Specific paths to push (default: all)")
      .option("-m, --message <message>", "Commit message")
      .option("--force", "Force-push conflicts (local wins)")
      .option("--dry-run", "Preview changes without applying")
      .option("--dry-run-limit <number>", "Limit dry-run preview entries")
      .option("--debug", "Show debug timings on stderr")
  ).action((paths, options) => handlePush(paths, options));

  addAuthOptions(
    program
      .command("resolve")
      .description("Resolve file conflicts")
      .argument("[paths...]", "Conflicted paths to resolve (default: all)")
      .option("--keep <side>", "Git-style conflict choice: local, remote, or both")
      .option("--ours", "Keep local version (upload to Drive)")
      .option("--theirs", "Keep remote version (download from Drive)")
      .option("--both", "Keep both versions (remote saved as .remote copy)")
  ).action((paths, options) => handleResolve(paths, options));

  program
    .command("ignore")
    .description("Manage .aethelignore patterns")
    .argument("<subcommand>", "list, test, or create")
    .argument("[paths...]", "Paths to test (for 'test' subcommand)")
    .action((subcommand, paths) => handleIgnore(subcommand, paths));

  program
    .command("show")
    .description("Show details of a commit/snapshot")
    .argument("[ref]", "Snapshot reference (HEAD, branch, tag, or timestamp prefix)", "HEAD")
    .option("-v, --verbose", "Show all files with checksums")
    .option("--stat", "Show snapshot file counts")
    .option("--oneline", "Show compact snapshot summary")
    .action((ref, options) => handleShow(ref, options));

  program
    .command("rev-parse")
    .description("Resolve branch, tag, or snapshot refs")
    .argument("[refs...]", "Refs to resolve (default: HEAD)")
    .option("--abbrev-ref", "Show the branch name for HEAD or branch refs")
    .option("--short", "Show a short snapshot ref")
    .action((refs, options) => handleRevParse(refs, options));

  addAuthOptions(
    program
      .command("restore")
      .description("Restore file(s) from a snapshot")
      .option("--source <ref>", "Snapshot source to restore from (HEAD, branch, tag, or timestamp)", "HEAD")
      .option("--staged", "Unstage paths instead of restoring files")
      .argument("<paths...>", "Paths to restore")
  ).action((paths, options) => handleRestore(paths, options));

  addAuthOptions(
    program
      .command("checkout")
      .description("Switch branches or restore paths from HEAD")
      .argument("[args...]", "Branch name, -b branch, or paths to restore")
      .option("-b, --branch <branch>", "Create and switch to a new branch")
  ).action((args, options) => handleCheckout(args, options));

  addAuthOptions(
    program
      .command("rm")
      .description("Delete file(s) locally and stage remote deletion")
      .argument("<paths...>", "Paths to remove")
  ).action((paths, options) => handleRm(paths, options));

  program
    .command("mv")
    .description("Move/rename a file locally")
    .argument("<source>", "Source path (relative to workspace)")
    .argument("<dest>", "Destination path (relative to workspace)")
    .action((source, dest, options) => handleMv(source, dest, options));

  addAuthOptions(
    program
      .command("verify")
      .description("Verify file integrity against last snapshot")
      .option("--remote", "Also verify remote files on Drive (requires network)")
  ).action(handleVerify);

  addAuthOptions(
    program
      .command("tui")
      .description("Launch the interactive Ink terminal UI")
      .option("--shared-drives", "Include shared drives")
  ).action(handleTui);

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(`Error: ${formatCliError(error)}`);
  process.exitCode = 1;
});
