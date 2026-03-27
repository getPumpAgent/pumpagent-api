import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("swap");

const JUPITER_ULTRA_URL = "https://api.jup.ag/ultra/v1";

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
    },
  },
};

function getGatekeeperUrl(apiKey: string): string {
  return `https://beta.helius-rpc.com/?api-key=${apiKey}`;
}

function getSenderEndpoint(): string {
  return process.env.SENDER_ENDPOINT || "https://sender.helius-rpc.com/fast";
}

async function fetchJupiterOrder(
  params: Record<string, any>,
  apiKey: string,
  maxRetries: number = 3,
): Promise<{ data: any; retryCount: number }> {
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.get(`${JUPITER_ULTRA_URL}/order`, {
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
  app.post<{ Body: SwapBody }>("/v1/swap", { schema: swapSchema }, async (req, reply) => {
    const referralAccount = process.env.REFERRAL_ACCOUNT;
    const jupiterApiKey = process.env.JUPITER_API_KEY;
    const heliusApiKey = process.env.HELIUS_API_KEY;
    const heliusRpcUrl = heliusApiKey
      ? getGatekeeperUrl(heliusApiKey)
      : process.env.HELIUS_RPC_URL;

    if (!referralAccount) {
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
    } = req.body;

    const PLATFORM_FEE_BPS = 50; // 0.5%

    try {
      // Build order via Jupiter Ultra API
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

      const { data, retryCount } = await fetchJupiterOrder(orderPayload, jupiterApiKey);

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

      // Simulate the transaction to ensure the swap is valid
      const baseSim = await simulateTransaction(data.transaction, heliusRpcUrl);
      if (!baseSim.passed) {
        return reply.status(422).send({
          error: "Transaction simulation failed",
          simulationError: baseSim.error,
        });
      }

      // Jito routing is handled automatically by Helius Sender endpoint
      // No manual tip injection needed — Sender routes through Jito when
      // submitted to https://sender.helius-rpc.com/fast
      const jitoEnabled = jito;

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
        jitoEnabled,
        tipLamports: 0,
        senderEndpoint: getSenderEndpoint(),
        pool,
        priorityLevel,
        retryCount,
        simulationPassed: true,
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

  // POST /v1/swap/send — Submit signed transaction via Helius Sender
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
