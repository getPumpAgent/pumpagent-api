import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("swap");

// ── Swap V2 (upgraded from Ultra V1) ────────────────────────────────────
const JUPITER_SWAP_V2_URL = "https://api.jup.ag/swap/v2";

// Keep V1 as fallback
const JUPITER_ULTRA_V1_URL = "https://api.jup.ag/ultra/v1";

const PRIORITY_FEE_MAP = {
  low: 1_000,
  medium: 50_000,
  high: 200_000,
  turbo: 1_000_000,
} as const;

type PriorityLevel = keyof typeof PRIORITY_FEE_MAP;

interface SwapBody {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippage?: number | "auto";
  pool?: "pump" | "pumpswap" | "auto";
  userWallet: string;
  jito?: boolean;
  priorityLevel?: PriorityLevel;
  jitoTipLamports?: number;
  receiver?: string;
  useV1?: boolean; // fallback to Ultra V1 if needed
}

const swapSchema = {
  body: {
    type: "object" as const,
    required: ["inputMint", "outputMint", "amount", "userWallet"],
    properties: {
      inputMint: { type: "string" },
      outputMint: { type: "string" },
      amount: { type: "number" },
      slippage: {},
      pool: { type: "string", enum: ["pump", "pumpswap", "auto"] },
      userWallet: { type: "string" },
      jito: { type: "boolean" },
      priorityLevel: { type: "string", enum: ["low", "medium", "high", "turbo"] },
      jitoTipLamports: { type: "number" },
      receiver: { type: "string" },
      useV1: { type: "boolean" },
    },
  },
};

function getGatekeeperUrl(apiKey: string): string {
  return `https://beta.helius-rpc.com/?api-key=${apiKey}`;
}

function getSenderEndpoint(): string {
  return process.env.SENDER_ENDPOINT || "https://sender.helius-rpc.com/fast";
}

// ── V2 order fetch with retry ───────────────────────────────────────────

