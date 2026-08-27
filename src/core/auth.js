import fs from "node:fs/promises";
import fsSyncFallback from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { loadGoogleApi } from "./google-api.js";
import open from "open";

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const DEFAULT_CREDENTIALS_PATH = "credentials.json";
const DEFAULT_TOKEN_PATH = "token.json";
const CONFIG_DIR = path.join(os.homedir(), ".config", "aethel");
const AUTH_TIMEOUT_MS = 120_000;

// ── Path resolution ─────────────────────────────────────────────────

function resolvePath(candidatePath, fallbackFileName) {
  if (candidatePath) {
    return path.isAbsolute(candidatePath)
      ? candidatePath
      : path.resolve(process.cwd(), candidatePath);
  }
  // Also check cwd before falling back to ~/.config/aethel/
  const cwdPath = path.resolve(process.cwd(), fallbackFileName);
  if (fsSyncFallback.existsSync(cwdPath)) {
    return cwdPath;
  }
  return path.join(CONFIG_DIR, fallbackFileName);
}

export { CONFIG_DIR };

/**
 * Copy a credentials file into ~/.config/aethel/ so future commands
 * work without --credentials. No-op if the file is already there.
 */
export async function persistCredentials(sourcePath) {
  const dest = path.join(CONFIG_DIR, DEFAULT_CREDENTIALS_PATH);
  const resolved = path.resolve(sourcePath);
  if (resolved === dest) return;
  if (fsSyncFallback.existsSync(dest)) return;
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.copyFile(resolved, dest);
  await fs.chmod(dest, 0o600);
}

export function resolveCredentialsPath(customPath) {
  return resolvePath(
    customPath || process.env.GOOGLE_DRIVE_CREDENTIALS_PATH,
    DEFAULT_CREDENTIALS_PATH
  );
}

export function resolveTokenPath(customPath) {
  return resolvePath(
    customPath || process.env.GOOGLE_DRIVE_TOKEN_PATH,
    DEFAULT_TOKEN_PATH
  );
}

// ── Credential helpers ──────────────────────────────────────────────

async function loadClientConfig(credentialsPath) {
  let raw;
  try {
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    throw new Error(
      `OAuth credentials file not found: ${credentialsPath}\n\n` +
      "Setup steps:\n" +
      "  1. Go to https://console.cloud.google.com/\n" +
      "  2. Create a project and enable the Google Drive API\n" +
      "  3. Create an OAuth 2.0 Client ID (Desktop application)\n" +
      "  4. Download the credentials JSON and save it as:\n" +
      `     ${path.join(CONFIG_DIR, DEFAULT_CREDENTIALS_PATH)}\n\n` +
      "Or pass a custom path:\n" +
      "  aethel auth --credentials /path/to/credentials.json"
    );
  }

  const content = JSON.parse(raw);
  const config = content.installed || content.web;

  if (!config?.client_id || !config?.client_secret) {
    throw new Error("OAuth credentials JSON is missing client configuration.");
  }

  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    redirectUris: config.redirect_uris || [],
  };
}

async function createOAuthClient(config, redirectUri) {
  const fallbackRedirect =
    config.redirectUris.find(
      (uri) =>
        uri.startsWith("http://localhost") || uri.startsWith("http://127.0.0.1")
    ) ||
    config.redirectUris[0] ||
    "http://127.0.0.1";

  const { OAuth2 } = await loadGoogleApi();
  return new OAuth2(
    config.clientId,
    config.clientSecret,
    redirectUri || fallbackRedirect
  );
}

