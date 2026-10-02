# Test Support

This directory contains reusable fixtures and no test cases. It sits outside
`test/` so the default `node --test` discovery does not execute helper modules
as separate tests.

- `workspace.js` creates temporary directories or initialized workspaces and
  registers cleanup before further fixture setup.
- `fake-drive.js` provides the in-memory Drive client shared by API, recovery,
  and two-device integration tests. It models metadata, media, listing queries,
  and the change feed without accessing a live account.

Scenario-specific setup remains in its test file. Assertions remain visible in
the tests, and failure injection uses Node's test-context mocks for restoration.

The synchronization tests are organized by responsibility:

- `test/baseline.test.js`: pure baseline advancement.
- `test/commit-coordinator.test.js`: partial execution and persistence recovery.
- `test/workspace-lock.test.js`: process exclusion and lock release.
- `test/two-device-sync.test.js`: rename, move, and deletion across two devices.
- `test/drive-api.test.js`: Drive operations and executor integration.
- `test/logger.test.js` and `test/progress.test.js`: diagnostics and progress.

Run all tests with `npm test`, or a focused file with
`node --test test/commit-coordinator.test.js`.
