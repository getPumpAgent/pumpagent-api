import axios from "axios";
import { Connection, VersionedTransaction, TransactionMessage, PublicKey } from "@solana/web3.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("jupiter-trigger");

const TRIGGER_BASE_URL = "https://lite-api.jup.ag/trigger/v2";
const TRIGGER_V1_URL = "https://api.jup.ag/trigger/v1";
const REQUEST_TIMEOUT = 20_000; // 20s per attempt
const MAX_RETRIES = 2;

function getApiKey(): string {
  const key = process.env.JUPITER_API_KEY;
  if (!key) throw new Error("JUPITER_API_KEY not configured");
  return key;
}

function authHeaders(jwt: string) {
  return {
    "Content-Type": "application/json",
    "x-api-key": getApiKey(),
    Authorization: `Bearer ${jwt}`,
  };
}

function apiKeyHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": getApiKey(),
  };
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err.response?.status;
      // Only retry on 5xx / timeout / network errors
      if (status && status < 500 && err.code !== "ECONNABORTED") throw err;
      if (i < retries) {
        log.warn({ label, attempt: i + 1, status, code: err.code }, "Retrying after failure");
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ── Authentication ──────────────────────────────────────────────────────

export async function requestChallenge(
  walletPubkey: string,
  type: "message" | "transaction" = "message",
) {
  const { data } = await axios.post(
    `${TRIGGER_BASE_URL}/auth/challenge`,
    { walletPubkey, type },
    { headers: apiKeyHeaders(), timeout: REQUEST_TIMEOUT },
  );
  log.info({ walletPubkey, type }, "Challenge requested");
  return data; // { type, challenge } or { type, transaction }
}

export async function verifyChallenge(
  walletPubkey: string,
  type: "message" | "transaction",
  payload: { signature?: string; signedTransaction?: string },
) {
  const body: Record<string, any> = { type, walletPubkey };
  if (type === "message") {
    body.signature = payload.signature;
  } else {
    body.signedTransaction = payload.signedTransaction;
  }

  const { data } = await axios.post(
    `${TRIGGER_BASE_URL}/auth/verify`,
    body,
    { headers: apiKeyHeaders(), timeout: REQUEST_TIMEOUT },
  );
  log.info({ walletPubkey }, "Challenge verified, JWT issued");
  return data; // { token }
}

export async function verifyToken(walletPubkey: string, jwt: string) {
  const { data } = await axios.post(
    `${TRIGGER_BASE_URL}/auth/verify-token`,
    { walletPubkey },
    { headers: authHeaders(jwt), timeout: REQUEST_TIMEOUT },
  );
  return data;
}

// ── Vault ───────────────────────────────────────────────────────────────

export async function getVault(jwt: string) {
  const { data } = await axios.get(`${TRIGGER_BASE_URL}/vault`, {
    headers: authHeaders(jwt),
    timeout: REQUEST_TIMEOUT,
  });
  return data; // { userPubkey, vaultPubkey, privyVaultId }
}

export async function registerVault(jwt: string) {
  const { data } = await axios.get(`${TRIGGER_BASE_URL}/vault/register`, {
    headers: authHeaders(jwt),
    timeout: REQUEST_TIMEOUT,
  });
  log.info("Vault registered");
  return data;
}

// ── ALT Stripping ───────────────────────────────────────────────────────
// Phantom modifies VersionedTransactions that use Address Lookup Tables (ALTs)
// by resolving them into static accounts. Jupiter rejects the modified bytes.
// Fix: resolve ALTs server-side and recompile without them BEFORE sending to frontend.

function getRpcUrl(): string {
  return process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
}

async function stripAddressLookupTables(txBase64: string): Promise<string> {
  const txBytes = Buffer.from(txBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBytes);

  // If no ALTs, return as-is
  if (!tx.message.addressTableLookups || tx.message.addressTableLookups.length === 0) {
    log.info("Deposit tx has no ALTs, returning as-is");
    return txBase64;
  }

  log.info({ altCount: tx.message.addressTableLookups.length }, "Stripping ALTs from deposit tx");

  const connection = new Connection(getRpcUrl(), "confirmed");

  // Fetch all lookup table accounts
  const altAccounts = await Promise.all(
    tx.message.addressTableLookups.map(async (lookup) => {
      const result = await connection.getAddressLookupTable(lookup.accountKey);
      if (!result.value) throw new Error(`ALT not found: ${lookup.accountKey.toBase58()}`);
      return result.value;
    }),
  );

  // Decompile with ALT context, then recompile WITHOUT ALTs
  const decompiled = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: altAccounts,
  });
  const recompiled = decompiled.compileToV0Message(); // no ALTs = all accounts static

  // Build new tx with same signature slot count but zero-filled signatures
  const newTx = new VersionedTransaction(recompiled);

  const newBytes = Buffer.from(newTx.serialize());
  log.info({ origLen: txBytes.length, newLen: newBytes.length }, "ALTs stripped from deposit tx");
  return newBytes.toString("base64");
}

// ── Deposit ─────────────────────────────────────────────────────────────