async function persistToken(tokenPath, credentials) {
  await fs.mkdir(path.dirname(path.resolve(tokenPath)), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
}

function attachTokenPersistence(client, tokenPath) {
  client.on("tokens", (tokens) => {
    if (!tokens || Object.keys(tokens).length === 0) return;
    persistToken(tokenPath, { ...client.credentials, ...tokens });
  });
}

// ── Token loading & validation ──────────────────────────────────────

function isTokenExpired(token) {
  if (!token.expiry_date) return false;
  return Date.now() >= token.expiry_date - 30_000;
}

async function loadCachedClient(config, tokenPath) {
  let raw;
  try {
    raw = await fs.readFile(tokenPath, "utf8");
  } catch {
    return null;
  }

  const token = JSON.parse(raw);

  if (!token.access_token && !token.refresh_token) {
    return null;
  }

  const client = await createOAuthClient(config);
  attachTokenPersistence(client, tokenPath);
  client.setCredentials(token);

  // Only hit the network if the access token is expired / missing.
  // If a refresh_token exists, googleapis will refresh automatically
  // on the first real API call, so we can skip validation here when
  // the token looks fresh.
  if (token.refresh_token && !isTokenExpired(token)) {
    return client;
  }

  try {
    await client.getAccessToken();
    await persistToken(tokenPath, client.credentials);
    return client;
  } catch (err) {
    // Only fall through to browser auth for auth-specific errors.
    // Network errors should propagate so the user knows what happened.
    const status = err?.response?.status;
    if (status === 401 || status === 403 || err?.code === "invalid_grant") {
      return null;
    }
    throw err;
  }
}

// ── Browser OAuth flow ──────────────────────────────────────────────

async function runLocalServerAuth(config, tokenPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let oauthClient = null;
    let timer = null;

    const finish = (error, client) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => {
        if (error) reject(error);
        else resolve(client);
      });
    };

    const server = http.createServer(async (req, res) => {
      try {
        if (!oauthClient) {
          res.statusCode = 503;
          res.end("OAuth client is not ready.");
          return;
        }

        const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
        const code = requestUrl.searchParams.get("code");
        const authError = requestUrl.searchParams.get("error");

        if (authError) {
          res.statusCode = 400;
          res.end("Authentication failed. The terminal will show the error.");
          finish(new Error(`OAuth authorization failed: ${authError}`));
          return;
        }

        if (!code) {
          res.statusCode = 400;
          res.end("Authorization code is missing.");
          return;
        }

        const { tokens } = await oauthClient.getToken(code);
        oauthClient.setCredentials(tokens);
        await persistToken(tokenPath, oauthClient.credentials);
        res.end("Authentication completed. This browser tab can be closed.");
        finish(null, oauthClient);
      } catch (error) {
        res.statusCode = 500;
        res.end("Authentication failed. See the terminal for details.");
        finish(error);
      }
    });

    server.on("error", (error) => finish(error));

    server.listen(0, "127.0.0.1", async () => {
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

        oauthClient = await createOAuthClient(config, redirectUri);
        attachTokenPersistence(oauthClient, tokenPath);

        const authUrl = oauthClient.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: SCOPES,
        });

        console.log("Opening browser for Google OAuth...");
        console.log(`If the browser does not open, visit:\n${authUrl}`);
        await open(authUrl).catch(() => undefined);

        timer = setTimeout(() => {
          finish(
            new Error(
              `OAuth timed out after ${AUTH_TIMEOUT_MS / 1000}s. Re-run 'aethel auth' to retry.`
            )
          );
        }, AUTH_TIMEOUT_MS);
      } catch (error) {
        finish(error);
      }
    });
  });
}

// ── Singleton auth manager ──────────────────────────────────────────

let _authPromise = null;
let _authKey = null;

function authCacheKey(credentialsPath, tokenPath) {
  return `${credentialsPath}\0${tokenPath}`;
}

/**
 * Return an authenticated OAuth2 client.  Concurrent callers with the
 * same credential+token paths share a single in-flight auth attempt,
 * preventing duplicate browser prompts and token-refresh races.
 */
export async function getAuthClient(credentialsPath, tokenPath) {
  const resolvedCredentials = resolveCredentialsPath(credentialsPath);
  const resolvedToken = resolveTokenPath(tokenPath);
  const key = authCacheKey(resolvedCredentials, resolvedToken);

  if (_authPromise && _authKey === key) {
    return _authPromise;
  }

  _authKey = key;
  _authPromise = (async () => {
    const config = await loadClientConfig(resolvedCredentials);
    const cached = await loadCachedClient(config, resolvedToken);
    return cached || (await runLocalServerAuth(config, resolvedToken));
  })();

  try {
    return await _authPromise;
  } catch (error) {
    // Clear the cache on failure so the next call retries.
    _authPromise = null;
    _authKey = null;
    throw error;
  }
}

/**
 * Force a new browser OAuth flow, ignoring any cached token.
 * Used by `aethel auth` so a stale token cannot block re-authentication.
 */
export async function refreshAuthClient(credentialsPath, tokenPath) {
  const resolvedCredentials = resolveCredentialsPath(credentialsPath);
  const resolvedToken = resolveTokenPath(tokenPath);
  const key = authCacheKey(resolvedCredentials, resolvedToken);

  _authKey = key;
  _authPromise = (async () => {
    const config = await loadClientConfig(resolvedCredentials);
    return runLocalServerAuth(config, resolvedToken);
  })();

  try {
    return await _authPromise;
  } catch (error) {
    _authPromise = null;
    _authKey = null;
    throw error;
  }
}

/** Clear the singleton so the next call re-authenticates. */
export function resetAuth() {
  _authPromise = null;
  _authKey = null;
}

/**
 * High-level entry point: returns a googleapis drive client.
 * Kept for backwards compatibility — prefer getAuthClient + loadGoogleApi
 * for finer control.
 */
export async function authenticate(credentialsPath, tokenPath, options = {}) {
  const [authClient, { drive }] = await Promise.all([
    options.force
      ? refreshAuthClient(credentialsPath, tokenPath)
      : getAuthClient(credentialsPath, tokenPath),
    loadGoogleApi(),
  ]);
  return drive({ version: "v3", auth: authClient });
}
