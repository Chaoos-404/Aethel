/**
 * .aethelignore support — gitignore-syntax pattern matching.
 *
 * Reads a `.aethelignore` file from the workspace root (and optionally
 * nested directories) and exposes a filter that tests relative paths.
 * Uses the `ignore` npm package which implements the full gitignore spec.
 */

import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { AETHEL_DIR } from "./config.js";

const IGNORE_FILE = ".aethelignore";

// Paths that are always ignored regardless of .aethelignore contents.
const BUILTIN_PATTERNS = [
  AETHEL_DIR,
  `${AETHEL_DIR}/**`,
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  "target",
  "target/**",
  "**/target",
  "**/target/**",
  ".DS_Store",
  "Thumbs.db",
];

// Module-level cache: avoids re-reading and re-parsing .aethelignore
// on every call within the same process.
const _cache = new Map(); // root → { mtime, rules }

/**
 * Load ignore rules from a workspace root (cached per-process).
 *
 * Returns an object with:
 *   - `ignores(relativePath)` → boolean
 *   - `filter(paths)` → filtered array of non-ignored paths
 *   - `patterns` → raw pattern strings for inspection
 */
export function loadIgnoreRules(root) {
  const resolved = path.resolve(root);
  const ignoreFile = path.join(resolved, IGNORE_FILE);

  // Check if cached version is still valid (same mtime on .aethelignore)
  let fileMtime = 0;
  try {
    fileMtime = fs.statSync(ignoreFile).mtimeMs;
  } catch {
    // File doesn't exist — that's fine, we still cache the result
  }

  const cached = _cache.get(resolved);
  if (cached && cached.mtime === fileMtime) {
    return cached.rules;
  }

  const ig = ignore.default();

  // Always ignore builtins
  ig.add(BUILTIN_PATTERNS);

  // Load .aethelignore from root
  const userPatterns = [];

  if (fileMtime > 0) {
    const content = fs.readFileSync(ignoreFile, "utf-8");
    const lines = content
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("#"));
    ig.add(lines);
    userPatterns.push(...lines);
  }

  const rules = {
    ignores(relativePath) {
      const normalized = relativePath.replace(/^\/+/, "");
      return ig.ignores(normalized);
    },

    filter(paths) {
      return ig.filter(paths.map((p) => p.replace(/^\/+/, "")));
    },

    patterns: [...BUILTIN_PATTERNS, ...userPatterns],
    userPatterns,
  };

  _cache.set(resolved, { mtime: fileMtime, rules });
  return rules;
}

/** Invalidate the cached rules for a root (call after editing .aethelignore). */
export function invalidateIgnoreCache(root) {
  _cache.delete(path.resolve(root));
}

/**
 * Create a default .aethelignore file with common patterns.
 */
export function createDefaultIgnoreFile(root) {
  const ignoreFile = path.join(root, IGNORE_FILE);

  if (fs.existsSync(ignoreFile)) {
    return false;
  }

  const content = `# Aethel ignore patterns (gitignore syntax)
# Lines starting with # are comments.
# See https://git-scm.com/docs/gitignore for pattern syntax.

# OS files
.DS_Store
Thumbs.db
desktop.ini

# Editor / IDE
.vscode/
.idea/
*.swp
*.swo
*~

# Dependencies
node_modules/
.venv/
__pycache__/

# Build output
dist/
build/
target/
*.pyc
*.o
*.so

# Secrets and credentials
.env
*.pem
*.key
credentials.json
token.json
client_secret*.json
`;

  fs.writeFileSync(ignoreFile, content);
  return true;
}
