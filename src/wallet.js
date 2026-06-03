// wallet.js — Wallet detection and connection via @mysten/wallet-standard.
//
// Docs: https://docs.sui.io/standards/wallet-standard
// API:  getWallets().get() → Wallet[]
//       wallet.features["standard:connect"].connect()
//       wallet.accounts → WalletAccount[]
//       wallet.features["standard:events"].on("change", cb)
//
// The Wallet Standard guarantees that getWallets() always works even before
// extensions have loaded — it dispatches a WindowAppReadyEvent so extensions
// can register themselves synchronously.

const WALLET_STANDARD_CDN = "https://esm.run/@mysten/wallet-standard@latest";

let _walletsApi = null;
let _changeUnsub = null;

// ── Load wallet standard ──────────────────────────────────────────────────────

async function _loadWalletStandard() {
  if (_walletsApi) return _walletsApi;
  try {
    const mod = await import(WALLET_STANDARD_CDN);
    _walletsApi = mod.getWallets();
    return _walletsApi;
  } catch (err) {
    console.warn(
      "[wallet] Could not load wallet-standard from CDN:",
      err.message,
    );
    return null;
  }
}

// ── Get available wallets ─────────────────────────────────────────────────────

/**
 * Returns all Sui-compatible wallets installed in the browser.
 * Each entry has: { name, icon, _wallet } where _wallet is the raw Wallet object.
 *
 * @returns {Promise<Array<{ name: string, icon: string, _wallet: object }>>}
 */
export async function getAvailableWallets() {
  const api = await _loadWalletStandard();
  if (!api) return [];

  const all = api.get();

  return all
    .filter((w) => (w.chains ?? []).some((c) => c.startsWith("sui:")))
    .map((w) => ({ name: w.name, icon: w.icon ?? "", _wallet: w }));
}

/**
 * Subscribe to wallet list changes (new extension installed, etc).
 * Returns an unsubscribe function.
 *
 * @param {Function} callback — called with the updated wallet list
 * @returns {Promise<Function>}
 */
export async function onWalletsChange(callback) {
  const api = await _loadWalletStandard();
  if (!api) return () => {};

  const unsub = api.on("register", async () => {
    const wallets = await getAvailableWallets();
    callback(wallets);
  });

  return unsub;
}

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * Connect to a wallet by its raw Wallet object.
 * Uses the standard:connect feature.
 *
 * @param {object} rawWallet — from getAvailableWallets()._wallet
 * @returns {Promise<{ address: string, wallet: object }>}
 */
export async function connectWallet(rawWallet) {
  const connectFeature = rawWallet.features?.["standard:connect"];
  if (!connectFeature) {
    throw new Error(`${rawWallet.name} does not support standard:connect.`);
  }

  const result = await connectFeature.connect({ silent: false });
  const accounts = result?.accounts ?? rawWallet.accounts ?? [];

  if (!accounts.length) {
    throw new Error(
      "No accounts returned. Please unlock your wallet and try again.",
    );
  }

  const address = accounts[0].address;
  if (!address) throw new Error("Wallet returned an account with no address.");

return {
  address,
  account: accounts[0],
  wallet: rawWallet,
};

}

/**
 * Disconnect from a wallet if supported.
 * @param {object} rawWallet
 */
export async function disconnectWallet(rawWallet) {
  const feature = rawWallet.features?.["standard:disconnect"];
  if (feature?.disconnect) {
    await feature.disconnect();
  }
}
