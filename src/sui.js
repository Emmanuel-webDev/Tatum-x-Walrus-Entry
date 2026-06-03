// sui.js — Sui blockchain integration.
//
// READING:  Sui JSON-RPC via Tatum endpoint
// WRITING:  @mysten/sui Transaction objects (PTB) signed by the user's wallet
//
// PTB syntax reference: https://docs.sui.io/guides/developer/sui-101/building-ptb
// Wallet standard:      https://docs.sui.io/standards/wallet-standard
//
// Key facts from docs:
//   • tx.pure.string(val)          — for Move String args
//   • tx.pure.u64(val)             — for u64 args
//   • tx.pure.vector('u8', bytes)  — for vector<u8> args
//   • tx.object(id)                — for object args (&mut T, &T, owned T)
//   • Clock shared object is always "0x6"
//   • Wallet signing: sui:signAndExecuteTransaction (new) with fallback to old

import CONFIG from "./config.js";

// ── Sui SDK CDN ───────────────────────────────────────────────────────────────
// Official @mysten/sui package via esm.run CDN (no bundler required)
// Version pinned for stability

let _Transaction = null;

async function _loadTransaction() {
  if (_Transaction) return _Transaction;
  const mod = await import("https://esm.run/@mysten/sui@1.21.1/transactions");
  _Transaction = mod.Transaction;
  return _Transaction;
}

// ── JSON-RPC helper ───────────────────────────────────────────────────────────

async function rpc(method, params = []) {
  const res = await fetch(CONFIG.SUI_RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.TATUM_API_KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`RPC request failed: HTTP ${res.status}`);
  }

  const json = await res.json();

  if (json.error) {
    throw new Error(
      `RPC error [${method}]: ${json.error.message ?? JSON.stringify(json.error)}`,
    );
  }

  return json.result;
}

// ── Registry ID cache (sessionStorage) ───────────────────────────────────────
// Avoids re-querying on every vault refresh within the same tab session.

function _cacheGet(addr) {
  return sessionStorage.getItem(`vault_reg_${addr}`) || null;
}
function _cacheSet(addr, id) {
  sessionStorage.setItem(`vault_reg_${addr}`, id);
}

// ── IV store (localStorage) ───────────────────────────────────────────────────
// IVs are non-secret. We store them locally so the Decrypt button can pre-fill.
// On a new browser the IV comes from the share link instead.

const IV_KEY = "vault_ivs_v1";

function _ivGet() {
  try {
    return JSON.parse(localStorage.getItem(IV_KEY) || "{}");
  } catch {
    return {};
  }
}
function _ivSet(map) {
  localStorage.setItem(IV_KEY, JSON.stringify(map));
}

export function saveIV(blobId, ivHex) {
  const m = _ivGet();
  m[blobId] = ivHex;
  _ivSet(m);
}
export function deleteIV(blobId) {
  const m = _ivGet();
  delete m[blobId];
  _ivSet(m);
}
export function getIV(blobId) {
  return _ivGet()[blobId] ?? "";
}

// ── Find VaultRegistry object ─────────────────────────────────────────────────

/**
 * Find the VaultRegistry object ID owned by address.
 * Returns null if the user has never called create_registry.
 *
 * Uses suix_getOwnedObjects with a StructType filter.
 * @param {string} address
 * @returns {Promise<string|null>}
 */
export async function findRegistryId(address) {
  const cached = _cacheGet(address);
  if (cached) return cached;

  const result = await rpc("suix_getOwnedObjects", [
    address,
    {
      filter: {
        StructType: `${CONFIG.VAULT_PACKAGE_ID}::${CONFIG.VAULT_MODULE}::VaultRegistry`,
      },
      options: { showType: true, showContent: false },
    },
    null, // cursor
    50, // limit
  ]);

  const obj = result?.data?.[0]?.data;
  if (!obj?.objectId) return null;

  _cacheSet(address, obj.objectId);
  return obj.objectId;
}

