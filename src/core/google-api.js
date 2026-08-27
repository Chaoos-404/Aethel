/**
 * Narrow googleapis loader.
 *
 * `import { google } from "googleapis"` evaluates the generated client for
 * every Google API — 1-3.5s of pure module loading on every single command,
 * and Aethel only ever talks to Drive v3. The per-API entry point exposes the
 * identical `Drive` class and the identical `OAuth2` constructor, so load that
 * instead and keep the full package as a fallback in case the internal layout
 * ever changes (slow, but never broken).
 */

const DRIVE_ENTRY_POINT = "googleapis/build/src/apis/drive/index.js";

let apiPromise = null;

async function resolveGoogleApi() {
  try {
    const narrow = await import(DRIVE_ENTRY_POINT);
    if (typeof narrow.drive === "function" && typeof narrow.auth?.OAuth2 === "function") {
      return { drive: narrow.drive, OAuth2: narrow.auth.OAuth2 };
    }
  } catch {
    // Fall through to the full package.
  }

  const { google } = await import("googleapis");
  return { drive: google.drive.bind(google), OAuth2: google.auth.OAuth2 };
}

/**
 * Resolve `{ drive, OAuth2 }`. Memoised — the module graph is only
 * evaluated once per process.
 */
export function loadGoogleApi() {
  apiPromise ||= resolveGoogleApi();
  return apiPromise;
}
