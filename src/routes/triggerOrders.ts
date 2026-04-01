import { FastifyInstance } from "fastify";
import { createLogger } from "../utils/logger.js";
import * as trigger from "../services/jupiterTriggerService.js";

const log = createLogger("trigger-orders");

// ── Authentication ──────────────────────────────────────────────────────

interface ChallengeBody {
  walletPubkey: string;
  type?: "message" | "transaction";
}

interface VerifyBody {
  walletPubkey: string;
  type: "message" | "transaction";
  signature?: string;
  signedTransaction?: string;
}

interface VerifyTokenBody {
  walletPubkey: string;
  jwt: string;
}

// ── Vault ───────────────────────────────────────────────────────────────

interface VaultQuery {
  jwt: string;
}

// ── Deposit ─────────────────────────────────────────────────────────────

interface DepositBody {
  jwt: string;
  inputMint: string;
  outputMint: string;
  userAddress: string;
  amount: string;
}

// ── Orders ──────────────────────────────────────────────────────────────

interface CreateOrderBody {
  jwt: string;
  orderType: "single" | "oco" | "otoco";
  depositRequestId: string;
  depositSignedTx: string;
  userPubkey: string;
  inputMint: string;
  inputAmount: string;
  outputMint: string;
  triggerMint: string;
  expiresAt: number;
  // Single
  triggerCondition?: "above" | "below";
  triggerPriceUsd?: number;
  slippageBps?: number;
  // OCO
  tpPriceUsd?: number;
  slPriceUsd?: number;
  tpSlippageBps?: number;
  slSlippageBps?: number;
  // OTOCO (parent + child TP/SL)
}

interface UpdateOrderBody {
  jwt: string;
  orderType: "single" | "oco" | "otoco";
  triggerPriceUsd?: number;
  slippageBps?: number;
  tpPriceUsd?: number;
  slPriceUsd?: number;
  tpSlippageBps?: number;
  slSlippageBps?: number;
}

interface CancelOrderBody {
  jwt: string;
}

interface ConfirmCancelBody {
  jwt: string;
  signedTransaction: string;
  cancelRequestId: string;
}

interface OrderHistoryQuery {
  jwt: string;
  state?: "active" | "past";
  mint?: string;
  limit?: string;
  offset?: string;
  sort?: "updated_at" | "created_at" | "expires_at";
  dir?: "asc" | "desc";
}

interface OrderIdParams {
  orderId: string;
}

// ── Async task store (in-memory) ────────────────────────────────────────

interface PendingTask {
  status: "pending" | "success" | "error";
  result?: any;
  error?: any;
  createdAt: number;
}

const pendingTasks = new Map<string, PendingTask>();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, entry] of pendingTasks) {
    if (entry.createdAt < cutoff) pendingTasks.delete(id);
  }
}, 5 * 60 * 1000);

let taskCounter = 0;
function nextTaskId(prefix: string) {
  return prefix + "-" + Date.now() + "-" + (++taskCounter);
}

// ── Helper ──────────────────────────────────────────────────────────────

function extractJwt(req: any): string {
  // Accept JWT from body, query, or Authorization header
  const fromBody = req.body?.jwt;
  const fromQuery = (req.query as any)?.jwt;
  const fromHeader = req.headers.authorization?.replace("Bearer ", "");
  const jwt = fromBody || fromQuery || fromHeader;
  if (!jwt) throw new Error("JWT required — authenticate first via /v1/trigger/auth/challenge");
  return jwt;
}

// ── Routes ──────────────────────────────────────────────────────────────