// ── Fetch vault entries from chain ────────────────────────────────────────────

/**
 * Read all VaultEntry records from the on-chain VaultRegistry.
 *
 * Steps:
 *   1. Get the registry object (showContent: true) → get index vector + table ID
 *   2. For each blobId in index, fetch the dynamic field from the Table
 *
 * @param {string} registryId
 * @returns {Promise<Array>}
 */
export async function fetchEntries(registryId) {
  const result = await rpc("sui_getObject", [
    registryId,
    { showContent: true, showType: true },
  ]);

  const content = result?.data?.content;
  if (!content || content.dataType !== "moveObject") return [];

  const fields = content.fields ?? {};

  // index is a vector<String> — ordered list of blobIds
  const index = fields.index ?? [];
  if (!index.length) return [];

  // The Table object ID — try multiple possible RPC response shapes
  const tableId =
    fields.entries?.fields?.id?.id ??
    fields.entries?.id?.id ??
    fields.entries?.id ??
    null;

  if (!tableId) {
    console.warn(
      "[sui] Could not find Table ID in registry fields:",
      JSON.stringify(fields, null, 2),
    );
    return [];
  }

  const entries = [];

  for (const blobId of index) {
    const entry = await _fetchEntry(tableId, blobId);

    if (entry) {
      entries.push(entry);
    }

    await new Promise((r) => setTimeout(r, 100));
  }
  return entries.filter(Boolean).sort((a, b) => b.uploadedAt - a.uploadedAt);
}

async function _fetchEntry(tableId, blobId) {
  try {
    const result = await rpc("suix_getDynamicFieldObject", [
      tableId,
      { type: "0x1::string::String", value: blobId },
    ]);

    // The dynamic field wraps the value — unwrap it
    const raw =
      result?.data?.content?.fields?.value?.fields ??
      result?.data?.content?.fields ??
      null;

    if (!raw) {
      console.warn("[sui] Empty entry for blobId:", blobId);
      return null;
    }

    return {
      blobId: String(raw.blob_id ?? blobId),
      filename: String(raw.filename ?? "Unknown"),
      mimeType: String(raw.mime_type ?? "application/octet-stream"),
      sizeBytes: Number(raw.size_bytes ?? 0),
      uploadedAt: Number(raw.uploaded_at ?? 0),
      ivHex: getIV(blobId), // from localStorage
    };
  } catch (err) {
    console.warn(`[sui] Failed to fetch entry for ${blobId}:`, err.message);
    return null;
  }
}

// ── Current epoch ─────────────────────────────────────────────────────────────

export async function getCurrentEpoch() {
  try {
    const result = await rpc("suix_getLatestSuiSystemState", []);
    const epoch = Number(result?.epoch ?? 0);
    if (epoch) localStorage.setItem("vault_current_epoch", String(epoch));
    return epoch;
  } catch {
    return Number(localStorage.getItem("vault_current_epoch") ?? 0);
  }
}

// ── Transaction builders ──────────────────────────────────────────────────────
// Per official Sui docs (https://docs.sui.io/guides/developer/sui-101/building-ptb):
//   tx.pure.string(val)         — Move String
//   tx.pure.u64(val)            — u64
//   tx.pure.vector('u8', bytes) — vector<u8>
//   tx.object(id)               — object reference
//   "0x6"                       — Sui Clock shared object

/**
 * Build a create_registry transaction.
 * No arguments — creates a VaultRegistry and transfers it to the sender.
 */
export async function buildCreateRegistryTx() {
  const Transaction = await _loadTransaction();
  const tx = new Transaction();

  tx.moveCall({
    target: `${CONFIG.VAULT_PACKAGE_ID}::${CONFIG.VAULT_MODULE}::create_registry`,
  });

  // Gas budget in MIST. SDK auto-selects from wallet's gas coins.
  tx.setGasBudget(20_000_000);
  return tx;
}

