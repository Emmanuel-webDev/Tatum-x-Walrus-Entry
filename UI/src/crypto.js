// crypto.js — AES-256-GCM encryption via the Web Crypto API.
// Keys and IVs never leave the browser in plaintext.

import CONFIG from "./config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function bufferToHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToUint8(hex) {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── Key management ────────────────────────────────────────────────────────────

async function generateKey() {
  return crypto.subtle.generateKey(
    { name: CONFIG.AES_ALGORITHM, length: CONFIG.AES_KEY_LENGTH },
    true,
    ["encrypt", "decrypt"],
  );
}

async function exportKeyB64(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64url(raw);
}

async function importKeyB64(b64) {
  const raw = fromBase64url(b64);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: CONFIG.AES_ALGORITHM },
    false,
    ["decrypt"],
  );
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypt a File with AES-256-GCM in the browser.
 * @param {File} file
 * @returns {Promise<{ ciphertext: Uint8Array, keyB64: string, ivHex: string }>}
 */
export async function encryptFile(file) {
  const plaintext = await file.arrayBuffer();
  const key = await generateKey();
  const iv = crypto.getRandomValues(new Uint8Array(CONFIG.IV_LENGTH_BYTES));

  const encrypted = await crypto.subtle.encrypt(
    { name: CONFIG.AES_ALGORITHM, iv },
    key,
    plaintext,
  );

  return {
    ciphertext: new Uint8Array(encrypted),
    keyB64: await exportKeyB64(key),
    ivHex: bufferToHex(iv),
  };
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

/**
 * Decrypt ciphertext fetched from Walrus.
 * @param {Uint8Array} ciphertext
 * @param {string} keyB64  — base64url AES key
 * @param {string} ivHex   — hex IV
 * @returns {Promise<ArrayBuffer>}
 */
export async function decryptBlob(ciphertext, keyB64, ivHex) {
  const key = await importKeyB64(keyB64);
  const iv = hexToUint8(ivHex);
  return crypto.subtle.decrypt(
    { name: CONFIG.AES_ALGORITHM, iv },
    key,
    ciphertext,
  );
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate key and IV format before hitting the network.
 * Returns an error string or null if valid.
 * @param {string} keyB64
 * @param {string} ivHex
 * @returns {string|null}
 */
export function validateKeyAndIV(keyB64, ivHex) {
  if (!keyB64?.trim()) return "Decryption key is missing.";
  if (!ivHex?.trim()) return "IV is missing.";

  try {
    const raw = fromBase64url(keyB64);
    if (raw.length !== 32)
      return `Invalid key length: expected 32 bytes, got ${raw.length}.`;
  } catch {
    return "Invalid key format. Must be base64url encoded.";
  }

  const clean = ivHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{24}$/.test(clean)) {
    return `Invalid IV: expected 24 hex characters (12 bytes), got "${ivHex}".`;
  }

  return null;
}

// ── Share link ────────────────────────────────────────────────────────────────

/**
 * Build a share link.
 * Format: #blobId:ivHex:keyB64:encodedFilename:encodedMimeType
 * The fragment is never sent to any server — it only lives in the browser.
 */
export function buildShareLink(
  blobId,
  ivHex,
  keyB64,
  filename = "",
  mimeType = "",
) {
  const parts = [
    blobId,
    ivHex,
    keyB64,
    encodeURIComponent(filename),
    encodeURIComponent(mimeType),
  ].join(":");
  return `${location.origin}${location.pathname}#${parts}`;
}

/**
 * Parse a share link fragment.
 * Returns null if the fragment is not a valid vault share link.
 * @param {string} hash — location.hash value
 */
export function parseShareLink(hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw.split(":");
  if (parts.length < 3) return null;

  const [blobId, ivHex, keyB64, encodedName = "", encodedMime = ""] = parts;
  if (!blobId || !ivHex || !keyB64) return null;

  return {
    blobId,
    ivHex,
    keyB64,
    filename: encodedName ? decodeURIComponent(encodedName) : "",
    mimeType: encodedMime
      ? decodeURIComponent(encodedMime)
      : "application/octet-stream",
  };
}