export async function triggerOrderRoutes(app: FastifyInstance) {
  // ── Auth: Request Challenge ─────────────────────────────────────────
  app.post<{ Body: ChallengeBody }>(
    "/v1/trigger/auth/challenge",
    async (req, reply) => {
      const { walletPubkey, type = "message" } = req.body;
      if (!walletPubkey) {
        return reply.status(400).send({ error: "walletPubkey is required" });
      }
      try {
        const data = await trigger.requestChallenge(walletPubkey, type);
        return data;
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to request challenge",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Auth: Verify Signature → JWT ────────────────────────────────────
  app.post<{ Body: VerifyBody }>(
    "/v1/trigger/auth/verify",
    async (req, reply) => {
      const { walletPubkey, type, signature, signedTransaction } = req.body;
      if (!walletPubkey || !type) {
        return reply.status(400).send({ error: "walletPubkey and type are required" });
      }
      try {
        const data = await trigger.verifyChallenge(walletPubkey, type, {
          signature,
          signedTransaction,
        });
        return data; // { token }
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Challenge verification failed",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Auth: Verify Token (optional check) ─────────────────────────────
  app.post<{ Body: VerifyTokenBody }>(
    "/v1/trigger/auth/verify-token",
    async (req, reply) => {
      const { walletPubkey, jwt } = req.body;
      if (!walletPubkey || !jwt) {
        return reply.status(400).send({ error: "walletPubkey and jwt are required" });
      }
      try {
        const data = await trigger.verifyToken(walletPubkey, jwt);
        return { valid: true, ...data };
      } catch (err: any) {
        if (err.response?.status === 401) {
          return { valid: false, reason: "expired_or_invalid" };
        }
        return reply.status(502).send({
          error: "Token verification failed",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Vault: Get or Register (async) ──────────────────────────────────
  app.get<{ Querystring: VaultQuery }>(
    "/v1/trigger/vault",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const taskId = nextTaskId("vault");
        pendingTasks.set(taskId, { status: "pending", createdAt: Date.now() });

        (async () => {
          try {
            let data: any;
            try {
              data = await trigger.getVault(jwt);
            } catch (err: any) {
              if (err.response?.status === 404) {
                data = await trigger.registerVault(jwt);
              } else {
                throw err;
              }
            }
            pendingTasks.set(taskId, { status: "success", result: data, createdAt: Date.now() });
          } catch (err: any) {
            pendingTasks.set(taskId, { status: "error", error: err.response?.data ?? err.message, createdAt: Date.now() });
          }
        })();

        return { taskId, status: "pending" };
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to get vault",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Deposit: Craft unsigned deposit tx (async) ──────────────────────
  app.post<{ Body: DepositBody }>(
    "/v1/trigger/deposit",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const { inputMint, outputMint, userAddress, amount } = req.body;
        if (!inputMint || !outputMint || !userAddress || !amount) {
          return reply.status(400).send({
            error: "inputMint, outputMint, userAddress, and amount are required",
          });
        }

        const taskId = nextTaskId("dep");
        pendingTasks.set(taskId, { status: "pending", createdAt: Date.now() });

        trigger.craftDeposit(jwt, { inputMint, outputMint, userAddress, amount }).then((data) => {
          pendingTasks.set(taskId, { status: "success", result: data, createdAt: Date.now() });
        }).catch((err) => {
          pendingTasks.set(taskId, { status: "error", error: err.response?.data ?? err.message, createdAt: Date.now() });
        });

        return { taskId, status: "pending" };
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to craft deposit",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Create Order (single / OCO / OTOCO) — async fire-and-forget ──────
  // Jupiter's order creation can take 30-60s (CloudFront times out at ~30s).
  // We submit to Jupiter in the background and return a pendingId immediately.
  // Frontend polls GET /v1/trigger/order/status/:pendingId for the result.
  app.post<{ Body: CreateOrderBody }>(
    "/v1/trigger/order",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const {
          orderType,
          depositRequestId,
          depositSignedTx,
          userPubkey,
          inputMint,
          inputAmount,
          outputMint,
          triggerMint,
          expiresAt,
          triggerCondition,
          triggerPriceUsd,
          slippageBps,
          tpPriceUsd,
          slPriceUsd,
          tpSlippageBps,
          slSlippageBps,
        } = req.body;

        if (!orderType || !depositRequestId || !depositSignedTx || !userPubkey) {
          return reply.status(400).send({
            error: "orderType, depositRequestId, depositSignedTx, and userPubkey are required",
          });
        }

        const payload: Record<string, any> = {
          orderType, depositRequestId, depositSignedTx, userPubkey,
          inputMint, inputAmount, outputMint, triggerMint, expiresAt,
        };

        if (orderType === "single") {
          payload.triggerCondition = triggerCondition;
          payload.triggerPriceUsd = triggerPriceUsd;
          if (slippageBps !== undefined) payload.slippageBps = slippageBps;
        } else if (orderType === "oco") {
          payload.tpPriceUsd = tpPriceUsd;
          payload.slPriceUsd = slPriceUsd;
          if (tpSlippageBps !== undefined) payload.tpSlippageBps = tpSlippageBps;
          if (slSlippageBps !== undefined) payload.slSlippageBps = slSlippageBps;
        } else if (orderType === "otoco") {
          payload.triggerCondition = triggerCondition;
          payload.triggerPriceUsd = triggerPriceUsd;
          payload.tpPriceUsd = tpPriceUsd;
          payload.slPriceUsd = slPriceUsd;
          if (slippageBps !== undefined) payload.slippageBps = slippageBps;
          if (tpSlippageBps !== undefined) payload.tpSlippageBps = tpSlippageBps;
          if (slSlippageBps !== undefined) payload.slSlippageBps = slSlippageBps;
        }

        const taskId = nextTaskId("ord");
        pendingTasks.set(taskId, { status: "pending", createdAt: Date.now() });

        trigger.createOrder(jwt, payload).then((data) => {
          pendingTasks.set(taskId, { status: "success", result: data, createdAt: Date.now() });
          log.info({ taskId, orderId: data?.id }, "Trigger order created (async)");
        }).catch((err) => {
          pendingTasks.set(taskId, { status: "error", error: err.response?.data ?? err.message, createdAt: Date.now() });
          log.error({ taskId, error: err.response?.data ?? err.message }, "Trigger order failed (async)");
        });

        return { taskId, status: "pending" };
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to create trigger order",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Poll task status (deposit or order) ─────────────────────────────
  app.get<{ Params: { taskId: string } }>(
    "/v1/trigger/task/:taskId",
    async (req, reply) => {
      const entry = pendingTasks.get(req.params.taskId);
      if (!entry) {
        return reply.status(404).send({ error: "Unknown taskId" });
      }
      if (entry.status === "pending") {
        return { status: "pending" };
      }
      if (entry.status === "success") {
        return { status: "success", ...entry.result };
      }
      return reply.status(422).send({ status: "error", error: entry.error });
    },
  );

  // ── Update Order ────────────────────────────────────────────────────
  app.patch<{ Params: OrderIdParams; Body: UpdateOrderBody }>(
    "/v1/trigger/order/:orderId",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const { orderId } = req.params;
        const { orderType, triggerPriceUsd, slippageBps, tpPriceUsd, slPriceUsd, tpSlippageBps, slSlippageBps } = req.body;

        const updates: Record<string, any> = { orderType };
        if (triggerPriceUsd !== undefined) updates.triggerPriceUsd = triggerPriceUsd;
        if (slippageBps !== undefined) updates.slippageBps = slippageBps;
        if (tpPriceUsd !== undefined) updates.tpPriceUsd = tpPriceUsd;
        if (slPriceUsd !== undefined) updates.slPriceUsd = slPriceUsd;
        if (tpSlippageBps !== undefined) updates.tpSlippageBps = tpSlippageBps;
        if (slSlippageBps !== undefined) updates.slSlippageBps = slSlippageBps;

        const data = await trigger.updateOrder(jwt, orderId, updates);
        return data;
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to update order",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Cancel Order (Step 1: initiate) ─────────────────────────────────
  app.post<{ Params: OrderIdParams; Body: CancelOrderBody }>(
    "/v1/trigger/order/:orderId/cancel",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const { orderId } = req.params;
        const data = await trigger.cancelOrder(jwt, orderId);
        return data; // { id, transaction, requestId }
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to initiate cancel",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Cancel Order (Step 2: confirm with signed withdrawal tx) ────────
  app.post<{ Params: OrderIdParams; Body: ConfirmCancelBody }>(
    "/v1/trigger/order/:orderId/confirm-cancel",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const { orderId } = req.params;
        const { signedTransaction, cancelRequestId } = req.body;

        if (!signedTransaction || !cancelRequestId) {
          return reply.status(400).send({
            error: "signedTransaction and cancelRequestId are required",
          });
        }

        const data = await trigger.confirmCancel(jwt, orderId, signedTransaction, cancelRequestId);
        return data; // { id, txSignature }
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to confirm cancel",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Order History ───────────────────────────────────────────────────
  app.get<{ Querystring: OrderHistoryQuery }>(
    "/v1/trigger/orders",
    async (req, reply) => {
      try {
        const jwt = extractJwt(req);
        const { state, mint, limit, offset, sort, dir } = req.query;

        const params: Record<string, any> = {};
        if (state) params.state = state;
        if (mint) params.mint = mint;
        if (limit) params.limit = parseInt(limit, 10);
        if (offset) params.offset = parseInt(offset, 10);
        if (sort) params.sort = sort;
        if (dir) params.dir = dir;

        const data = await trigger.getOrderHistory(jwt, params);
        return data; // { orders, pagination }
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to fetch order history",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── V1 Create Order (on-chain, no vault/deposit) ─────────────────────
  // User signs and sends the transaction themselves — no depositSignedTx needed.
  // This bypasses Phantom's priority fee injection issue with V2.
  app.post<{ Body: {
    inputMint: string;
    outputMint: string;
    maker: string;
    makingAmount: string;
    takingAmount: string;
    expiredAt?: string;
  } }>(
    "/v1/trigger/v1/create-order",
    async (req, reply) => {
      try {
        const { inputMint, outputMint, maker, makingAmount, takingAmount, expiredAt } = req.body;
        if (!inputMint || !outputMint || !maker || !makingAmount || !takingAmount) {
          return reply.status(400).send({ error: "inputMint, outputMint, maker, makingAmount, takingAmount required" });
        }

        const data = await trigger.createOrderV1({
          inputMint,
          outputMint,
          maker,
          payer: maker,
          makingAmount,
          takingAmount,
          expiredAt,
        });

        return data;
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to create V1 order",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );
}