async function fetchSwapV2Order(
  params: Record<string, string>,
  apiKey: string,
  maxRetries: number = 3,
): Promise<{ data: any; retryCount: number }> {
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.get(`${JUPITER_SWAP_V2_URL}/order`, {
        params,
        headers: { "x-api-key": apiKey },
      });
      return { data, retryCount };
    } catch (err: any) {
      const status = err.response?.status;
      // Retry on 5xx and retryable error codes
      if (status && status >= 500 && status < 600 && attempt < maxRetries) {
        retryCount++;
        const delay = Math.min(500 * 2 ** attempt + Math.random() * 200, 5000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (status === 429 && attempt < maxRetries) {
        retryCount++;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Max retries exceeded");
}

// ── V1 fallback ─────────────────────────────────────────────────────────

async function fetchUltraV1Order(
  params: Record<string, any>,
  apiKey: string,
  maxRetries: number = 3,
): Promise<{ data: any; retryCount: number }> {
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.get(`${JUPITER_ULTRA_V1_URL}/order`, {
        params,
        headers: { "x-api-key": apiKey },
      });
      return { data, retryCount };
    } catch (err: any) {
      const status = err.response?.status;
      if (status && status >= 500 && status < 600 && attempt < maxRetries) {
        retryCount++;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Max retries exceeded");
}

// ── V2 managed execute ──────────────────────────────────────────────────

async function executeSwapV2(
  signedTransaction: string,
  requestId: string,
  apiKey: string,
): Promise<{ data: any }> {
  const { data } = await axios.post(
    `${JUPITER_SWAP_V2_URL}/execute`,
    { swapTransaction: signedTransaction, requestId },
    { headers: { "Content-Type": "application/json", "x-api-key": apiKey } },
  );
  return { data };
}

async function simulateTransaction(
  transaction: string,
  rpcUrl: string,
): Promise<{ passed: boolean; error: any }> {
  const { data } = await axios.post(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "simulateTransaction",
    params: [transaction, { encoding: "base64" }],
  });

  const result = data.result;
  if (result?.value?.err) {
    return { passed: false, error: result.value.err };
  }
  return { passed: true, error: null };
}

async function sendViaSender(
  transaction: string,
  senderEndpoint: string,
  apiKey: string,
): Promise<{ signature: string | null; error: any }> {
  try {
    const url = apiKey
      ? `${senderEndpoint}?api-key=${apiKey}`
      : senderEndpoint;

    const { data } = await axios.post(url, {
      jsonrpc: "2.0",
      id: "sender",
      method: "sendTransaction",
      params: [
        transaction,
        {
          skipPreflight: true,
          maxRetries: 0,
          encoding: "base64",
        },
      ],
    });

    if (data.error) {
      return { signature: null, error: data.error };
    }

    return { signature: data.result ?? null, error: null };
  } catch (err: any) {
    return { signature: null, error: err.response?.data ?? err.message };
  }
}

export async function swapRoutes(app: FastifyInstance) {
  // ── POST /v1/swap — Build unsigned swap transaction (V2 primary, V1 fallback) ──
  app.post<{ Body: SwapBody }>("/v1/swap", { schema: swapSchema }, async (req, reply) => {
    const referralAccountUltra = process.env.REFERRAL_ACCOUNT;   // Ultra (V1)
    const referralAccountSwap = process.env.REFERRAL_ACCOUNT_SWAP; // Swap + Trigger (V2)
    const jupiterApiKey = process.env.JUPITER_API_KEY;
    const heliusApiKey = process.env.HELIUS_API_KEY;
    const heliusRpcUrl = heliusApiKey
      ? getGatekeeperUrl(heliusApiKey)
      : process.env.HELIUS_RPC_URL;

    if (!referralAccountUltra && !referralAccountSwap) {
      return reply.status(500).send({ error: "REFERRAL_ACCOUNT not configured" });
    }
    if (!jupiterApiKey) {
      return reply.status(500).send({ error: "JUPITER_API_KEY not configured" });
    }
    if (!heliusRpcUrl) {
      return reply.status(500).send({ error: "HELIUS_RPC_URL or HELIUS_API_KEY not configured" });
    }

    const {
      inputMint,
      outputMint,
      amount,
      slippage = "auto",
      pool = "auto",
      userWallet,
      jito = false,
      priorityLevel = "medium",
      jitoTipLamports,
      receiver,
      useV1 = false,
    } = req.body;

    const PLATFORM_FEE_BPS = 50; // 0.5%

    try {
      // ── V2 path (default) ──────────────────────────────────────────
      if (!useV1) {
        const referralAccount = referralAccountSwap ?? referralAccountUltra!;
        const orderParams: Record<string, string> = {
          inputMint,
          outputMint,
          amount: amount.toString(),
          taker: userWallet,
          referralFee: PLATFORM_FEE_BPS.toString(),
          referralAccount,
        };

        if (slippage !== "auto") {
          orderParams.slippageBps = slippage.toString();
        }

        // Priority fee
        orderParams.priorityFeeLamports = PRIORITY_FEE_MAP[priorityLevel].toString();

        // Jito MEV tip
        if (jito && jitoTipLamports) {
          orderParams.jitoTipLamports = jitoTipLamports.toString();
        }

        // Custom receiver
        if (receiver) {
          orderParams.receiver = receiver;
        }

        const { data, retryCount } = await fetchSwapV2Order(orderParams, jupiterApiKey);

        if (data.error || data.errorCode) {
          return reply.status(422).send({
            error: data.error ?? data.errorMessage ?? "Jupiter V2 order failed",
            errorCode: data.errorCode ?? null,
            details: data,
          });
        }

        if (!data.swapTransaction && !data.transaction) {
          return reply.status(502).send({
            error: "Jupiter V2 did not return a transaction",
            details: data,
          });
        }

        const txBase64 = data.swapTransaction ?? data.transaction;

        // Simulate
        const sim = await simulateTransaction(txBase64, heliusRpcUrl);
        if (!sim.passed) {
          return reply.status(422).send({
            error: "Transaction simulation failed",
            simulationError: sim.error,
          });
        }

        return {
          transaction: txBase64,
          requestId: data.requestId ?? null,
          inputMint,
          outputMint,
          inAmount: data.inAmount ?? amount.toString(),
          outAmount: data.outAmount ?? null,
          otherAmountThreshold: data.otherAmountThreshold ?? null,
          slippageBps: data.slippageBps ?? (slippage === "auto" ? "auto" : slippage),
          platformFee: {
            bps: PLATFORM_FEE_BPS,
            percent: "0.5%",
            referralAccount,
          },
          jito,
          jitoTipLamports: jitoTipLamports ?? 0,
          senderEndpoint: getSenderEndpoint(),
          pool,
          priorityLevel,
          retryCount,
          simulationPassed: true,
          apiVersion: "v2",
          mode: data.mode ?? "ultra",
          router: data.router ?? null,
        };
      }

      // ── V1 fallback path (Ultra) ────────────────────────────────────
      const referralAccount = referralAccountUltra ?? referralAccountSwap!;
      const orderPayload: Record<string, any> = {
        inputMint,
        outputMint,
        amount: amount.toString(),
        taker: userWallet,
        referralFee: PLATFORM_FEE_BPS,
        referralAccount,
        computeUnitPriceMicroLamports: PRIORITY_FEE_MAP[priorityLevel],
      };

      if (slippage !== "auto") {
        orderPayload.slippageBps = slippage;
      } else {
        orderPayload.autoSlippage = true;
      }

      const { data, retryCount } = await fetchUltraV1Order(orderPayload, jupiterApiKey);

      if (data.error || data.errorCode) {
        return reply.status(422).send({
          error: data.error ?? data.errorMessage ?? "Jupiter order failed",
          errorCode: data.errorCode ?? null,
          details: data,
        });
      }

      if (!data.transaction) {
        return reply.status(502).send({
          error: "Jupiter did not return a transaction",
          details: data,
        });
      }

      const baseSim = await simulateTransaction(data.transaction, heliusRpcUrl);
      if (!baseSim.passed) {
        return reply.status(422).send({
          error: "Transaction simulation failed",
          simulationError: baseSim.error,
        });
      }

      return {
        transaction: data.transaction,
        requestId: data.requestId ?? null,
        inputMint,
        outputMint,
        inAmount: data.inAmount ?? amount.toString(),
        outAmount: data.outAmount ?? null,
        otherAmountThreshold: data.otherAmountThreshold ?? null,
        slippageBps: data.slippageBps ?? (slippage === "auto" ? "auto" : slippage),
        platformFee: {
          bps: PLATFORM_FEE_BPS,
          percent: "0.5%",
          referralAccount,
        },
        jito,
        jitoEnabled: jito,
        tipLamports: 0,
        senderEndpoint: getSenderEndpoint(),
        pool,
        priorityLevel,
        retryCount,
        simulationPassed: true,
        apiVersion: "v1",
      };
    } catch (err: any) {
      const status = err.response?.status ?? 502;
      const details = err.response?.data ?? err.message;
      return reply.status(status).send({
        error: "Jupiter swap order failed",
        details,
      });
    }
  });

  // ── POST /v1/swap/execute — V2 managed execution (Jupiter handles landing) ──
  app.post<{ Body: { transaction: string; requestId?: string } }>(
    "/v1/swap/execute",
    async (req, reply) => {
      const jupiterApiKey = process.env.JUPITER_API_KEY;
      const { transaction, requestId } = req.body;

      if (!transaction) {
        return reply.status(400).send({ error: "transaction (base64) is required" });
      }
      if (!jupiterApiKey) {
        return reply.status(500).send({ error: "JUPITER_API_KEY not configured" });
      }

      try {
        const { data } = await executeSwapV2(transaction, requestId ?? "", jupiterApiKey);

        if (data.error) {
          const retryable = [-1, -1000, -1001, -1004, -2000, -2001, -2003, -2004].includes(data.code);
          return reply.status(retryable ? 503 : 422).send({
            error: data.error,
            code: data.code ?? null,
            retryable,
            details: data,
          });
        }

        log.info({ sig: data.txSignature ?? data.signature }, "Swap executed via Jupiter V2");
        return {
          signature: data.txSignature ?? data.signature ?? null,
          status: data.status ?? "confirmed",
          method: "jupiter_v2_execute",
          details: data,
        };
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Jupiter V2 execute failed",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── POST /v1/swap/send — Submit signed transaction (Helius Sender + RPC fallback) ──
  app.post<{ Body: { transaction: string } }>(
    "/v1/swap/send",
    async (req, reply) => {
      const heliusApiKey = process.env.HELIUS_API_KEY;
      const { transaction } = req.body;

      if (!transaction) {
        return reply.status(400).send({ error: "transaction (base64) is required" });
      }

      const senderEndpoint = getSenderEndpoint();

      // Try Helius Sender first
      const senderResult = await sendViaSender(
        transaction,
        senderEndpoint,
        heliusApiKey ?? "",
      );

      if (senderResult.signature) {
        log.info({ sig: senderResult.signature }, "Sent via Helius Sender");
        return {
          signature: senderResult.signature,
          method: "helius_sender",
          endpoint: senderEndpoint,
        };
      }

      // Fallback: submit via standard RPC sendTransaction
      log.warn({ err: senderResult.error }, "Helius Sender failed, falling back to RPC");

      const rpcUrl = heliusApiKey
        ? getGatekeeperUrl(heliusApiKey)
        : process.env.HELIUS_RPC_URL;

      if (!rpcUrl) {
        return reply.status(502).send({
          error: "Helius Sender failed and no RPC fallback available",
          senderError: senderResult.error,
        });
      }

      try {
        const { data } = await axios.post(rpcUrl, {
          jsonrpc: "2.0",
          id: "rpc-fallback",
          method: "sendTransaction",
          params: [
            transaction,
            {
              skipPreflight: true,
              maxRetries: 2,
              encoding: "base64",
            },
          ],
        });

        if (data.error) {
          return reply.status(502).send({
            error: "Both Helius Sender and RPC fallback failed",
            senderError: senderResult.error,
            rpcError: data.error,
          });
        }

        log.info({ sig: data.result }, "Sent via RPC fallback");
        return {
          signature: data.result,
          method: "rpc_fallback",
          endpoint: rpcUrl.replace(/api-key=[^&]+/, "api-key=***"),
        };
      } catch (err: any) {
        return reply.status(502).send({
          error: "Both Helius Sender and RPC fallback failed",
          senderError: senderResult.error,
          rpcError: err.response?.data ?? err.message,
        });
      }
    },
  );
}

// --- Transaction status endpoint ---

interface StatusParams {
  signature: string;
}

export async function swapStatusRoutes(app: FastifyInstance) {
  app.get<{ Params: StatusParams }>(
    "/v1/swap/status/:signature",
    async (req, reply) => {
      const heliusApiKey = process.env.HELIUS_API_KEY;
      const heliusRpcUrl = heliusApiKey
        ? getGatekeeperUrl(heliusApiKey)
        : process.env.HELIUS_RPC_URL;

      if (!heliusRpcUrl) {
        return reply.status(500).send({ error: "HELIUS_RPC_URL not configured" });
      }

      const { signature } = req.params;

      try {
        const { data } = await axios.post(heliusRpcUrl, {
          jsonrpc: "2.0",
          id: 1,
          method: "getSignatureStatuses",
          params: [[signature]],
        });

        const value = data.result?.value?.[0];

        if (!value) {
          return {
            signature,
            status: "not_found",
            slot: null,
            err: null,
          };
        }

        let status: string;
        if (value.err) {
          status = "failed";
        } else if (value.confirmationStatus === "finalized" || value.confirmationStatus === "confirmed") {
          status = "confirmed";
        } else {
          status = "pending";
        }

        return {
          signature,
          status,
          slot: value.slot ?? null,
          err: value.err ?? null,
        };
      } catch (err: any) {
        return reply.status(502).send({
          error: "Failed to fetch signature status",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );
}