/**
 * Build an add_entry transaction.
 *
 * Contract signature:
 *   add_entry(registry: &mut VaultRegistry, blob_id: vector<u8>,
 *             filename: vector<u8>, mime_type: vector<u8>,
 *             size_bytes: u64, clock: &Clock, ctx: &mut TxContext)
 *
 * @param {string} registryId
 * @param {{ blobId: string, filename: string, mimeType: string, sizeBytes: number }} entry
 */
export async function buildAddEntryTx(registryId, entry) {
  const Transaction = await _loadTransaction();
  const tx = new Transaction();
  const enc = new TextEncoder();

  tx.moveCall({
    target: `${CONFIG.VAULT_PACKAGE_ID}::${CONFIG.VAULT_MODULE}::add_entry`,
    arguments: [
      tx.object(registryId), // &mut VaultRegistry
      tx.pure.vector("u8", enc.encode(entry.blobId)), // blob_id: vector<u8>
      tx.pure.vector("u8", enc.encode(entry.filename)), // filename: vector<u8>
      tx.pure.vector("u8", enc.encode(entry.mimeType)), // mime_type: vector<u8>
      tx.pure.u64(entry.sizeBytes), // size_bytes: u64
      tx.object("0x6"), // clock: &Clock
    ],
  });

  tx.setGasBudget(20_000_000);
  return tx;
}

/**
 * Build a remove_entry transaction.
 *
 * Contract signature:
 *   remove_entry(registry: &mut VaultRegistry, blob_id: vector<u8>, ctx: &mut TxContext)
 *
 * @param {string} registryId
 * @param {string} blobId
 */
export async function buildRemoveEntryTx(registryId, blobId) {
  const Transaction = await _loadTransaction();
  const tx = new Transaction();
  const enc = new TextEncoder();

  tx.moveCall({
    target: `${CONFIG.VAULT_PACKAGE_ID}::${CONFIG.VAULT_MODULE}::remove_entry`,
    arguments: [
      tx.object(registryId),
      tx.pure.vector("u8", enc.encode(blobId)),
    ],
  });

  tx.setGasBudget(20_000_000);
  return tx;
}

// ── Execute transaction via wallet ────────────────────────────────────────────
//
// Per migration guide (https://sdk.mystenlabs.com/typescript/migrations/sui-1.0):
//   New feature name: "sui:signAndExecuteTransaction"
//   Old (deprecated):  "sui:signAndExecuteTransactionBlock"
//   Both still work — wallets should implement both during transition.
//
// Helper from @mysten/wallet-standard:
//   import { signAndExecuteTransaction } from '@mysten/wallet-standard';
//   const { digest, effects } = await signAndExecuteTransaction(wallet, { transaction });
//
// We use the feature directly to avoid another CDN import.

/**
 * Sign and execute a Transaction using the connected wallet.
 *
 * @param {object}      wallet      — wallet object from getWallets().get()
 * @param {Transaction} tx          — built Transaction
 * @returns {Promise<{ digest: string, effects: object }>}
 */
export async function executeTransaction(wallet, account, tx) {
  const options = { showEffects: true, showObjectChanges: true };

  // Try new feature name first, then old deprecated name
  const feature =
    wallet.features?.["sui:signAndExecuteTransaction"] ??
    wallet.features?.["sui:signAndExecuteTransactionBlock"] ??
    null;

  if (!feature) {
    throw new Error(
      `${wallet.name ?? "Wallet"} does not support transaction signing. ` +
        "Please update your wallet extension.",
    );
  }

  // Both feature versions — try the current API first, fall back to old
  if (feature.signAndExecuteTransaction) {
    return feature.signAndExecuteTransaction({ account: wallet.accounts?.[0], transaction: tx, options , chain: CONFIG.SUI_CHAIN });
  }

  if (feature.signAndExecuteTransactionBlock) {
    return feature.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      chain: CONFIG.SUI_CHAIN,
      options,
    });
  }

  throw new Error("Wallet feature found but no callable method detected.");
}
