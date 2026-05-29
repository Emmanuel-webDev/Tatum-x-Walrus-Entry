/**
 * walletStandard.js
 *
 * Vanilla-JS implementation of the @wallet-standard/core registry used by
 * every Sui wallet (Slush/Sui Wallet, Suiet, Nightly, Backpack, OKX, Ethos…).
 *
 * How Sui wallet-standard works (no React / no bundler needed):
 *
 *   1. The PAGE fires  "wallet-standard:app-ready"  to tell extensions it is ready.
 *      Extensions that are already injected respond by calling detail.register(wallet).
 *
 *   2. Extensions that inject AFTER the page fires  "wallet-standard:register-wallet"
 *      with detail = { wallets: [wallet] }  OR  detail = registrar (legacy).
 *
 *   3. Some older extensions still use  "wallet:register"  (detail = wallet object).
 *
 * Source: https://forums.sui.io/t/connecting-to-wallets-without-typescript-or-react/42350
 */

// ── Registry ──────────────────────────────────────────────────────────────────

const _registry  = new Map();   // name → wallet
const _listeners = new Set();   // change subscribers

function _notify() {
  _listeners.forEach((fn) => fn(getWallets()));
}

function _register(wallet) {
  if (!wallet || typeof wallet !== "object" || !wallet.name) return;

  // Must advertise at least one Sui chain
  const chains = Array.isArray(wallet.chains) ? wallet.chains : [];
  if (!chains.some((c) => typeof c === "string" && c.startsWith("sui:"))) return;

  if (_registry.has(wallet.name)) return; // already known
  _registry.set(wallet.name, wallet);
  _notify();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getWallets() {
  return [..._registry.values()];
}

export function onWalletsChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Connect to a wallet by name. Returns { address, wallet }.
 */
export async function connectWallet(walletName) {
  const wallet = _registry.get(walletName);
  if (!wallet) throw new Error(`Wallet "${walletName}" not found. Is the extension installed?`);

  const feature = wallet.features?.["standard:connect"];
  if (!feature) throw new Error(`${walletName} does not support standard:connect`);

  const result   = await feature.connect({ silent: false });
  const accounts = result?.accounts ?? [];
  if (!accounts.length) throw new Error("No accounts returned by wallet");

  return { address: accounts[0].address, wallet };
}

export async function disconnectWallet(wallet) {
  const feature = wallet?.features?.["standard:disconnect"];
  if (feature) await feature.disconnect();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initWalletStandard() {
  // ── Listener 1: extensions that register AFTER this script runs ────────────
  // Pattern used by Slush, Suiet, Nightly, Backpack, etc.
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    const detail = e.detail;
    if (!detail) return;

    // New pattern: detail.wallets = [wallet, …]
    if (Array.isArray(detail.wallets)) {
      detail.wallets.forEach(_register);
      return;
    }

    // Legacy pattern: detail is a registrar function → call it with a register fn
    if (typeof detail === "function") {
      try { detail({ register: _register }); } catch {}
      return;
    }

    // Some wallets pass the wallet object directly in detail
    _register(detail);
  });

  // ── Listener 2: even older "wallet:register" event ─────────────────────────
  window.addEventListener("wallet:register", (e) => _register(e.detail));

  // ── Step A: fire "wallet-standard:app-ready" so already-injected extensions
  //    respond synchronously with their wallet objects ─────────────────────────
  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", {
      detail: { register: _register },
    })
  );

  // ── Step B: poll window globals for extensions that use legacy injection ────
  _scanLegacyGlobals();

  // ── Step C: re-scan after a short delay for slow-injecting extensions ───────
  setTimeout(_scanLegacyGlobals, 600);
  setTimeout(_scanLegacyGlobals, 1500);

  return () => {}; // cleanup (listeners are intentionally persistent)
}

// ── Legacy global scan ────────────────────────────────────────────────────────
// Wallets that predate wallet-standard still inject under window.xxx.
// We normalise them into the standard shape so they appear in the list.

const LEGACY = [
  // Slush (formerly Sui Wallet) — try both old and new window key
  { key: "slushWallet", name: "Slush",         chains: ["sui:mainnet","sui:testnet","sui:devnet"] },
  { key: "suiWallet",   name: "Slush",         chains: ["sui:mainnet","sui:testnet","sui:devnet"] },
  { key: "suiet",       name: "Suiet",         chains: ["sui:mainnet","sui:testnet","sui:devnet"] },
  { key: "ethosWallet", name: "Ethos Wallet",  chains: ["sui:mainnet","sui:testnet"] },
  { key: "martianWallet",name:"Martian Wallet",chains: ["sui:mainnet","sui:testnet"] },
  { key: "nightly",     name: "Nightly",       chains: ["sui:mainnet","sui:testnet","sui:devnet"] },
  { key: "backpack",    name: "Backpack",      chains: ["sui:mainnet","sui:testnet"] },
  { key: "okxwallet",   name: "OKX Wallet",    chains: ["sui:mainnet","sui:testnet"] },
];

function _scanLegacyGlobals() {
  for (const { key, name, chains } of LEGACY) {
    const obj = window[key];
    if (!obj || _registry.has(name)) continue;

    _register({
      name,
      icon: obj.icon ?? "",
      chains,
      accounts: [],
      features: {
        "standard:connect": {
          async connect() {
            if (typeof obj.connect === "function") await obj.connect();
            const rawAccounts =
              typeof obj.getAccounts === "function" ? await obj.getAccounts() : [];
            return {
              accounts: rawAccounts.map((a) =>
                typeof a === "string"
                  ? { address: a, chains, features: [] }
                  : a
              ),
            };
          },
        },
        "standard:disconnect": {
          async disconnect() {
            if (typeof obj.disconnect === "function") await obj.disconnect();
          },
        },
      },
    });
  }
}