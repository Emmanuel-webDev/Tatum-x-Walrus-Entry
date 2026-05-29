// store.js — IndexedDB wrapper for persisting vault metadata locally.
// Entries are namespaced by ownerAddress so each wallet sees only its own blobs.
// Encryption keys are NEVER persisted here — they live in share links only.

const DB_NAME    = "vault_sui_db";
const DB_VERSION = 2;           // bumped from 1 → adds ownerAddress index
const STORE_NAME = "documents";

// ── Open / init ───────────────────────────────────────────────────────────────

/** @type {IDBDatabase|null} */
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db       = e.target.result;
      const oldVer   = e.oldVersion;

      // Fresh install
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "blobId" });
        store.createIndex("uploadedAt",    "uploadedAt",    { unique: false });
        store.createIndex("ownerAddress",  "ownerAddress",  { unique: false });
        return;
      }

      // Upgrade from v1 → v2: add ownerAddress index
      if (oldVer < 2) {
        const store = e.target.transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains("ownerAddress")) {
          store.createIndex("ownerAddress", "ownerAddress", { unique: false });
        }
      }
    };

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store       = transaction.objectStore(STORE_NAME);
        const req         = fn(store);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
      }),
  );
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Save a document entry tagged to an owner wallet address.
 * @param {{
 *   blobId:       string,
 *   filename:     string,
 *   mimeType:     string,
 *   sizeBytes:    number,
 *   uploadedAt:   number,
 *   ivHex:        string,
 *   ownerAddress: string,   // connected wallet address at upload time
 * }} entry
 */
export function saveEntry(entry) {
  if (!entry.ownerAddress) throw new Error("saveEntry: ownerAddress is required");
  return tx("readwrite", (store) => store.put(entry));
}

/**
 * Retrieve all documents for a specific wallet address, sorted newest first.
 * @param {string} ownerAddress
 * @returns {Promise<Array>}
 */
export function getAllEntries(ownerAddress) {
  if (!ownerAddress) return Promise.resolve([]);

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store       = transaction.objectStore(STORE_NAME);
        const index       = store.index("ownerAddress");
        const req         = index.getAll(IDBKeyRange.only(ownerAddress));

        req.onsuccess = (e) =>
          resolve(
            [...e.target.result].sort((a, b) => b.uploadedAt - a.uploadedAt)
          );
        req.onerror = (e) => reject(e.target.error);
      }),
  );
}

/**
 * Delete an entry by blobId.
 * @param {string} blobId
 */
export function deleteEntry(blobId) {
  return tx("readwrite", (store) => store.delete(blobId));
}

/**
 * Check if an entry exists.
 * @param {string} blobId
 * @returns {Promise<boolean>}
 */
export async function entryExists(blobId) {
  const result = await tx("readonly", (store) => store.get(blobId));
  return result !== undefined;
}

// ── Format helpers ────────────────────────────────────────────────────────────

export function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function truncate(str, start = 6, end = 4) {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

export function timeAgo(timestamp) {
  const diff  = Date.now() - timestamp;
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}