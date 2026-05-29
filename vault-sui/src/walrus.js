// walrus.js — Walrus decentralized storage integration.
// Handles PUT (upload) and GET (download) of encrypted blobs.

import CONFIG from "./config.js";

// ── Public publisher endpoints (testnet) ─────────────────────────────────────
// The primary publisher occasionally returns 500 when its WAL balance is
// depleted or it is overloaded — this is a known testnet limitation.
// We try each publisher in order and fall back to the next on 5xx errors.
const PUBLISHERS = [
  CONFIG.WALRUS_PUBLISHER_URL, // from config (primary)
  "https://publisher.walrus-testnet.walrus.space", // Mysten Labs official
  "https://wal-publisher-testnet.staketab.org", // Staketab community
  "https://walrus-testnet-publisher.bartestnet.com", // Bartestnet community
]
  .filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i); // deduplicate

// ── Internal fetch wrapper ────────────────────────────────────────────────────

async function tatumFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.TATUM_API_KEY,
      ...(options.headers ?? {}),
    },
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload an encrypted blob to Walrus, trying multiple publishers on 5xx.
 *
 * @param {Uint8Array} ciphertext
 * @param {number}     [epochs]      storage duration (default from CONFIG)
 * @param {function}   [onProgress]  optional (loaded, total) callback
 * @returns {Promise<string>}  the Walrus blobId
 */
export async function uploadBlob(
  ciphertext,
  epochs = CONFIG.WALRUS_EPOCHS,
  onProgress,
) {
  // Clamp epochs: testnet max is 183, and 0 causes a 400/500
  const safeEpochs = Math.min(Math.max(1, epochs ?? 3), 183);

  let lastError;

  for (const publisherBase of PUBLISHERS) {
    const url = `${publisherBase}/v1/blobs?epochs=${safeEpochs}`;

    try {
      const blobId = await _uploadToPublisher(url, ciphertext, onProgress);
      return blobId; // success — done
    } catch (err) {
      // Only retry on server errors (5xx); propagate client errors immediately
      const is5xx =
        err.message?.includes("5") ||
        err.message?.toLowerCase().includes("server") ||
        err.message?.toLowerCase().includes("500") ||
        err.message?.toLowerCase().includes("503");

      if (!is5xx) throw err;

      console.warn(
        `[walrus] Publisher ${publisherBase} failed (${err.message}), trying next…`,
      );
      lastError = err;
    }
  }

  throw new Error(
    `All Walrus publishers failed. Last error: ${lastError?.message}. ` +
      `The testnet publishers may be temporarily out of WAL funds — try again in a few minutes.`,
  );
}

/** Upload to a single publisher URL, returns blobId or throws. */
function _uploadToPublisher(url, ciphertext, onProgress) {
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
            resolve(_parseBlobId(xhr.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(
            new Error(`Walrus upload failed: ${xhr.status} ${xhr.statusText}`),
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
      const text = await res.text().catch(() => "");
      throw new Error(`Walrus upload failed: ${res.status} — ${text}`);
    }
    return _parseBlobId(await res.text());
  });
}

/** Extract blobId from Walrus publisher response JSON. */
function _parseBlobId(responseText) {
  try {
    const json = JSON.parse(responseText);
    const blobId =
      json?.newlyCreated?.blobObject?.blobId ?? json?.alreadyCertified?.blobId;
    if (!blobId) throw new Error("blobId not found in Walrus response");
    return blobId;
  } catch {
    throw new Error(
      `Unexpected Walrus response format: ${responseText.slice(0, 200)}`,
    );
  }
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download an encrypted blob from Walrus by its blobId.
 *
 * @param {string}   blobId
 * @param {function} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function downloadBlob(blobId, onProgress) {
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
        } else {
          if (xhr.status === 404) {
            reject(new Error("Document does not exist on Walrus."));
          } else {
            reject(new Error(`Walrus download failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener("error", () =>
        reject(new Error("Network error during download")),
      );
      xhr.send();
    });
  }

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Document does not exist on Walrus.");
    }

    throw new Error(`Walrus download failed: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ── Tatum RPC helpers ─────────────────────────────────────────────────────────

export async function getCurrentEpoch() {
  const res = await tatumFetch(CONFIG.SUI_RPC_URL, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "suix_getLatestSuiSystemState",
      params: [],
    }),
  });
  if (!res.ok) throw new Error(`Tatum RPC error: ${res.status}`);
  const json = await res.json();
  return Number(json?.result?.epoch ?? 0);
}
