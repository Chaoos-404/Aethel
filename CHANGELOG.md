# Changelog

## 1.3.18 (2026-08-27)

- Reconcile files recreated at renamed Drive paths without false conflicts

## 1.3.17 (2026-08-27)

- Reconcile interrupted snapshots without false remote changes or unsafe deletions

## 1.3.16 (2026-08-27)

- Stop reporting identical files as conflicts and surface files that never reached Drive

## 1.3.15 (2026-08-27)

- Delete emptied folders on Drive and reduce sync startup latency

## 1.3.14 (2026-08-27)

- Fix folder rename sync across machines and speed up diff computation

## 1.3.13 (2026-08-16)

- Preserve local-only files and local modifications during pull

## 1.3.13-beta.0 (2026-08-16)

- Preserve local-only files and local modifications when pulling remote changes.

## 1.3.12 (2026-08-16)

- Fix remote folder rename pulls

## 1.3.9 (2026-06-21)

- Fix TUI refresh behavior so local edits, renames, and deletes show up without
  a manual reload, and successful Drive delete actions disappear immediately
  while Aethel reloads the Drive listing.
- Update the README and architecture docs for the refreshed TUI behavior.
- Regenerate the setup, init, and usage GIF demos at high quality while keeping
  the typewriter effect, and add a repo-local cast-to-GIF renderer.
- Improve CLI startup by lazy-loading heavier command modules and extracting
  branch/tag ref helpers.
- Harden staged sync/delete handling and coverage for Drive delete paths.

## 1.3.5 (2026-06-20)

- Keep status fast by reusing the local remote cache instead of refreshing Drive on every stale cache.

## 1.3.4 (2026-06-20)

- Improve Drive remote fetch performance with scoped folder scans and Drive-side memo caching.

## Unreleased

- Add packed-directory push and pull execution, including archive recovery
  when a previously recorded Drive archive no longer exists.
- Detect local and Drive folder renames so a sync moves or renames the folder
  once rather than needlessly reprocessing its descendants.
- Make `pull --all` retain remote-deletion operations while fully hydrating the
  current Drive state.
- Expand default ignore rules for common Python virtual-environment names and
  `uv` caches.
- Make `pull` fetch fresh Drive state by default so remote deletions are applied
  locally instead of being hidden by a stale remote cache.
- Preserve folder metadata when staging remote-deleted folders for local
  deletion.
- Fetch small configured Drive folder workspaces by walking only that folder
  tree, while keeping the global Drive listing for large snapshots.
- Store a Drive-side remote memo for large folder workspaces and refresh it
  with Drive change tokens to avoid repeated full remote listings.
- Keep `status` fast by reusing the local remote cache even after the normal
  short cache TTL expires.
- Speed up staged file transfers by carrying checksum metadata into commits,
  skipping redundant download metadata calls, and raising transfer concurrency.

## 1.3.3 (2026-06-20)

- Fix large force syncs and add debug diagnostics
- Ignore nested Rust/Tauri `target/` build directories by default.
- Skip transient local files that disappear during scan or upload instead of
  failing the sync.
- Treat stale staged uploads whose local source is gone as local deletions when
  a Drive file exists, and skip them when no remote file exists.
- Keep `push --dry-run --force` and `pull --dry-run --force` read-only and avoid
  per-conflict staging writes for large conflict sets.
- Add `--debug`/`AETHEL_DEBUG=1` diagnostics and `--dry-run-limit` for large
  `push`/`pull` dry-run previews.

## 1.3.2 (2026-06-20)

- Fix remote-deleted folder commits.

## 1.3.1 (2026-06-19)

- Fix local deletions for staged directory paths that are missing folder
  metadata by checking the filesystem before deleting.
- Report unsupported Google Workspace downloads clearly instead of attempting a
  binary Drive media download and surfacing a raw 403.
- Update `react-devtools-core` from 6.1.5 to 7.0.1.
- Update `ink` from 7.0.5 to 7.0.6.

## 1.3.0 (2026-06-19)

- Add `clean --ignored` to dry-run or trash Drive files and folders that match
  the workspace `.aethelignore`.
- Add a safer ignored-clean confirmation phrase:
  `DELETE IGNORED GOOGLE DRIVE FILES`.
- Fix partial commits so snapshots are not saved when staged operations fail.
- Resolve `delete_remote` operations by current Drive path when legacy staged
  entries do not contain a `fileId`.
- Treat already-missing path-only remote deletes as successful no-ops.
- Make `push --force` treat local state as authoritative by converting
  Drive-only additions into remote deletions.
- Collapse and deduplicate forced remote deletions to the highest missing local
  ancestor so deleted folder trees converge in one pass.
