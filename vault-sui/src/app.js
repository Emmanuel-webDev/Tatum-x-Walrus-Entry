// app.js — Main application controller.

import {
  encryptFile,
  decryptBlob,
  buildShareFragment,
  parseShareFragment,
} from "./crypto.js";

import { uploadBlob, downloadBlob } from "./walrus.js";

import {
  saveEntry,
  getAllEntries,
  deleteEntry,
  formatBytes,
  truncate,
  timeAgo,
} from "./store.js";

import UI from "./ui.js";

import {
  initWalletStandard,
  getWallets,
  connectWallet as connectByName,
  disconnectWallet,
  onWalletsChange,
} from "./walletStandard.js";

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Sui RPC endpoint for epoch lookup
// Replace with your preferred RPC if needed
// ─────────────────────────────────────────────────────────────────────────────

const SUI_RPC = "https://fullnode.testnet.sui.io:443";

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Walrus publisher endpoint
// Replace if using another publisher
// ─────────────────────────────────────────────────────────────────────────────

const WALRUS_PUBLISHER = "https://publisher.walrus-testnet.walrus.space";

// ── Wallet state ──────────────────────────────────────────────────────────────

let _wallet = null;
let _address = null;

/** Exported so ui.js can check connection state without accessing private vars */
export function isWalletConnected() {
  return !!_address;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init() {
  initWalletStandard();
  UI.init();

  onWalletsChange((wallets) =>
    UI.renderWalletList(wallets, _handleConnectRequest),
  );

  UI.renderWalletList(getWallets(), _handleConnectRequest);

  // Handle share links directly
  if (location.hash && location.hash.length > 1) {
    const parsed = parseShareFragment(location.hash);

    if (parsed) {
      UI.showScreen("retrieve");

      UI.prefillRetrieve(parsed.blobId, parsed.ivHex, parsed.keyB64);

      document.getElementById("retrieve-filename").value =
        parsed.filename || "document";

      document.getElementById("retrieve-mime").value =
        parsed.mimeType || "application/octet-stream";

      return;
    }
  }

  UI.showScreen("connect");
}

// ── Wallet ────────────────────────────────────────────────────────────────────

async function _handleConnectRequest(walletName) {
  UI.setConnecting(true);

  try {
    const { address, wallet } = await connectByName(walletName);

    _wallet = wallet;
    _address = address;

    UI.setConnecting(false);

    UI.setAddress(_address);

    UI.showScreen("vault");

    await refreshVault();
  } catch (err) {
    UI.setConnecting(false);
    UI.showError(err.message);
  }
}

export async function disconnectCurrentWallet() {
  if (_wallet) {
    await disconnectWallet(_wallet);
  }

  _wallet = null;
  _address = null;

  UI.showScreen("connect");
}

// ── Vault ─────────────────────────────────────────────────────────────────────

/** Load only THIS wallet's documents. */
export async function refreshVault() {
  const entries = await getAllEntries(_address);

  // ───────────────────────────────────────────────────────────────────────────
  // NEW: Attach live epoch info to every entry
  // ───────────────────────────────────────────────────────────────────────────

  const currentEpoch = await getCurrentEpoch();

  const enhancedEntries = entries.map((e) => ({
    ...e,
    currentEpoch,
    remainingEpochs:
      typeof e.endEpoch === "number" ? e.endEpoch - currentEpoch : null,
  }));

  UI.renderDocumentList(enhancedEntries, {
    formatBytes,
    truncate,
    timeAgo,
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────

export async function handleUpload(file) {
  // Hard gate — wallet must be connected
  if (!_address) {
    UI.showError("Please connect your wallet before uploading.");
    UI.showScreen("connect");
    return;
  }

  UI.showScreen("upload");

  UI.setUploadFile(file.name, file.size);

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Encrypt locally
    // ─────────────────────────────────────────────────────────────────────────

    UI.setUploadPhase("encrypting", 0);

    const { ciphertext, keyB64, ivHex } = await encryptFile(file);

    UI.setUploadPhase("encrypting", 100);

    // ─────────────────────────────────────────────────────────────────────────
    // Upload to Walrus
    // ─────────────────────────────────────────────────────────────────────────

    UI.setUploadPhase("uploading", 0);

    // IMPORTANT:
    // Your uploadBlob() should return FULL Walrus metadata now
    //
    // Expected:
    // {
    //   blobId,
    //   blobObjectId,
    //   endEpoch,
    //   registeredEpoch
    // }
    //
    // Update walrus.js if needed.
    // ─────────────────────────────────────────────────────────────────────────

    const walrusResult = await uploadBlob(
      ciphertext,
      undefined,
      (loaded, total) =>
        UI.setUploadPhase("uploading", Math.round((loaded / total) * 100)),
    );

    UI.setUploadPhase("uploading", 100);

    // ─────────────────────────────────────────────────────────────────────────
    // NEW: Support both old + new upload formats safely
    // ─────────────────────────────────────────────────────────────────────────

    const blobId =
      typeof walrusResult === "string" ? walrusResult : walrusResult.blobId;

    const blobObjectId =
      walrusResult?.blobObjectId || walrusResult?.blobObject?.id || null;

    const endEpoch =
      walrusResult?.endEpoch ||
      walrusResult?.blobObject?.storage?.end_epoch ||
      null;

    const registeredEpoch =
      walrusResult?.registeredEpoch ||
      walrusResult?.blobObject?.storage?.start_epoch ||
      null;

    // ─────────────────────────────────────────────────────────────────────────
    // Save vault entry
    // ─────────────────────────────────────────────────────────────────────────

    const currentEpoch =
      Number(localStorage.getItem("walrus_current_epoch")) || 1;

    const entry = {
      blobId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      uploadedAt: Date.now(),
      ivHex,
      ownerAddress: _address,
      expiryEpoch: currentEpoch + 5,
    };

    await saveEntry(entry);

    // ─────────────────────────────────────────────────────────────────────────
    // Build secure share link
    // ─────────────────────────────────────────────────────────────────────────

    const shareLink = buildShareFragment(
      blobId,
      ivHex,
      keyB64,
      file.name,
      file.type || "application/octet-stream",
    );

    UI.showUploadSuccess({
      blobId,
      keyB64,
      ivHex,
      shareLink,
      filename: file.name,
    });
  } catch (err) {
    console.error(err);

    UI.showError(err.message);

    UI.showScreen("vault");
  }
}

// ── Retrieve / Decrypt ────────────────────────────────────────────────────────

export async function handleRetrieve(
  blobId,
  ivHex,
  keyB64,
  filename = "decrypted_file",
  mimeType = "application/octet-stream",
) {
  try {
    UI.setRetrievePhase("fetching", 0);

    const ciphertext = await downloadBlob(blobId, (loaded, total) =>
      UI.setRetrievePhase("fetching", Math.round((loaded / total) * 100)),
    );

    UI.setRetrievePhase("fetching", 100);

    UI.setRetrievePhase("decrypting", 0);

    const plaintext = await decryptBlob(ciphertext, keyB64, ivHex);

    UI.setRetrievePhase("decrypting", 100);

    _triggerDownload(plaintext, filename, mimeType);

    UI.showRetrieveSuccess(filename);
  } catch (err) {
    const isDecryptError = err.name === "OperationError";

    UI.showRetrieveError(
      isDecryptError ? "Invalid decryption key or IV." : err.message,
      {
        fatal: err.message?.includes("404"),
      },
    );

    // Clear sensitive values
    UI.prefillRetrieve("", "", "");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Renew Walrus storage
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRenew(blobObjectId, epochs = 5) {
  if (!_address) {
    throw new Error("Wallet not connected");
  }

  if (!blobObjectId) {
    throw new Error("Missing blob object ID");
  }

  // Example publisher API
  const response = await fetch(
    `${WALRUS_PUBLISHER}/v1/blobs/${blobObjectId}/extend`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        epochs,
      }),
    },
  );

  if (!response.ok) {
    const txt = await response.text();

    throw new Error(`Renewal failed: ${txt}`);
  }

  return await response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Fetch live Sui epoch
// ─────────────────────────────────────────────────────────────────────────────

export async function getCurrentEpoch() {
  try {
    const res = await fetch(SUI_RPC, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "suix_getLatestSuiSystemState",
        params: [],
      }),
    });

    const data = await res.json();

    return Number(data.result.epoch);
  } catch (err) {
    console.error("Failed to fetch epoch", err);

    return 0;
  }
}

