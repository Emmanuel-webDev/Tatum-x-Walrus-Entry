// ui.js — All DOM manipulation. No business logic.
// Fixed: screen switching, share screen accessible, all nav wired.

import {
  handleUpload,
  handleRetrieve,
  handleDelete,
  refreshVault,
  isWalletConnected,
  handleRenewBlob,
} from "./app.js";

import { parseShareFragment, buildShareFragment } from "./crypto.js";

// All screens in the app
const SCREENS = ["connect", "vault", "upload", "share", "retrieve"];

const UI = {
  // ── Lifecycle ────────────────────────────────────────────────────
  init() {
    _bindDropZone();
    _bindRetrieveForm();
    _bindShareForm();
    _bindNavButtons();
    _bindSidebar();
    _bindResultCopyButtons();
  },

  // ── Screen transitions ───────────────────────────────────────────
  showScreen(name) {
    // Hide all screens
    SCREENS.forEach((s) => {
      const el = document.getElementById(`screen-${s}`);
      if (!el) return;
      el.hidden = s !== name;
      el.classList.toggle("active", s === name);
    });

    // Update sidebar nav active state
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.screen === name);
    });

    // Close mobile sidebar when navigating
    _closeSidebar();
  },

  // ── Wallet list (connect screen) ─────────────────────────────────
  renderWalletList(wallets, onConnect) {
    const container = document.getElementById("wallet-list");
    if (!container) return;

    if (!wallets.length) {
      container.innerHTML = `
        <div class="wallet-empty">
          <div class="wallet-empty-icon">🔍</div>
          <div class="wallet-empty-title">No wallets detected</div>
          <div class="wallet-empty-sub">
            Install a Sui-compatible wallet extension and reload this page.
          </div>
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
        (w) => `
      <button class="wallet-card" data-wallet="${_esc(w.name)}" aria-label="Connect ${_esc(w.name)}">
        <span class="wallet-card-icon">
          ${
            w.icon?.startsWith("data:")
              ? `<img src="${_esc(w.icon)}" alt="${_esc(w.name)}" width="26" height="26" />`
              : `<span class="wallet-card-icon-fallback">${_walletEmoji(w.name)}</span>`
          }
        </span>
        <span class="wallet-card-name">${_esc(w.name)}</span>
        <span class="wallet-card-arrow">→</span>
      </button>
    `,
      )
      .join("");

    container.querySelectorAll(".wallet-card").forEach((btn) => {
      btn.addEventListener("click", () => onConnect(btn.dataset.wallet));
    });
  },

  setConnecting(loading) {
    document.querySelectorAll(".wallet-card").forEach((btn) => {
      btn.disabled = loading;
      btn.classList.toggle("wallet-card--connecting", loading);
    });
    const st = document.getElementById("connect-status");
    if (st) {
      st.textContent = loading ? "Connecting — approve in your wallet…" : "";
      st.hidden = !loading;
    }
  },

  // ── Wallet address display ───────────────────────────────────────
  setAddress(addr) {
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    ["wallet-address-sidebar", "wallet-address-top"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = short;
    });
    // Show wallet pills, hide nothing else
    document.getElementById("wallet-pill")?.removeAttribute("hidden");
    document.getElementById("wallet-pill-topbar")?.removeAttribute("hidden");
  },

  // ── Vault — document list ────────────────────────────────────────
  renderDocumentList(entries, { formatBytes, truncate, timeAgo }) {
    const list = document.getElementById("doc-list");
    const empty = document.getElementById("doc-empty");
    const counter = document.getElementById("doc-count");

    if (counter) counter.textContent = entries.length;

    // Update total size stat
    const totalBytes = entries.reduce((acc, e) => acc + (e.sizeBytes || 0), 0);
    const sizeNum = document.getElementById("total-size-num");
    if (sizeNum) sizeNum.textContent = formatBytes(totalBytes);

    if (!entries.length) {
      if (list) {
        list.innerHTML = "";
        list.style.display = "none";
      }

      if (empty) {
        empty.hidden = false;
        empty.style.display = "flex";
      }

      return;
    }

    // HAS FILES
    if (empty) {
      empty.hidden = true;
      empty.style.display = "none";
    }

    if (list) {
      list.style.display = "block";
    }

    if (!list) return;

    list.innerHTML = entries
      .map(
        (e) => `
      <div class="file-row" data-blob="${_esc(e.blobId)}">
        <div class="file-row-name">
          <div class="file-row-icon">${_mimeIcon(e.mimeType)}</div>
          <div class="file-row-filename" title="${_esc(e.filename)}">${_esc(e.filename)}</div>
        </div>
        <div class="file-row-size">${formatBytes(e.sizeBytes)}</div>
        <div class="file-row-date">${timeAgo(e.uploadedAt)}</div>
        <div class="file-row-blob mono">${truncate(e.blobId)}</div>
        <div class="file-row-actions">

  <!-- ── NEW: Epoch countdown ───────────────── -->
  <div class="epoch-badge ${_expiryClass(e.expiryEpoch)}">
    ⏳ ${_formatEpochRemaining(e.expiryEpoch)}
  </div>

  <!-- ── NEW: Expiry epoch number -->
  <div class="epoch-number">
    Epoch ${e.expiryEpoch || "?"}
  </div>

  <button class="btn btn-ghost btn-sm decrypt-btn"
    data-blob="${_esc(e.blobId)}"
    data-iv="${_esc(e.ivHex)}"
    data-name="${_esc(e.filename)}"
    data-mime="${_esc(e.mimeType)}">
    Decrypt
  </button>

  <!-- ── NEW: Renew storage button ─────────── -->
  <button
    class="btn btn-secondary btn-sm renew-btn"
    data-blob="${_esc(e.blobId)}">
    Renew
  </button>

  <button class="btn btn-danger btn-sm delete-btn"
    data-blob="${_esc(e.blobId)}">
    ✕
  </button>
</div>
      </div>
    `,
      )
      .join("");

    // Ensure empty state never shows while rows exist
    if (entries.length > 0) {
      const emptyState = document.getElementById("doc-empty");

      if (emptyState) {
        emptyState.hidden = true;
        emptyState.style.display = "none";
      }
    }

    list.querySelectorAll(".decrypt-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const { blob, iv, name, mime } = btn.dataset;
        UI.showScreen("retrieve");
        UI.prefillRetrieve(blob, iv, "");
        _setVal("retrieve-filename", name);
        _setVal("retrieve-mime", mime);
        // Reset retrieve UI
        _showRetrieveSection("form");
      });
    });

    // ── NEW: Renew blob storage ────────────────────────────────

    list.querySelectorAll(".renew-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const blobId = btn.dataset.blob;

        const confirmed = confirm("Renew this Walrus blob for more epochs?");

        if (!confirmed) return;

        const originalText = btn.textContent;

        try {
          btn.disabled = true;
          btn.textContent = "Renewing...";

          await handleRenewBlob(blobId);

          UI.toast("Blob renewed successfully ✓");
        } catch (err) {
          UI.showError(err.message || "Failed to renew blob.");
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });

    list.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (
          confirm(
            "Remove from vault? (Walrus blob will remain until it expires.)",
          )
        ) {
          await handleDelete(btn.dataset.blob);
        }
      });
    });
  },

  // ── Upload screen ────────────────────────────────────────────────
  setUploadFile(name) {
    const el = document.getElementById("upload-filename");
    if (el) el.textContent = name;
  },

  setUploadPhase(phase, pct) {
    const bar = document.getElementById("upload-progress-bar");
    const label = document.getElementById("upload-phase-label");
    const pctEl = document.getElementById("upload-progress-pct");
    const emoji = document.getElementById("upload-progress-emoji");

    const map = {
      encrypting: { label: "Encrypting locally…", emoji: "🔐" },
      uploading: { label: "Uploading to Walrus…", emoji: "☁️" },
    };

    if (label) label.textContent = map[phase]?.label ?? phase;
    if (emoji) emoji.textContent = map[phase]?.emoji ?? "🔐";
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;

    document.getElementById("upload-drop-section").hidden = true;
    document.getElementById("upload-progress-section").hidden = false;
    document.getElementById("upload-success-section").hidden = true;
  },

  showUploadSuccess({ blobId, keyB64, ivHex, shareLink, filename }) {
    document.getElementById("upload-progress-section").hidden = true;
    document.getElementById("upload-success-section").hidden = false;

    _setText("success-filename", filename);
    _setText("success-blob-id", blobId);
    _setText("success-key", keyB64);
    _setText("success-iv", ivHex);
    _setText("success-share-link", shareLink);

    // Pre-fill share screen with this upload's data
    _setVal("share-blob-id", blobId);
    _setVal("share-iv", ivHex);
    _setVal("share-key", keyB64);

    // Go to Share button
    document.getElementById("go-share-btn")?.addEventListener(
      "click",
      () => {
        UI.showScreen("share");
      },
      { once: true },
    );
  },

  // ── Retrieve screen ──────────────────────────────────────────────
  prefillRetrieve(blobId, ivHex, keyB64) {
    _setVal("retrieve-blob-id", blobId);
    _setVal("retrieve-iv", ivHex);
    _setVal("retrieve-key", keyB64);
  },

  setRetrievePhase(phase, pct) {
    const bar = document.getElementById("retrieve-progress-bar");
    const label = document.getElementById("retrieve-phase-label");
    const pctEl = document.getElementById("retrieve-progress-pct");

    const map = {
      fetching: "Fetching from Walrus…",
      decrypting: "Decrypting in browser…",
    };
    if (label) label.textContent = map[phase] ?? phase;
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;

    _showRetrieveSection("progress");
  },

  showRetrieveSuccess(filename) {
    _setText("retrieve-success-filename", filename);
    _showRetrieveSection("success");

    // Security cleanup
    setTimeout(() => {
      _resetRetrieveForm();
    }, 300);
  },

  /**
   * Show a contextual error on the retrieve screen itself (not just a toast).
   * @param {string} message
   * @param {{ icon?: string, fatal?: boolean }} opts
   */
  showRetrieveError(message, { icon = "⚠️", fatal = false } = {}) {
    // Reset progress sections
    _showRetrieveSection("form");

    // Inject or update the inline error banner inside the retrieve form
    let banner = document.getElementById("retrieve-error-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "retrieve-error-banner";
      banner.className = "retrieve-error-banner";
      const form = document.getElementById("retrieve-form-section");
      if (form) form.prepend(banner);
    }

    banner.innerHTML = `
      <div class="retrieve-error-icon">${icon}</div>
      <div class="retrieve-error-body">
        <div class="retrieve-error-title">${fatal ? "Document Unavailable" : "Decryption Failed"}</div>
        <div class="retrieve-error-msg">${_esc(message)}</div>
      </div>
    `;
    banner.hidden = false;

    // Also show toast for visibility
    this.showError(
      fatal
        ? "Document doesn't exist or has expired from Walrus."
        : "Decryption failed — invalid key or IV.",
    );
  },

  // ── Error / toast ────────────────────────────────────────────────
  showError(msg) {
    const t = document.getElementById("error-toast");
    if (!t) return console.error(msg);
    t.textContent = `⚠ ${msg}`;
    t.hidden = false;
    setTimeout(() => {
      t.hidden = true;
    }, 5000);
  },

  toast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2500);
  },
};

export default UI;

// ── Private helpers ───────────────────────────────────────────────────────────

function _setText(id, val) {
  const e = document.getElementById(id);
  if (e) e.textContent = val;
}
function _setVal(id, val) {
  const e = document.getElementById(id);
  if (e) e.value = val;
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function _mimeToExtension(mime = "") {
  const map = {
    // ─── Images ─────────────────────────────
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-icon": "ico",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/avif": "avif",

    // ─── Audio ─────────────────────────────
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/mp4": "m4a",

    // ─── Video ─────────────────────────────
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/x-msvideo": "avi",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/mpeg": "mpeg",
    "video/3gpp": "3gp",

    // ─── Documents ─────────────────────────
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/csv": "csv",
    "text/html": "html",
    "text/css": "css",
    "text/javascript": "js",
    "application/json": "json",
    "application/xml": "xml",

    // Word
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",

    // Excel
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",

    // PowerPoint
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "pptx",

    // ─── Archives ──────────────────────────
    "application/zip": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-7z-compressed": "7z",
    "application/x-tar": "tar",
    "application/gzip": "gz",

    // ─── Code / Dev Files ──────────────────
    "application/x-python-code": "py",
    "text/x-python": "py",
    "application/typescript": "ts",
    "text/markdown": "md",
    "application/sql": "sql",

    // ─── Fonts ─────────────────────────────
    "font/ttf": "ttf",
    "font/otf": "otf",
    "font/woff": "woff",
    "font/woff2": "woff2",

    // ─── Misc ──────────────────────────────
    "application/octet-stream": "bin",
  };

  // Exact match
  if (map[mime]) return map[mime];

  // Fallback heuristics
  if (mime.startsWith("image/")) return mime.split("/")[1];
  if (mime.startsWith("audio/")) return mime.split("/")[1];
  if (mime.startsWith("video/")) return mime.split("/")[1];
  if (mime.startsWith("text/")) return "txt";

  return "bin";
}

function _mimeIcon(mime = "") {
  if (mime.includes("pdf")) return "📄";
  if (mime.includes("image")) return "🖼️";
  if (mime.includes("video")) return "🎥";
  if (mime.includes("audio")) return "🎵";
  if (mime.includes("sheet") || mime.includes("excel")) return "📊";
  if (mime.includes("word") || mime.includes("document")) return "📝";
  return "📁";
}

// ── NEW: Epoch helpers ───────────────────────────────────────────

function _formatEpochRemaining(expiryEpoch) {
  if (!expiryEpoch) return "Unknown";

  const currentEpoch =
    Number(localStorage.getItem("walrus_current_epoch")) || 0;

  const remaining = expiryEpoch - currentEpoch;

  if (remaining <= 0) return "Expired";
  if (remaining === 1) return "1 epoch left";

  return `${remaining} epochs left`;
}

function _expiryClass(expiryEpoch) {
  if (!expiryEpoch) return "";

  const currentEpoch =
    Number(localStorage.getItem("walrus_current_epoch")) || 0;

  const remaining = expiryEpoch - currentEpoch;

  if (remaining <= 1) return "epoch-danger";
  if (remaining <= 3) return "epoch-warning";

  return "epoch-safe";
}

function _walletEmoji(name = "") {
  const n = name.toLowerCase();
  if (n.includes("slush")) return "💧";
  if (n.includes("sui")) return "💧";
  if (n.includes("ethos")) return "🌀";
  if (n.includes("suiet")) return "🔷";
  if (n.includes("martian")) return "👽";
  if (n.includes("okx")) return "⭕";
  return "👛";
}

function _showRetrieveSection(which) {
  document.getElementById("retrieve-form-section").hidden = which !== "form";
  document.getElementById("retrieve-progress-section").hidden =
    which !== "progress";
  document.getElementById("retrieve-success-section").hidden =
    which !== "success";
}

function _resetRetrieveForm() {
  _setVal("retrieve-blob-id", "");
  _setVal("retrieve-iv", "");
  _setVal("retrieve-key", "");
  _setVal("retrieve-filename", "decrypted_file");
  _setVal("retrieve-mime", "application/octet-stream");

  const shareInput = document.getElementById("share-link-input");
  if (shareInput) shareInput.value = "";

  const banner = document.getElementById("retrieve-error-banner");
  if (banner) banner.hidden = true;
}

function _resetUploadScreen() {
  document.getElementById("upload-drop-section").hidden = false;
  document.getElementById("upload-progress-section").hidden = true;
  document.getElementById("upload-success-section").hidden = true;
}

function _closeSidebar() {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.classList.remove("open");
}

// ── Event binders ─────────────────────────────────────────────────────────────

function _bindDropZone() {
  const zone = document.getElementById("drop-zone");
  const input = document.getElementById("file-input");
  if (!zone || !input) return;

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
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  });
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (file) handleUpload(file);
    input.value = "";
  });
}

function _bindRetrieveForm() {
  // Fetch & Decrypt button
  document.getElementById("decrypt-btn")?.addEventListener("click", () => {
    // Clear any previous error banner
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

    if (!blobId || !ivHex || !keyB64) {
      UI.showError("Please fill in Blob ID, IV, and Decryption Key.");
      return;
    }
    handleRetrieve(blobId, ivHex, keyB64, filename, mimeType);
  });

  // Auto-parse pasted share link
  document
    .getElementById("share-link-input")
    ?.addEventListener("input", (e) => {
      const val = e.target.value.trim();
      const hash = val.includes("#") ? val.split("#")[1] : val;
      const parsed = parseShareFragment(`#${hash}`);
      if (parsed) {
        UI.prefillRetrieve(parsed.blobId, parsed.ivHex, parsed.keyB64);
        _setVal("retrieve-filename", parsed.filename || "document");

        _setVal("retrieve-mime", parsed.mimeType || "application/octet-stream");
        UI.toast("Share link parsed ✓");
      }
    });

  // Decrypt another button
  document
    .getElementById("retrieve-again-btn")
    ?.addEventListener("click", () => {
      _showRetrieveSection("form");
      _setVal("retrieve-blob-id", "");
      _setVal("retrieve-iv", "");
      _setVal("retrieve-key", "");
    });
}

