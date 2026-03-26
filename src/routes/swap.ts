import { FastifyInstance } from "fastify";
import axios from "axios";

const JUPITER_ULTRA_URL = "https://api.jup.ag/ultra/v1";

interface SwapBody {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippage?: number | "auto";
  pool?: "pump" | "pumpswap" | "auto";
  userWallet: string;
  jito?: boolean;
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
    },
  },
};

export async function swapRoutes(app: FastifyInstance) {
  app.post<{ Body: SwapBody }>("/v1/swap", { schema: swapSchema }, async (req, reply) => {
    const referralAccount = process.env.REFERRAL_ACCOUNT;
    const jupiterApiKey = process.env.JUPITER_API_KEY;
    if (!referralAccount) {
      return reply.status(500).send({ error: "REFERRAL_ACCOUNT not configured" });
    }
    if (!jupiterApiKey) {
      return reply.status(500).send({ error: "JUPITER_API_KEY not configured" });
    }

    const {
      inputMint,
      outputMint,
      amount,
      slippage = "auto",
      pool = "auto",
      userWallet,
      jito = false,
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
      };

      if (slippage !== "auto") {
        orderPayload.slippageBps = slippage;
      } else {
        orderPayload.autoSlippage = true;
      }

      if (jito) {
        orderPayload.prioritizationFeeLamports = "jitoTipDefault";
      }

      const { data } = await axios.get(`${JUPITER_ULTRA_URL}/order`, {
        params: orderPayload,
        headers: { "x-api-key": jupiterApiKey },
      });

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
