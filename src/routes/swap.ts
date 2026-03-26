import { FastifyInstance } from "fastify";
import axios from "axios";

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

  // Unreachable, but satisfies TS
  throw new Error("Max retries exceeded");
}

async function simulateTransaction(
  transaction: string,
  heliusRpcUrl: string,
): Promise<{ passed: boolean; error: any }> {
  const { data } = await axios.post(heliusRpcUrl, {
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

export async function swapRoutes(app: FastifyInstance) {
  app.post<{ Body: SwapBody }>("/v1/swap", { schema: swapSchema }, async (req, reply) => {
    const referralAccount = process.env.REFERRAL_ACCOUNT;
    const jupiterApiKey = process.env.JUPITER_API_KEY;
    const heliusRpcUrl = process.env.HELIUS_RPC_URL;

    if (!referralAccount) {
      return reply.status(500).send({ error: "REFERRAL_ACCOUNT not configured" });
    }
    if (!jupiterApiKey) {
      return reply.status(500).send({ error: "JUPITER_API_KEY not configured" });
    }
    if (!heliusRpcUrl) {
      return reply.status(500).send({ error: "HELIUS_RPC_URL not configured" });
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

      if (jito) {
        orderPayload.prioritizationFeeLamports = "jitoTipDefault";
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

      // Simulate the transaction before returning
      const simulation = await simulateTransaction(data.transaction, heliusRpcUrl);
      if (!simulation.passed) {
        return reply.status(422).send({
          error: "Transaction simulation failed",
          simulationError: simulation.error,
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
}

// --- Transaction status endpoint ---

interface StatusParams {
  signature: string;
}

export async function swapStatusRoutes(app: FastifyInstance) {
  app.get<{ Params: StatusParams }>(
    "/v1/swap/status/:signature",
    async (req, reply) => {
      const heliusRpcUrl = process.env.HELIUS_RPC_URL;
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
