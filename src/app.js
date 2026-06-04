// app.js — Main application controller.
//
// Flow:
//   1. Detect wallets via Wallet Standard
//   2. User connects → find/create VaultRegistry on Sui
//   3. Vault loads from chain (works in any browser)
//   4. Upload: encrypt → Walrus → register on chain → cache IV
//   5. Decrypt: fetch from Walrus → decrypt in browser → download
//   6. Delete: remove from chain → delete IV cache

import {
  encryptFile,
  decryptBlob,
  validateKeyAndIV,
  buildShareLink,
  parseShareLink,
} from "./crypto.js";
import { uploadToWalrus, downloadFromWalrus } from "./walrus.js";
import {
  getAvailableWallets,
  onWalletsChange,
  connectWallet,
  disconnectWallet,
} from "./wallet.js";
import {
  findRegistryId,
  fetchEntries,
  buildCreateRegistryTx,
  buildAddEntryTx,
  buildRemoveEntryTx,
  executeTransaction,
  getCurrentEpoch,
  saveIV,
  deleteIV,
  getIV,
} from "./sui.js";
import { formatBytes, truncate, timeAgo, mimeToExt, esc } from "./utils.js";
import CONFIG from "./config.js";

// ── Session state ─────────────────────────────────────────────────────────────
let _wallet = null; // raw Wallet object from Wallet Standard
let _address = null; // connected wallet address
let _account = null; // connected account (address + auth info)
let _registryId = null; // VaultRegistry Sui object ID

export const isConnected = () => !!_address;

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init() {
  _bindUI();

  // Handle share link before showing connect screen
  if (location.hash?.length > 1) {
    const parsed = parseShareLink(location.hash);
    if (parsed) {
      _showScreen("retrieve");
      _prefillRetrieve(parsed);
      return;
    }
  }

  // Wait for wallet extensions to inject
  await new Promise((r) => setTimeout(r, 150));

  const wallets = await getAvailableWallets();
  _renderWalletList(wallets);
  _showScreen("connect");

  // Re-render if new wallets register later
  onWalletsChange(async (updated) => _renderWalletList(updated));
}

// ── Screen management ─────────────────────────────────────────────────────────

const SCREENS = ["connect", "vault", "upload", "share", "retrieve"];

function _showScreen(name) {
  SCREENS.forEach((s) => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.hidden = s !== name;
  });
  // Update sidebar active state
  document.querySelectorAll(".nav-item[data-screen]").forEach((el) => {
    el.classList.toggle("active", el.dataset.screen === name);
  });
}

// ── Wallet list rendering ─────────────────────────────────────────────────────

