// walrus.js — Walrus decentralized storage via the public HTTP API.
// Docs: https://docs.walrus.site/usage/web-api.html
//
// Upload:  PUT  {publisher}/v1/blobs?epochs=N   → body: raw bytes
// Download: GET  {aggregator}/v1/blobs/{blobId} → body: raw bytes
//
// Upload response shapes (from official docs):
//  { newlyCreated:   { blobObject: { blobId, storage: { endEpoch } } } }
//  { alreadyCertified: { blobId, endEpoch } }

import CONFIG from "./config.js";

// Fallback publishers tried in order on 5xx errors
const PUBLISHERS = [
  CONFIG.WALRUS_PUBLISHER_URL,
  "https://publisher.walrus-testnet.walrus.space",
  "https://wal-publisher-testnet.staketab.org",
].filter((v, i, a) => v && a.indexOf(v) === i); // dedup

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload encrypted bytes to Walrus.
 *
 * @param {Uint8Array}  ciphertext
 * @param {number}      [epochs]      — storage duration (default from config)
 * @param {Function}    [onProgress]  — (loaded, total) callback
 * @returns {Promise<{ blobId: string, endEpoch: number|null }>}
 */
export async function uploadToWalrus(ciphertext, epochs, onProgress) {
  const safeEpochs = Math.min(Math.max(1, epochs ?? CONFIG.WALRUS_EPOCHS), 183);
  let lastError;

  for (const base of PUBLISHERS) {
    const url = `${base}/v1/blobs?epochs=${safeEpochs}`;
    try {
      const result = await _putBlob(url, ciphertext, onProgress);
      return result;
    } catch (err) {
      const is5xx = /5\d\d|server|unavailable/i.test(err.message ?? "");
      if (!is5xx) throw err;
      console.warn(`[walrus] ${base} failed (${err.message}), trying next…`);
      lastError = err;
    }
  }

  throw new Error(
    `All Walrus publishers failed. Last: ${lastError?.message}. ` +
      "The testnet publisher may be out of WAL funds — try again in a few minutes.",
  );
}

function _putBlob(url, ciphertext, onProgress) {
  // Use XHR when a progress callback is provided, otherwise fetch
  if (typeof onProgress === "function") {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(_parseUploadResponse(xhr.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(
            new Error(`Walrus PUT failed: ${xhr.status} ${xhr.statusText}`),
          );
        }
      });

      xhr.addEventListener("error", () =>
        reject(new Error("Network error during upload")),
      );
      xhr.send(ciphertext);
    });
  }

  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  }).then(async (res) => {
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Walrus PUT failed: ${res.status} — ${txt.slice(0, 200)}`,
      );
    }
    return _parseUploadResponse(await res.text());
  });
}

/**
 * Parse the Walrus upload response.
 * Returns { blobId, endEpoch }.
 * Documented shapes from https://docs.walrus.site/usage/web-api.html
 */
function _parseUploadResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Walrus returned non-JSON: ${text.slice(0, 200)}`);
  }

  // Shape 1: newly created blob
  if (json.newlyCreated) {
    const obj = json.newlyCreated.blobObject;
    return {
      blobId: obj.blobId,
      endEpoch: obj.storage?.endEpoch ?? null,
    };
  }

  // Shape 2: already certified (same bytes already stored)
  if (json.alreadyCertified) {
    return {
      blobId: json.alreadyCertified.blobId,
      endEpoch: json.alreadyCertified.endEpoch ?? null,
    };
  }

  throw new Error(`Unexpected Walrus response: ${text.slice(0, 300)}`);
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download encrypted bytes from Walrus by blobId.
 *
 * @param {string}    blobId
 * @param {Function}  [onProgress]  — (loaded, total) callback
 * @returns {Promise<Uint8Array>}
 */
export async function downloadFromWalrus(blobId, onProgress) {
  const url = `${CONFIG.WALRUS_AGGREGATOR_URL}/v1/blobs/${encodeURIComponent(blobId)}`;

  if (typeof onProgress === "function") {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "arraybuffer";

      xhr.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(new Uint8Array(xhr.response));
        } else if (xhr.status === 404 || xhr.status === 410) {
          reject(new Error(`BLOB_NOT_FOUND:${xhr.status}`));
        } else {
          reject(new Error(`Walrus GET failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () =>
        reject(new Error("Network error during download")),
      );
      xhr.send();
    });
  }

  const res = await fetch(url);
  if (res.status === 404 || res.status === 410)
    throw new Error(`BLOB_NOT_FOUND:${res.status}`);
  if (!res.ok) throw new Error(`Walrus GET failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