export async function craftDeposit(
  jwt: string,
  params: {
    inputMint: string;
    outputMint: string;
    userAddress: string;
    amount: string;
  },
) {
  const data = await withRetry("deposit/craft", async () => {
    const res = await axios.post(
      `${TRIGGER_BASE_URL}/deposit/craft`,
      params,
      { headers: authHeaders(jwt), timeout: REQUEST_TIMEOUT },
    );
    return res.data;
  });
  log.info({ requestId: data.requestId, txLen: data.transaction?.length }, "Deposit transaction crafted");

  return data; // { transaction, requestId, receiverAddress, mint, amount, tokenDecimals }
}

// ── Orders ──────────────────────────────────────────────────────────────

export async function createOrder(jwt: string, orderPayload: Record<string, any>) {
  log.info({ orderType: orderPayload.orderType, inputMint: orderPayload.inputMint }, "Sending order to Jupiter Trigger API");

  try {
    const { data } = await axios.post(
      `${TRIGGER_BASE_URL}/orders/price`,
      orderPayload,
      { headers: authHeaders(jwt), timeout: 55_000 },
    );
    log.info({ id: data.id, type: orderPayload.orderType }, "Order created");
    return data;
  } catch (err: any) {
    // CloudFront 504 — Jupiter may have actually processed the order.
    // Check order history to see if it went through.
    const status = err.response?.status;
    const isTimeout = status === 504 || status === 502 || err.code === "ECONNABORTED";
    if (isTimeout) {
      log.warn("Order request timed out — checking if Jupiter created it anyway");
      await new Promise((r) => setTimeout(r, 5000)); // give Jupiter a moment
      try {
        const history = await getOrderHistory(jwt, { state: "active", limit: 1, sort: "created_at", dir: "desc" });
        const recent = history?.orders?.[0];
        // If the most recent order was created in the last 2 minutes, it's likely ours
        if (recent?.id && recent.createdAt && (Date.now() - recent.createdAt) < 120_000) {
          log.info({ id: recent.id }, "Found order in history after timeout — it went through!");
          return { id: recent.id, txSignature: recent.events?.[0]?.txSignature ?? null, recoveredAfterTimeout: true };
        }
      } catch (histErr: any) {
        log.warn({ err: histErr.message }, "Failed to check order history after timeout");
      }
    }
    throw err;
  }
}

export async function updateOrder(
  jwt: string,
  orderId: string,
  updates: Record<string, any>,
) {
  const { data } = await axios.patch(
    `${TRIGGER_BASE_URL}/orders/price/${orderId}`,
    updates,
    { headers: authHeaders(jwt), timeout: REQUEST_TIMEOUT },
  );
  log.info({ id: orderId }, "Order updated");
  return data; // { id }
}

export async function cancelOrder(jwt: string, orderId: string) {
  const { data } = await axios.post(
    `${TRIGGER_BASE_URL}/orders/price/cancel/${orderId}`,
    {},
    { headers: authHeaders(jwt), timeout: REQUEST_TIMEOUT },
  );
  log.info({ id: orderId, requestId: data.requestId }, "Cancel initiated");
  return data; // { id, transaction, requestId }
}

export async function confirmCancel(
  jwt: string,
  orderId: string,
  signedTransaction: string,
  cancelRequestId: string,
) {
  const { data } = await axios.post(
    `${TRIGGER_BASE_URL}/orders/price/confirm-cancel/${orderId}`,
    { signedTransaction, cancelRequestId },
    { headers: authHeaders(jwt), timeout: REQUEST_TIMEOUT },
  );
  log.info({ id: orderId }, "Cancel confirmed");
  return data; // { id, txSignature }
}

export async function getOrderHistory(
  jwt: string,
  params: {
    state?: "active" | "past";
    mint?: string;
    limit?: number;
    offset?: number;
    sort?: "updated_at" | "created_at" | "expires_at";
    dir?: "asc" | "desc";
  },
) {
  const { data } = await axios.get(`${TRIGGER_BASE_URL}/orders/history`, {
    headers: authHeaders(jwt),
    params,
    timeout: REQUEST_TIMEOUT,
  });
  return data; // { orders, pagination }
}

// ── V1 Limit Orders (on-chain, no vault/deposit) ──────────────────────

export async function createOrderV1(params: {
  inputMint: string;
  outputMint: string;
  maker: string;
  payer: string;
  makingAmount: string;
  takingAmount: string;
  expiredAt?: string;
  feeBps?: string;
  feeAccount?: string;
}) {
  const body: Record<string, any> = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    maker: params.maker,
    payer: params.payer,
    params: {
      makingAmount: params.makingAmount,
      takingAmount: params.takingAmount,
    },
    computeUnitPrice: "auto",
    wrapAndUnwrapSol: true,
  };

  if (params.expiredAt) body.params.expiredAt = params.expiredAt;
  if (params.feeBps) body.params.feeBps = params.feeBps;
  if (params.feeAccount) body.feeAccount = params.feeAccount;

  log.info({ inputMint: params.inputMint, outputMint: params.outputMint }, "Creating V1 trigger order");

  const { data } = await axios.post(
    `${TRIGGER_V1_URL}/createOrder`,
    body,
    { headers: apiKeyHeaders(), timeout: 30_000 },
  );
  log.info({ order: data.order }, "V1 order transaction crafted");
  return data; // { transaction(s), order, requestId }
}
