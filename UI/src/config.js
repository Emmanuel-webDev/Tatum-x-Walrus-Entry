// config.js — single source of truth for all environment values.

const NETWORK = "testnet";
const SUI_CHAIN = NETWORK === "testnet" ? "sui:testnet" : "sui:mainnet";

const RPC_URLS = {
  mainnet: "https://sui-mainnet.gateway.tatum.io",
  testnet: "https://sui-testnet.gateway.tatum.io",
  devnet: "https://sui-devnet.gateway.tatum.io",
};

const CONFIG = Object.freeze({
  // ── Tatum ──────────────────────────────────────────────────────
  TATUM_API_KEY: "t-6a1209d77f2354aab378834a-2ca600739dda44c69487caec",

  // ── Sui RPC ────────────────────────────────────────────────────
  SUI_RPC_MAINNET: RPC_URLS.mainnet,
  SUI_RPC_TESTNET: RPC_URLS.testnet,
  SUI_RPC_DEVNET: RPC_URLS.devnet,
  SUI_RPC_URL: RPC_URLS[NETWORK] ?? RPC_URLS.testnet,

  // ── Active network ─────────────────────────────────────────────
  NETWORK,
  SUI_CHAIN,
  // ── Walrus endpoints ───────────────────────────────────────────
  WALRUS_PUBLISHER_URL: "https://publisher.walrus-testnet.walrus.space",
  WALRUS_AGGREGATOR_URL: "https://aggregator.walrus-testnet.walrus.space",
  WALRUS_EPOCHS: 5,

  // ── Sui contract ───────────────────────────────────────────────
  VAULT_PACKAGE_ID:
    "0x80ae431c248a9d89c8e3bb060a5811a2793d88ec8ff6336e0235ac41f2dc5d18",
  VAULT_MODULE: "vault",

  // ── Encryption ─────────────────────────────────────────────────
  AES_KEY_LENGTH: 256,
  AES_ALGORITHM: "AES-GCM",
  IV_LENGTH_BYTES: 12,
});

export default CONFIG;
