# User Issue Log

This file tracks user-reported Aethel issues, what caused them, and whether the
project has a verified fix or only a workaround.

## Issue AETHEL-2026-05-27-001: OAuth commands fail with `invalid_grant`

- Status: Fixed in source, pending live re-auth verification
- Reported: 2026-05-27
- Commands:
  - `aethel add`
  - `aethel status`
  - `aethel auth`
- Observed output:

```text
Connection failed
Error: invalid_grant
```

### Cause

The failure happens during Google OAuth authentication before Aethel starts
loading workspace status or staging changes.

Aethel reads its cached OAuth token from the configured token path, normally
`~/.config/aethel/token.json` unless `--token` or `GOOGLE_DRIVE_TOKEN_PATH` is
set. `invalid_grant` is returned by Google's OAuth server when the cached grant
can no longer be used. Common reasons are:

- the refresh token expired or was revoked;
- the user changed Google account security settings or removed app access;
- the OAuth client credentials changed after the token was created;
- the same OAuth app issued too many refresh tokens and Google invalidated an
  older one;
- the local machine clock is far enough out of sync to make the grant invalid.

### Current workaround

Re-run authentication to replace the cached token:

```powershell
aethel auth
```

If the same error appears during `aethel auth`, remove the stale token file and
authenticate again:

```powershell
Remove-Item "$env:USERPROFILE\.config\aethel\token.json"
aethel auth
```

Use a custom token path only if the failing commands were also using that path:

```powershell
aethel auth --token <path-to-token.json>
```

### Fix status

- Diagnosis added: Yes
- User-facing recovery documented: Yes
- Code fix added: Yes
  - the CLI now translates `invalid_grant` into a recovery message
  - `aethel auth` now forces a fresh browser OAuth flow instead of reusing the
    stale cached token
- Verification status: Source tests passed; live re-auth still requires the
  user's Google browser session

### Candidate product fix

Aethel should catch OAuth `invalid_grant` failures and print a recovery-focused
message, for example:

```text
Your saved Google OAuth token is no longer valid.
Run `aethel auth` to sign in again. If that still fails, delete the saved
token.json and retry.
```

This would make the cause obvious without requiring users to know Google's OAuth
error names.

## Issue AETHEL-2026-10-10-001: A locally deleted empty folder is reported as new on Drive

- Status: Fixed in source, pending live verification on the reporting workspace
- Reported: 2026-10-10 (Aethel 1.4.0)
- Commands:
  - `aethel status`
  - `aethel push`
  - `aethel rm`
- Observed output:

```text
Remote changes (1):
  +R docs/sub  (new on Drive)
```

`aethel push` then reports `Nothing to push.`, and `aethel rm docs` prints
`Removed: docs` without staging anything.

### Cause

A push that moves or deletes the last file of a folder leaves the folder behind
on Drive and on disk. A pull that applies a remote deletion does the same,
because Drive keeps empty folders. Until then the snapshot knew the folder only
through the files inside it, and `advanceBaseline()` recorded only the paths an
operation touched, so the emptied folder never entered the snapshot.

After the folder was deleted locally, Drive listed it as an explicit empty
folder with no snapshot entry and no local counterpart. That is the
`remote_added` case, so a pull would have recreated the folder and a push had
nothing to delete. `aethel rm` matched only an exact change path, and Drive lists
only the empty leaf folders of a branch, so `rm docs` found no change to stage.

### Current workaround

Workspaces that already hold the state are not repaired by the fix, because an
empty Drive folder with no snapshot entry cannot be told apart from a folder
another device just created. With the fixed version installed, remove the
folders once and push:

```bash
aethel rm docs
aethel push
```

Deleting the folders in the Drive web UI also works.

### Fix status

- Diagnosis added: Yes
- User-facing recovery documented: Yes
- Code fix added: Yes
  - `advanceBaseline()` now records every vacated ancestor folder that the local
    scan and Drive both hold as an empty folder, as an initial sync does
  - `aethel rm` stages one remote deletion for a Drive-only folder whose
    contents are all empty folders, and exits with code 1 and `Nothing to remove`
    when there is nothing to stage
- Verification status: unit tests for `advanceBaseline()` pass; the
  end-to-end scenarios in `test/empty-folder-sync.test.js` cover a folder
  emptied by a push (file moved out, file deleted) and by a pull