function _triggerDownload(buffer, filename, mimeType) {
  const blob = new Blob([buffer], {
    type: mimeType,
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");

  a.href = url;

  const safeName =
    filename && filename.includes(".")
      ? filename
      : `document.${_mimeToExtension(mimeType)}`;

  a.download = safeName;

  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function handleDelete(blobId) {
  await deleteEntry(blobId);

  await refreshVault();
}

// ── Renew Walrus Blob Storage ─────────────────────────────────────

export async function handleRenewBlob(blobId) {
  if (!_wallet) {
    throw new Error("Wallet not connected.");
  }

  // Find existing vault entry
  const entries = await getAllEntries(_address);
  const entry = entries.find((e) => e.blobId === blobId);

  if (!entry) {
    throw new Error("Vault entry not found.");
  }

  // ── Simulated renewal for now ─────────────────────────────
  // Replace with real Walrus extend call later

  const currentExpiry = entry.expiryEpoch || 0;

  // Extend by 5 epochs
  const newExpiry = currentExpiry + 5;

  // Save updated entry
  await saveEntry({
    ...entry,
    expiryEpoch: newExpiry,
  });

  // Optional: update cached epoch
  const currentEpoch =
    Number(localStorage.getItem("walrus_current_epoch")) || 1;

  localStorage.setItem(
    "walrus_current_epoch",
    String(currentEpoch),
  );

  // Refresh vault UI
  await refreshVault();
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME TYPE → FILE EXTENSION
// Expanded universal support
// ─────────────────────────────────────────────────────────────────────────────

function _mimeToExtension(mime = "") {
  const map = {
    // Images
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",

    // Audio
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",

    // Video
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",

    // Documents
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/json": "json",
    "text/csv": "csv",

    // Office
    "application/msword": "doc",

    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",

    "application/vnd.ms-excel": "xls",

    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",

    // Archives
    "application/zip": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-7z-compressed": "7z",

    // Generic
    "application/octet-stream": "bin",
  };

  if (map[mime]) {
    return map[mime];
  }

  if (mime.startsWith("image/")) {
    return mime.split("/")[1];
  }

  if (mime.startsWith("audio/")) {
    return mime.split("/")[1];
  }

  if (mime.startsWith("video/")) {
    return mime.split("/")[1];
  }

  return "bin";
}
