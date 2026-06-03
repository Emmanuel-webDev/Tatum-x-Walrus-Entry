// crypto.js — AES-256-GCM encryption/decryption via the browser's Web Crypto API.
// All operations are async and return typed arrays or exportable key objects.
// Keys and IVs never leave the browser in plaintext.

import CONFIG from "./config.js";

// ── Internal helpers ────────────────────────────────────────────────────────

/** Convert an ArrayBuffer to a lowercase hex string. */
function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert a hex string to a Uint8Array. */
function hexToBuffer(hex) {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Key management ──────────────────────────────────────────────────────────

/**
 * Generate a fresh AES-256-GCM CryptoKey.
 * @returns {Promise<CryptoKey>}
 */
export async function generateKey() {
  return crypto.subtle.generateKey(
    { name: CONFIG.AES_ALGORITHM, length: CONFIG.AES_KEY_LENGTH },
    true, // extractable — needed so we can export for sharing
    ["encrypt", "decrypt"],
  );
}

/**
 * Export a CryptoKey to a URL-safe base64 string.
 * This is what gets embedded in a share link.
 * @param {CryptoKey} key
 * @returns {Promise<string>} base64url-encoded raw key bytes
 */
export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Import a base64url key string back to a CryptoKey.
 * @param {string} b64url
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: CONFIG.AES_ALGORITHM },
    true,
    ["encrypt", "decrypt"],
  );
}

// ── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt a File or Blob with AES-256-GCM.
 *
 * @param {File|Blob} file  — the plaintext file
 * @returns {Promise<{
 *   ciphertext: Uint8Array,   // encrypted bytes ready for Walrus
 *   key: CryptoKey,           // raw AES key (exportable)
 *   keyB64: string,           // base64url key for embedding in share links
 *   iv: Uint8Array,           // 12-byte IV (prepended to share payload)
 *   ivHex: string,            // hex representation of IV
 * }>}
 */
export async function encryptFile(file) {
  const plaintext = await file.arrayBuffer();
  const key = await generateKey();
  const iv = crypto.getRandomValues(new Uint8Array(CONFIG.IV_LENGTH_BYTES));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: CONFIG.AES_ALGORITHM, iv },
    key,
    plaintext,
  );

  const keyB64 = await exportKey(key);
  const ivHex = bufferToHex(iv);

  return {
    ciphertext: new Uint8Array(ciphertextBuf),
    key,
    keyB64,
    iv,
    ivHex,
  };
}

// ── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypt a ciphertext Uint8Array fetched from Walrus.
 *
 * @param {Uint8Array} ciphertext   — raw encrypted bytes from Walrus
 * @param {string}     keyB64       — base64url AES key
 * @param {string}     ivHex        — hex IV
 * @returns {Promise<ArrayBuffer>}  — decrypted plaintext
 */
export async function decryptBlob(ciphertext, keyB64, ivHex) {
  const key = await importKey(keyB64);
  const iv = hexToBuffer(ivHex);

  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 32) {
    throw new Error("Invalid encrypted document.");
  }

  return crypto.subtle.decrypt(
    { name: CONFIG.AES_ALGORITHM, iv },
    key,
    ciphertext,
  );
}

// ── Share link helpers ───────────────────────────────────────────────────────

/**
 * Build a shareable URL fragment.
 * Format: #blobId:ivHex:keyB64
 * The fragment is never sent to any server.
 *
 * @param {string} blobId
 * @param {string} ivHex
 * @param {string} keyB64
 * @returns {string}  full URL with fragment
 */
export function buildShareFragment(
  blobId,
  ivHex,
  keyB64,
  filename = "document",
  mimeType = "application/octet-stream",
) {
  const fragment = [
    blobId,
    ivHex,
    keyB64,
    encodeURIComponent(filename),
    encodeURIComponent(mimeType),
  ].join(":");
  return `${location.origin}${location.pathname}#${fragment}`;
}

/**
 * Parse a share fragment from location.hash.
 * @param {string} hash  — e.g. "#blobId:ivHex:keyB64"
 * @returns {{ blobId: string, ivHex: string, keyB64: string } | null}
 */
export function parseShareFragment(hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw.split(":");
  if (parts.length < 3) return null;

  const [
    blobId,
    ivHex,
    keyB64,
    filename = "document",
    mimeType = "application/octet-stream",
  ] = parts;
  return {
    blobId,
    ivHex,
    keyB64,
    filename: decodeURIComponent(filename),
    mimeType: decodeURIComponent(mimeType),
  };
}