- Use cached remote state by default for `status`, `add`, `pull`, and `push`,
  while keeping `fetch` as the explicit remote refresh command.
- Include the beta CLI alias in package contents.

## 1.2.2 (2026-05-28)

- Release Git-compatible Drive sync commands and Node 18 CI fixes.
- Align CLI spellings with common Git habits:
  - `clone <drive-folder> <dir>`
  - `status --short` / `status -s`
  - `diff --staged` / `diff --cached`
  - `add -A`
  - `reset HEAD <path>`
  - `restore --staged <path>`
  - `log --oneline` / `log --stat`
  - `show --stat` / `show --oneline`
  - `rev-parse HEAD`, `rev-parse --short HEAD`, and `rev-parse --abbrev-ref HEAD`
  - `branch -v`, `branch <name> [ref]`, and `branch --delete <name>`
  - `switch <name>` and `switch -c <name> [ref]`
  - `checkout <branch>` and `checkout -b <branch> [ref]`
  - `tag <name> [ref]`, `tag --list`, and `tag --delete`
  - `remote -v`, `remote show origin`, and `remote get-url`
  - `restore --source <ref>` for `HEAD`, branch, tag, or timestamp refs
  - `checkout <path>` as a restore alias
- Reserve top-level version output for `--version` so command-level `-v`
  remains available for Git-style command flags such as `remote -v`.
- Document Git-compatible command forms in the README and architecture notes.

## 1.2.1 (2026-04-26)

- Document the `verify` integrity-check command in the README help guide.
- Add `verify` to the TUI command catalog with local and remote verification actions.
- Fix legacy local-delete staging so remote deletions can resolve Drive file IDs from the latest snapshot.
- Add a debug installer command that symlinks the working-copy CLI as `debug_aethel`.

## 1.2.0 (2026-04-15)

- Add Packing modules

## 1.1.0 (2026-04-15)

### Added
- **Directory Packing**: Pack large directories (e.g., `node_modules`) into compressed archives for faster sync
- Multi-algorithm compression support: gzip, brotli (built-in), zstd, xz (optional)
- Tree hash algorithm for fast directory fingerprinting (~30x faster than MD5)
- Pack-aware scanning that skips packed directories
- Pack change detection: PACK_NEW, PACK_LOCAL_MODIFIED, PACK_REMOTE_MODIFIED, PACK_SYNCED, PACK_CONFLICT
- `aethel status --verbose` shows synced packs
- `.aethelconfig` YAML file for packing configuration

### Changed
- Upgraded ink from 6.8.0 to 7.0.0
- Upgraded react from 19.2.4 to 19.2.5

## 1.0.0 (2026-04-06)

- release: 1.0.0

## 0.4.0 (2026-04-06)

- Add pull --all for full remote download

## 0.3.8 (2026-04-06)

- Fix Drive upload checksum test stub

## 0.3.7 (2026-04-05)

- Fix orphan checker not recognizing My Drive root — all files under synced folders were silently dropped

## 0.3.6 (2026-04-05)

- Optimize status and saveSnapshot performance: parallelize loadState, skip redundant fetches, increase hash concurrency

## 0.3.5 (2026-04-05)

- Add progress bars and spinners for all time-consuming CLI operations

## 0.3.4 (2026-04-05)

- Add empty folder sync support between local and Google Drive

## 0.3.3 (2026-04-05)

- Persist credentials to ~/.config/aethel/ after auth for seamless init

## 0.3.2 (2026-04-05)

- Add --version flag, interactive init folder selection, and release script

## 0.3.1 (2026-04-05)

- Improve setup SOP: default credentials to ~/.config/aethel/ with guided error message

## 0.3.0 (2026-04-05)

- Refactor to Repository pattern; add TUI command system with catalog, CLI runner, and tests

## 0.2.6 (2026-04-05)

- Rewrite README with clearer structure and usage examples

## 0.2.5 (2026-04-05)

- Fix Node.js v25 Proxy invariant violation in withDriveRetry

## 0.2.4 (2026-04-05)

- Fix npm publish authentication in CI workflow

## 0.2.3 (2026-04-05)

- Enable npm trusted publishing via version workflow

## 0.2.2 (2026-04-05)

- Retry npm publish after CI release attempt

## 0.2.1 (2026-04-05)

- Fix auth error propagation

## 0.2.0 (2026-04-05)

- Fix auth error propagation

## 0.1.1 (2026-04-05)

- Add retry logic for Drive API calls

## 0.1.0

- Initial npm release of the Aethel CLI and Ink TUI
- Google Drive OAuth authentication and workspace initialization
- Git-style sync workflow with snapshot, diff, staging, pull, push, and commit
- Conflict resolution, restore, ignore management, and history inspection
- Duplicate-folder detection and reconciliation for Google Drive
