import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dca");

const RECURRING_BASE_URL = "https://api.jup.ag/recurring/v1";
const PRICE_V3_URL = "https://api.jup.ag/price/v3";
const MIN_ORDER_USD = 50;

function getApiKey(): string {
  const key = process.env.JUPITER_API_KEY;
  if (!key) throw new Error("JUPITER_API_KEY not configured");
  return key;
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": getApiKey(),
  };
}

// ── Interfaces ──────────────────────────────────────────────────────────

interface CreateDcaBody {
  user: string;
  inputMint: string;
  outputMint: string;
  inAmount: string | number;
  numberOfOrders: number;
  interval: number; // seconds between executions
  minPrice?: number;
  maxPrice?: number;
  startAt?: number | null; // unix timestamp, null = immediate
}

interface CancelDcaBody {
  order: string; // order account address
  user: string;
  recurringType?: string;
}

interface GetOrdersQuery {
  user: string;
  orderStatus: "active" | "history";
  recurringType?: string;
  page?: string;
  inputMint?: string;
  outputMint?: string;
  includeFailedTx?: string;
}

interface SendSignedTxBody {
  signedTransaction: string;
  requestId: string;
}

// ── Routes ──────────────────────────────────────────────────────────────

export async function dcaRoutes(app: FastifyInstance) {
  // ── Create DCA Order ────────────────────────────────────────────────
  // Returns an unsigned transaction for the frontend to sign
  app.post<{ Body: CreateDcaBody }>(
    "/v1/dca/create",
    async (req, reply) => {
      const {
        user,
        inputMint,
        outputMint,
        inAmount,
        numberOfOrders,
        interval,
        minPrice,
        maxPrice,
        startAt,
      } = req.body;

      if (!user || !inputMint || !outputMint || !inAmount || !numberOfOrders || !interval) {
        return reply.status(400).send({
          error: "user, inputMint, outputMint, inAmount, numberOfOrders, and interval are required",
        });
      }

      try {
        // Validate minimum $50 per cycle (Jupiter requirement)
        const numericAmount = typeof inAmount === "string" ? Number(inAmount) : inAmount;
        const perCycleRaw = numericAmount / numberOfOrders;

        try {
          const { data: priceData } = await axios.get(PRICE_V3_URL, {
            params: { ids: inputMint },
            headers: { "x-api-key": getApiKey() },
          });
          const priceEntry = priceData?.[inputMint];
          if (priceEntry?.usdPrice) {
            const decimals = priceEntry.decimals ?? 9;
            const perCycleUsd = (perCycleRaw / 10 ** decimals) * priceEntry.usdPrice;
            if (perCycleUsd < MIN_ORDER_USD) {
              return reply.status(400).send({
                error: `Each DCA cycle is worth ~$${perCycleUsd.toFixed(2)}, but Jupiter requires a minimum of $${MIN_ORDER_USD} per cycle. Increase your total amount or reduce numberOfOrders.`,
              });
            }
          }
        } catch {
          log.warn({ inputMint }, "Could not fetch price for DCA validation, skipping check");
        }
        const payload: Record<string, any> = {
          user,
          inputMint,
          outputMint,
          params: {
            time: {
              inAmount: typeof inAmount === "string" ? Number(inAmount) : inAmount,
              numberOfOrders,
              interval,
              minPrice: minPrice ?? null,
              maxPrice: maxPrice ?? null,
              startAt: startAt ?? null,
            },
          },
        };

        const { data } = await axios.post(
          `${RECURRING_BASE_URL}/createOrder`,
          payload,
          { headers: apiHeaders() },
        );

        if (data.error || data.code) {
          return reply.status(data.code ?? 422).send({
            error: data.error ?? "DCA order creation failed",
            details: data,
          });
        }

        log.info({ requestId: data.requestId, user }, "DCA order transaction crafted");

        return {
          transaction: data.transaction,
          requestId: data.requestId,
          inputMint,
          outputMint,
          inAmount,
          numberOfOrders,
          interval,
          perCycleAmount: (BigInt(inAmount) / BigInt(numberOfOrders)).toString(),
          totalDurationSeconds: numberOfOrders * interval,
        };
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to create DCA order",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Execute (send signed tx) ────────────────────────────────────────
  app.post<{ Body: SendSignedTxBody }>(
    "/v1/dca/execute",
    async (req, reply) => {
      const { signedTransaction, requestId } = req.body;

      if (!signedTransaction) {
        return reply.status(400).send({ error: "signedTransaction is required" });
      }

      try {
        // Try Jupiter's execute endpoint first
        const { data } = await axios.post(
          `${RECURRING_BASE_URL}/execute`,
          { signedTransaction, requestId },
          { headers: apiHeaders() },
        );

        log.info({ requestId }, "DCA transaction executed");
        return data;
      } catch (err: any) {
        // Fallback: send via Helius Sender (same as swap)
        const heliusApiKey = process.env.HELIUS_API_KEY;
        const senderEndpoint = process.env.SENDER_ENDPOINT || "https://sender.helius-rpc.com/fast";

        try {
          const url = heliusApiKey
            ? `${senderEndpoint}?api-key=${heliusApiKey}`
            : senderEndpoint;

          const { data } = await axios.post(url, {
            jsonrpc: "2.0",
            id: "dca-send",
            method: "sendTransaction",
            params: [
              signedTransaction,
              { skipPreflight: true, maxRetries: 2, encoding: "base64" },
            ],
          });

          if (data.error) {
            return reply.status(502).send({
              error: "Transaction submission failed",
              details: data.error,
            });
          }

          log.info({ sig: data.result }, "DCA tx sent via Helius Sender");
          return { signature: data.result, method: "helius_sender" };
        } catch (fallbackErr: any) {
          return reply.status(502).send({
            error: "Failed to execute DCA transaction",
            details: fallbackErr.response?.data ?? fallbackErr.message,
          });
        }
      }
    },
  );

  // ── Cancel DCA Order ────────────────────────────────────────────────
  app.post<{ Body: CancelDcaBody }>(
    "/v1/dca/cancel",
    async (req, reply) => {
      const { order, user, recurringType = "time" } = req.body;

      if (!order || !user) {
        return reply.status(400).send({ error: "order and user are required" });
      }

      try {
        const { data } = await axios.post(
          `${RECURRING_BASE_URL}/cancelOrder`,
          { order, user, recurringType },
          { headers: apiHeaders() },
        );

        if (data.error || data.code) {
          return reply.status(data.code ?? 422).send({
            error: data.error ?? "Cancel failed",
            details: data,
          });
        }

        log.info({ order, user }, "DCA cancel transaction crafted");

        return {
          transaction: data.transaction,
          requestId: data.requestId,
          order,
        };
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to cancel DCA order",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Get DCA Orders ──────────────────────────────────────────────────
  app.get<{ Querystring: GetOrdersQuery }>(
    "/v1/dca/orders",
    async (req, reply) => {
      const {
        user,
        orderStatus = "active",
        recurringType = "time",
        page,
        inputMint,
        outputMint,
        includeFailedTx,
      } = req.query;

      if (!user) {
        return reply.status(400).send({ error: "user query param is required" });
      }

      try {
        const params: Record<string, any> = {
          user,
          orderStatus,
          recurringType,
        };
        if (page) params.page = page;
        if (inputMint) params.inputMint = inputMint;
        if (outputMint) params.outputMint = outputMint;
        if (includeFailedTx) params.includeFailedTx = includeFailedTx;

        const { data } = await axios.get(
          `${RECURRING_BASE_URL}/getRecurringOrders`,
          { headers: apiHeaders(), params },
        );

        return data;
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to fetch DCA orders",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );
}
