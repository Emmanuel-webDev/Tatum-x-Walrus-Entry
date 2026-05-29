// config.js — single source of truth for all environment values.

const NETWORK = "testnet";

const RPC_URLS = {
  mainnet: "https://sui-mainnet.gateway.tatum.io",
  testnet: "https://sui-testnet.gateway.tatum.io",
  devnet: "https://sui-devnet.gateway.tatum.io",
};

const CONFIG = Object.freeze({
  // ── Tatum ──────────────────────────────────────────────────────
  TATUM_API_KEY: import.meta.env.VITE_TATUM_API_KEY,

  // ── Sui RPC ────────────────────────────────────────────────────
  SUI_RPC_MAINNET: RPC_URLS.mainnet,
  SUI_RPC_TESTNET: RPC_URLS.testnet,
  SUI_RPC_DEVNET: RPC_URLS.devnet,
  SUI_RPC_URL: RPC_URLS[NETWORK] ?? RPC_URLS.testnet,

  // ── Active network ─────────────────────────────────────────────
  NETWORK,

  // ── Walrus endpoints ───────────────────────────────────────────
  WALRUS_PUBLISHER_URL: "https://publisher.walrus-testnet.walrus.space",
  WALRUS_AGGREGATOR_URL: "https://aggregator.walrus-testnet.walrus.space",
  WALRUS_EPOCHS: import.meta.env.VITE_WALRUS_EPOCHS,

  // ── Sui contract ───────────────────────────────────────────────
  VAULT_PACKAGE_ID: import.meta.env.VITE_VAULT_PACKAGE_ID,
  VAULT_MODULE: "vault",

  // ── Encryption ─────────────────────────────────────────────────
  AES_KEY_LENGTH: 256,
  AES_ALGORITHM: "AES-GCM",
  IV_LENGTH_BYTES: 12,
});

export default CONFIG;