function _bindShareForm() {
  document.getElementById("build-share-btn")?.addEventListener("click", () => {
    const blobId = document.getElementById("share-blob-id")?.value.trim();
    const ivHex = document.getElementById("share-iv")?.value.trim();
    const keyB64 = document.getElementById("share-key")?.value.trim();

    if (!blobId || !ivHex || !keyB64) {
      UI.showError(
        "Please fill in Blob ID, IV, and Key to build a share link.",
      );
      return;
    }

    const link = buildShareFragment(blobId, ivHex, keyB64);
    _setText("share-link-output", link);
    document.getElementById("share-result").hidden = false;

    document.getElementById("copy-generated-share-btn")?.addEventListener(
      "click",
      () => {
        navigator.clipboard
          .writeText(link)
          .then(() => UI.toast("Link copied!"));
      },
      { once: true },
    );
  });
}

function _bindNavButtons() {
  // Sidebar nav items
  document.querySelectorAll(".nav-item[data-screen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.screen;

      // Gate screens that need wallet
      if (
        ["vault", "upload", "share"].includes(target) &&
        !isWalletConnected()
      ) {
        UI.showError("Connect your wallet first.");
        UI.showScreen("connect");
        return;
      }

      if (target === "upload") _resetUploadScreen();
      if (target === "retrieve") _showRetrieveSection("form");
      UI.showScreen(target);
    });
  });

  // Upload button in vault header
  document.getElementById("upload-nav-btn")?.addEventListener("click", () => {
    if (!isWalletConnected()) {
      UI.showError("Connect your wallet first.");
      return;
    }
    _resetUploadScreen();
    UI.showScreen("upload");
  });

  // Upload button in empty state
  document.getElementById("upload-empty-btn")?.addEventListener("click", () => {
    _resetUploadScreen();
    UI.showScreen("upload");
  });

  // Retrieve button in vault header
  document.getElementById("retrieve-nav-btn")?.addEventListener("click", () => {
    _showRetrieveSection("form");
    UI.showScreen("retrieve");
  });

  // All "Back to Vault" buttons
  document.querySelectorAll(".back-to-vault-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      UI.showScreen("vault");
      await refreshVault();
    });
  });

  // Paste link on connect screen → go to retrieve
  document.getElementById("paste-link-btn")?.addEventListener("click", () => {
    _showRetrieveSection("form");
    UI.showScreen("retrieve");
  });
}

function _bindSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const openBtn = document.getElementById("hamburger-btn");
  const closeBtn = document.getElementById("sidebar-close-btn");

  openBtn?.addEventListener("click", () => {
    sidebar?.classList.add("open");
    overlay?.classList.add("open");
  });
  closeBtn?.addEventListener("click", _closeSidebar);
  overlay?.addEventListener("click", _closeSidebar);
}

function _bindResultCopyButtons() {
  // Generic copy buttons using data-copy attribute
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sourceId = btn.dataset.copy;
      const sourceEl = document.getElementById(sourceId);
      const text =
        sourceEl?.textContent?.trim() ?? sourceEl?.value?.trim() ?? "";
      if (text) {
        navigator.clipboard.writeText(text).then(() => UI.toast("Copied!"));
      }
    });
  });
}