function _renderWalletList(wallets) {
  const container = document.getElementById("wallet-list");
  if (!container) return;

  if (!wallets.length) {
    container.innerHTML = `
      <div class="wallet-empty">
        <div class="wallet-empty-icon">🔍</div>
        <div class="wallet-empty-title">No wallets detected</div>
        <div class="wallet-empty-sub">Install a Sui wallet extension and refresh.</div>
        <div class="wallet-empty-links">
          <a href="https://slush.app" target="_blank" rel="noopener" class="wallet-link">Slush ↗</a>
          <a href="https://suiwallet.com" target="_blank" rel="noopener" class="wallet-link">Sui Wallet ↗</a>
          <a href="https://suiet.app" target="_blank" rel="noopener" class="wallet-link">Suiet ↗</a>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = wallets
    .map(
      (w, i) => `
    <button class="wallet-card" data-index="${i}" aria-label="Connect ${esc(w.name)}">
      <span class="wallet-card-icon">
        ${
          w.icon?.startsWith("data:")
            ? `<img src="${esc(w.icon)}" alt="${esc(w.name)}" width="28" height="28" />`
            : `<span class="wallet-card-fallback">${_walletEmoji(w.name)}</span>`
        }
      </span>
      <span class="wallet-card-name">${esc(w.name)}</span>
      <span class="wallet-card-arrow">→</span>
    </button>`,
    )
    .join("");

  // Store wallet list so click handler can look up by index
  container._wallets = wallets;

  container.querySelectorAll(".wallet-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const w = container._wallets[Number(btn.dataset.index)];
      if (w) _handleConnect(w);
    });
  });
}

function _walletEmoji(name = "") {
  const n = name.toLowerCase();
  if (n.includes("slush")) return "💧";
  if (n.includes("sui")) return "💧";
  if (n.includes("ethos")) return "🌀";
  if (n.includes("suiet")) return "🔷";
  if (n.includes("martian")) return "👽";
  return "👛";
}

// ── Connect ───────────────────────────────────────────────────────────────────

async function _handleConnect(walletEntry) {
  _setConnecting(true);

  try {
    const { wallet, account, address } = await connectWallet(
      walletEntry._wallet,
    );

    _wallet = wallet;
    _account = account;
    _address = address;

    _setConnecting(false);
    _setAddressDisplay(address);

    await _initRegistry();
    _showScreen("vault");
    _setStatus("Checking on-chain vault…");
    await _loadVault();
  } catch (err) {
    _setConnecting(false);
    _setStatus(null);
    const msg = err?.message ?? String(err);
    _showError(
      msg.toLowerCase().includes("reject") ||
        msg.toLowerCase().includes("cancel")
        ? "Connection cancelled — please approve in your wallet."
        : msg,
    );
  }
}

function _setConnecting(loading) {
  document.querySelectorAll(".wallet-card").forEach((btn) => {
    btn.disabled = loading;
    btn.classList.toggle("connecting", loading);
  });
  const st = document.getElementById("connect-status");
  if (st) {
    st.textContent = loading ? "Connecting — approve in your wallet…" : "";
    st.hidden = !loading;
  }
}

// ── Registry init ─────────────────────────────────────────────────────────────

async function _initRegistry() {
  _registryId = await findRegistryId(_address);

  if (!_registryId) {
    _setStatus("Creating your vault on Sui (approve in wallet)…");

    const tx = await buildCreateRegistryTx();
    await executeTransaction(_wallet, _account, tx);

    // Wait for chain confirmation, then re-query
    _setStatus("Waiting for confirmation…");
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      _registryId = await findRegistryId(_address);
      if (_registryId) break;
    }

    if (!_registryId) {
      throw new Error(
        "Vault was created but not found yet. " +
          "Please refresh and reconnect — it will appear in a moment.",
      );
    }
  }

  // Cache epoch for badge display
  await getCurrentEpoch();
  _setStatus(null);
}

// ── Vault ─────────────────────────────────────────────────────────────────────

async function _loadVault() {
  if (!_registryId) return;
  _setStatus("Loading vault…");

  const currentEpoch = await getCurrentEpoch();

  try {
    const list = document.getElementById("doc-list");
    const empty = document.getElementById("doc-empty");

    const entries = await fetchEntries(_registryId);

    if (!entries.length) {
      if (list) list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
      }
      return;
    }

    if (empty) {
      empty.remove();
    }

    if (!list) return;

    _renderDocList(entries, currentEpoch);
  } catch (err) {
    _showError("Failed to load vault: " + err.message);
    console.error("[vault] _loadVault:", err);
  }

  _setStatus(null);
}

// ── Document list ─────────────────────────────────────────────────────────────

function _renderDocList(entries, currentEpoch) {
  const list = document.getElementById("doc-list");
  const empty = document.getElementById("doc-empty");
  const counter = document.getElementById("doc-count");
  const sizeEl = document.getElementById("total-size-num");

  if (counter) counter.textContent = entries.length;
  if (sizeEl) {
    const total = entries.reduce((s, e) => s + (e.sizeBytes || 0), 0);
    sizeEl.textContent = formatBytes(total);
  }

  if (!entries.length) {
    if (list) list.innerHTML = "";
    if (empty) {
      empty.hidden = false;
    }
    return;
  }

  if (empty) {
    empty.hidden = true;
  }

  if (!list) return;

  list.innerHTML = entries
    .map((e) => {
      const ext = _fileExt(e.mimeType, e.filename);
      const hasIV = !!e.ivHex;

      const epochsLeft =
        e.endEpoch && currentEpoch
          ? Math.max(0, e.endEpoch - currentEpoch)
          : null;

      // On testnet 1 epoch = 1 day, mainnet = 14 days
      const EPOCH_DURATION_DAYS = 1;
      const daysLeft =
        epochsLeft !== null ? epochsLeft * EPOCH_DURATION_DAYS : null;

      const epochClass =
        epochsLeft === null
          ? "epoch-unknown"
          : epochsLeft === 0
            ? "epoch-danger"
            : epochsLeft <= 3
              ? "epoch-warning"
              : "epoch-safe";

      const timeLabel =
        daysLeft === null
          ? "Unknown expiry"
          : daysLeft === 0
            ? "Expired"
            : daysLeft === 1
              ? "Expires tomorrow"
              : daysLeft < 1
                ? "Expires today"
                : `${daysLeft}d left`;

      return `
    <div class="file-row" data-blob="${esc(e.blobId)}">
      <div class="file-row-name">
        <div class="file-row-icon">${esc(ext)}</div>
        <div class="file-row-filename" title="${esc(e.filename)}">${esc(e.filename)}</div>
      </div>
      <div class="file-row-size">${formatBytes(e.sizeBytes)}</div>
      <div class="file-row-date">${timeAgo(e.uploadedAt)}</div>
      <div class="file-row-blob mono">${truncate(e.blobId)}</div>
      <div class="file-row-epoch">
  <span class="epoch-pill ${epochClass}" title="Epoch ${currentEpoch} now · ends epoch ${e.endEpoch ?? "?"}">
    ⏱ ${timeLabel}
  </span>
  <span class="epoch-num">
    ${
      epochsLeft !== null
        ? ` · ends #${e.endEpoch}`
        : "No expiry data"
    }
  </span>
</div>
      <div class="file-row-actions">
        <button class="btn btn-ghost btn-sm decrypt-btn"
          data-blob="${esc(e.blobId)}"
          data-iv="${esc(e.ivHex)}"
          data-name="${esc(e.filename)}"
          data-mime="${esc(e.mimeType)}"
          ${!hasIV ? 'title="IV not cached — use share link"' : ""}>
          Decrypt
        </button>
        <button class="btn btn-danger btn-sm delete-btn"
          data-blob="${esc(e.blobId)}">✕</button>
      </div>
    </div>`;
    })
    .join("");

  list.querySelectorAll(".decrypt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { blob, iv, name, mime } = btn.dataset;
      _showScreen("retrieve");
      _prefillRetrieve({
        blobId: blob,
        ivHex: iv,
        keyB64: "",
        filename: name,
        mimeType: mime,
      });
    });
  });

  list.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => _handleDelete(btn.dataset.blob));
  });
}

function _fileExt(mime, filename) {
  const dot = (filename ?? "").lastIndexOf(".");
  if (dot !== -1)
    return filename
      .slice(dot + 1)
      .toUpperCase()
      .slice(0, 5);
  const map = {
    "application/pdf": "PDF",
    "image/jpeg": "JPG",
    "image/png": "PNG",
    "image/gif": "GIF",
    "image/webp": "WEBP",
    "video/mp4": "MP4",
    "audio/mpeg": "MP3",
    "text/plain": "TXT",
    "application/json": "JSON",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "PPTX",
    "application/zip": "ZIP",
  };
  return map[mime] ?? "FILE";
}

// ── Upload ────────────────────────────────────────────────────────────────────

async function _handleUpload(file) {
  if (!_registryId) {
    _showError("Vault not ready. Please reconnect.");
    return;
  }

  _showScreen("upload");
  _setText("upload-filename", file.name);

  try {
    // 1 — Encrypt in browser
    _setUploadPhase("encrypting", 0);
    const { ciphertext, keyB64, ivHex } = await encryptFile(file);
    _setUploadPhase("encrypting", 100);

    // 2 — Upload to Walrus
    _setUploadPhase("uploading", 0);
    const { blobId, endEpoch } = await uploadToWalrus(
      ciphertext,
      CONFIG.WALRUS_EPOCHS,
      (loaded, total) =>
        _setUploadPhase("uploading", Math.round((loaded / total) * 100)),
    );
    _setUploadPhase("uploading", 100);

    // 3 — Register on Sui chain
    _setUploadPhase("registering", 0);
    const tx = await buildAddEntryTx(_registryId, {
      blobId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      endEpoch,
      sizeBytes: file.size,
    });
    await executeTransaction(_wallet, _account, tx);
    _setUploadPhase("registering", 100);

    // 4 — Cache IV locally
    saveIV(blobId, ivHex);

    // 5 — Show success
    const shareLink = buildShareLink(
      blobId,
      ivHex,
      keyB64,
      file.name,
      file.type || "application/octet-stream",
    );
    _showUploadSuccess({
      blobId,
      keyB64,
      ivHex,
      shareLink,
      filename: file.name,
    });
  } catch (err) {
    console.error("[vault] upload:", err);
    _showError(err.message || "Upload failed.");
    _showScreen("vault");
  }
}

function _setUploadPhase(phase, pct) {
  const labels = {
    encrypting: "Encrypting locally…",
    uploading: "Uploading to Walrus…",
    registering: "Registering on Sui…",
  };
  const emojis = { encrypting: "🔐", uploading: "☁️", registering: "⛓️" };

  _setText("upload-phase-label", labels[phase] ?? phase);
  _setText("upload-progress-emoji", emojis[phase] ?? "🔐");

  const bar = document.getElementById("upload-progress-bar");
  const pct_el = document.getElementById("upload-progress-pct");
  if (bar) bar.style.width = `${pct}%`;
  if (pct_el) pct_el.textContent = `${pct}%`;

  document.getElementById("upload-drop-section").hidden = true;
  document.getElementById("upload-progress-section").hidden = false;
  document.getElementById("upload-success-section").hidden = true;
}

function _showUploadSuccess({ blobId, keyB64, ivHex, shareLink, filename }) {
  document.getElementById("upload-progress-section").hidden = true;
  document.getElementById("upload-success-section").hidden = false;

  _setText("success-filename", filename);
  _setText("success-blob-id", blobId);
  _setText("success-key", keyB64);
  _setText("success-iv", ivHex);
  _setText("success-share-link", shareLink);

  // Pre-fill share screen
  _setVal("share-blob-id", blobId);
  _setVal("share-iv", ivHex);
  _setVal("share-key", keyB64);

  document.getElementById("go-share-btn")?.addEventListener(
    "click",
    () => {
      _showScreen("share");
    },
    { once: true },
  );
}

// ── Retrieve ──────────────────────────────────────────────────────────────────

async function _handleRetrieve(blobId, ivHex, keyB64, filename, mimeType) {
  // Validate before network
  const err = validateKeyAndIV(keyB64, ivHex);
  if (err) {
    _showRetrieveError(err, { icon: "🔑" });
    return;
  }

  try {
    // Fetch from Walrus
    _setRetrievePhase("fetching", 0);
    let ciphertext;
    try {
      ciphertext = await downloadFromWalrus(blobId, (loaded, total) =>
        _setRetrievePhase("fetching", Math.round((loaded / total) * 100)),
      );
    } catch (fetchErr) {
      const isGone = fetchErr.message?.includes("BLOB_NOT_FOUND");
      _showRetrieveError(
        isGone
          ? "This document no longer exists on Walrus. It may have expired or been deleted."
          : `Could not fetch from Walrus: ${fetchErr.message}`,
        { icon: isGone ? "🗑️" : "⚠️", fatal: isGone },
      );
      return;
    }
    _setRetrievePhase("fetching", 100);

    // Decrypt
    _setRetrievePhase("decrypting", 0);
    let plaintext;
    try {
      plaintext = await decryptBlob(ciphertext, keyB64, ivHex);
    } catch {
      _showRetrieveError(
        "Decryption failed. The key or IV is incorrect, or this file was encrypted by a different user.",
        { icon: "🔑", fatal: false },
      );
      return;
    }
    _setRetrievePhase("decrypting", 100);

    _triggerDownload(plaintext, filename, mimeType);
    _showRetrieveSuccess(filename);

    document.getElementById("retrieve-blob-id").value = "";
    document.getElementById("retrieve-key").value = "";
    document.getElementById("retrieve-iv").value = "";
    document.getElementById("share-link-input").value = "";
  } catch (err) {
    _showRetrieveError(`Unexpected error: ${err.message}`);
  }
}

function _setRetrievePhase(phase, pct) {
  const labels = {
    fetching: "Fetching from Walrus…",
    decrypting: "Decrypting in browser…",
  };
  _setText("retrieve-phase-label", labels[phase] ?? phase);
  const bar = document.getElementById("retrieve-progress-bar");
  const pctEl = document.getElementById("retrieve-progress-pct");
  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;

  document.getElementById("retrieve-form-section").hidden = true;
  document.getElementById("retrieve-progress-section").hidden = false;
  document.getElementById("retrieve-success-section").hidden = true;
}

function _showRetrieveSuccess(filename) {
  _setText("retrieve-success-filename", filename);
  document.getElementById("retrieve-progress-section").hidden = true;
  document.getElementById("retrieve-success-section").hidden = false;
}

function _showRetrieveError(message, { icon = "⚠️", fatal = false } = {}) {
  document.getElementById("retrieve-form-section").hidden = false;
  document.getElementById("retrieve-progress-section").hidden = true;
  document.getElementById("retrieve-success-section").hidden = true;

  let banner = document.getElementById("retrieve-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "retrieve-error-banner";
    banner.className = "retrieve-error-banner";
    document.getElementById("retrieve-form-section")?.prepend(banner);
  }

  banner.innerHTML = `
    <div class="retrieve-error-icon">${icon}</div>
    <div class="retrieve-error-body">
      <div class="retrieve-error-title">${fatal ? "Document Unavailable" : "Decryption Failed"}</div>
      <div class="retrieve-error-msg">${esc(message)}</div>
    </div>`;
  banner.hidden = false;

  let retrieveErrorTimer;

  clearTimeout(retrieveErrorTimer);

  retrieveErrorTimer = setTimeout(() => {
    const banner = document.getElementById("retrieve-error-banner");

    if (banner) {
      banner.remove();
    }
  }, 6000);

  _showError(
    fatal ? "Document no longer exists on Walrus." : "Decryption failed.",
  );
}

function _prefillRetrieve({
  blobId = "",
  ivHex = "",
  keyB64 = "",
  filename = "",
  mimeType = "",
}) {
  _setVal("retrieve-blob-id", blobId);
  _setVal("retrieve-iv", ivHex);
  _setVal("retrieve-key", keyB64);
  _setVal("retrieve-filename", filename || "decrypted_file");
  _setVal("retrieve-mime", mimeType || "application/octet-stream");

  // Reset sections
  document.getElementById("retrieve-form-section").hidden = false;
  document.getElementById("retrieve-progress-section").hidden = true;
  document.getElementById("retrieve-success-section").hidden = true;
  const banner = document.getElementById("retrieve-error-banner");
  if (banner) banner.hidden = true;
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function _handleDelete(blobId) {
  if (
    !confirm(
      "Remove this document from your vault?\n(The Walrus blob will remain until it expires.)",
    )
  )
    return;
  if (!_registryId) return;

  try {
    const tx = await buildRemoveEntryTx(_registryId, blobId);
    await executeTransaction(_wallet, _account, tx);
    deleteIV(blobId);
    await _loadVault();
  } catch (err) {
    _showError("Failed to remove: " + err.message);
  }
}

// ── Download helper ───────────────────────────────────────────────────────────

function _triggerDownload(buffer, filename, mimeType) {
  const safeFilename = filename?.includes(".")
    ? filename
    : `file.${mimeToExt(mimeType)}`;

  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: safeFilename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _setText(id, val) {
  const e = document.getElementById(id);
  if (e) e.textContent = val ?? "";
}
function _setVal(id, val) {
  const e = document.getElementById(id);
  if (e) e.value = val ?? "";
}

function _setAddressDisplay(addr) {
  const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  ["wallet-address-sidebar", "wallet-address-top"].forEach((id) =>
    _setText(id, short),
  );
  document.getElementById("wallet-pill")?.removeAttribute("hidden");
  document.getElementById("wallet-pill-topbar")?.removeAttribute("hidden");
}

function _setStatus(msg) {
  let el = document.getElementById("vault-status");
  if (!el) {
    el = document.createElement("p");
    el.id = "vault-status";
    el.className = "vault-status";
    document.getElementById("doc-list")?.before(el);
  }
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function _showError(msg) {
  const t = document.getElementById("error-toast");
  if (!t) return;
  t.textContent = `⚠ ${msg}`;
  t.hidden = false;
  setTimeout(() => {
    t.hidden = true;
  }, 6000);
}

function _toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

function _resetUploadScreen() {
  document.getElementById("upload-drop-section").hidden = false;
  document.getElementById("upload-progress-section").hidden = true;
  document.getElementById("upload-success-section").hidden = true;
}

// ── Event binding ─────────────────────────────────────────────────────────────

function _bindUI() {
  // Drop zone
  const zone = document.getElementById("drop-zone");
  const input = document.getElementById("file-input");
  if (zone && input) {
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () =>
      zone.classList.remove("drag-over"),
    );
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      const f = e.dataTransfer.files[0];
      if (f) _handleUpload(f);
    });
    input.addEventListener("change", () => {
      const f = input.files[0];
      if (f) _handleUpload(f);
      input.value = "";
    });
  }

  // Decrypt form
  document.getElementById("decrypt-btn")?.addEventListener("click", () => {
    const banner = document.getElementById("retrieve-error-banner");
    if (banner) banner.hidden = true;

    const blobId = document.getElementById("retrieve-blob-id")?.value.trim();
    const ivHex = document.getElementById("retrieve-iv")?.value.trim();
    const keyB64 = document.getElementById("retrieve-key")?.value.trim();
    const filename =
      document.getElementById("retrieve-filename")?.value.trim() ||
      "decrypted_file";
    const mimeType =
      document.getElementById("retrieve-mime")?.value.trim() ||
      "application/octet-stream";

    if (!blobId) {
      _showError("Please enter the Blob ID.");
      return;
    }
    _handleRetrieve(blobId, ivHex, keyB64, filename, mimeType);
  });

  // Parse pasted share link
  document
    .getElementById("share-link-input")
    ?.addEventListener("input", (e) => {
      const val = e.target.value.trim();
      const hash = val.includes("#") ? "#" + val.split("#")[1] : val;
      const parsed = parseShareLink(hash);
      if (parsed) {
        _prefillRetrieve(parsed);
        _toast("Share link parsed ✓");
      }
    });

  // Share form
  document.getElementById("build-share-btn")?.addEventListener("click", () => {
    const blobId = document.getElementById("share-blob-id")?.value.trim();
    const ivHex = document.getElementById("share-iv")?.value.trim();
    const keyB64 = document.getElementById("share-key")?.value.trim();

    if (!blobId || !ivHex || !keyB64) {
      _showError("Fill in all share link fields.");
      return;
    }

    const link = buildShareLink(blobId, ivHex, keyB64);
    _setText("share-link-output", link);
    document.getElementById("share-result").hidden = false;

    document.getElementById("copy-generated-share-btn")?.addEventListener(
      "click",
      () => {
        navigator.clipboard.writeText(link).then(() => _toast("Copied!"));
      },
      { once: true },
    );
  });

  // Sidebar nav
  document.querySelectorAll(".nav-item[data-screen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.screen;
      if (["vault", "upload", "share"].includes(target) && !isConnected()) {
        _showError("Connect your wallet first.");
        _showScreen("connect");
        return;
      }
      if (target === "vault") _loadVault();
      if (target === "upload") _resetUploadScreen();
      if (target === "retrieve") _prefillRetrieve({});
      _showScreen(target);
    });
  });

  // Vault header buttons
  document.getElementById("upload-nav-btn")?.addEventListener("click", () => {
    if (!isConnected()) {
      _showError("Connect first.");
      return;
    }
    _resetUploadScreen();
    _showScreen("upload");
  });

  document.getElementById("retrieve-nav-btn")?.addEventListener("click", () => {
    _prefillRetrieve({});
    _showScreen("retrieve");
  });

  document.getElementById("upload-empty-btn")?.addEventListener("click", () => {
    _resetUploadScreen();
    _showScreen("upload");
  });

  // Back to vault
  document.querySelectorAll(".back-to-vault-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      _showScreen("vault");
      await _loadVault();
    });
  });

  // Retrieve again
  document
    .getElementById("retrieve-again-btn")
    ?.addEventListener("click", () => _prefillRetrieve({}));

  // Paste link btn on connect screen
  document.getElementById("paste-link-btn")?.addEventListener("click", () => {
    _prefillRetrieve({});
    _showScreen("retrieve");
  });

  // Copy buttons
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const src = document.getElementById(btn.dataset.copy);
      const text = src?.textContent?.trim() || src?.value?.trim() || "";
      if (text)
        navigator.clipboard.writeText(text).then(() => _toast("Copied!"));
    });
  });

  // Hamburger
  document.getElementById("hamburger-btn")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.add("open");
    document.getElementById("sidebar-overlay")?.classList.add("open");
  });
  document
    .getElementById("sidebar-close-btn")
    ?.addEventListener("click", _closeSidebar);
  document
    .getElementById("sidebar-overlay")
    ?.addEventListener("click", _closeSidebar);

  // Network badge
  const nb = document.getElementById("network-tag");
  if (nb) nb.textContent = CONFIG.NETWORK.toUpperCase();
  const nbm = document.getElementById("network-tag-mobile");
  if (nbm) nbm.textContent = CONFIG.NETWORK.toUpperCase();
}

function _closeSidebar() {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.classList.remove("open");
}
