import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("lend");

const LEND_BASE_URL = "https://api.jup.ag/lend/v1";

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

function getSenderEndpoint(): string {
  return process.env.SENDER_ENDPOINT || "https://sender.helius-rpc.com/fast";
}

// ── Interfaces ──────────────────────────────────────────────────────────

interface EarnActionBody {
  asset: string;
  signer: string;
  amount: string;
}

interface SendSignedTxBody {
  signedTransaction: string;
}

interface PositionsQuery {
  users: string; // comma-separated wallet addresses
}

// ── Routes ──────────────────────────────────────────────────────────────

export async function lendRoutes(app: FastifyInstance) {
  // ── List earning markets (jlTokens with APY) ───────────────────────
  app.get("/v1/lend/tokens", async (_req, reply) => {
    try {
      const { data } = await axios.get(`${LEND_BASE_URL}/earn/tokens`, {
        headers: apiHeaders(),
      });
      return data;
    } catch (err: any) {
      const status = err.response?.status ?? 502;
      return reply.status(status).send({
        error: "Failed to fetch lending tokens",
        details: err.response?.data ?? err.message,
      });
    }
  });

  // ── Get user lending positions ─────────────────────────────────────
  app.get<{ Querystring: PositionsQuery }>(
    "/v1/lend/positions",
    async (req, reply) => {
      const { users } = req.query;
      if (!users) {
        return reply.status(400).send({ error: "users query param is required (comma-separated wallet addresses)" });
      }
      try {
        const { data } = await axios.get(`${LEND_BASE_URL}/earn/positions`, {
          headers: apiHeaders(),
          params: { users },
        });
        return data;
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to fetch lending positions",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Deposit into earn (build unsigned tx) ──────────────────────────
  app.post<{ Body: EarnActionBody }>(
    "/v1/lend/deposit",
    async (req, reply) => {
      const { asset, signer, amount } = req.body;
      if (!asset || !signer || !amount) {
        return reply.status(400).send({ error: "asset, signer, and amount are required" });
      }
      try {
        const { data } = await axios.post(
          `${LEND_BASE_URL}/earn/deposit`,
          { asset, signer, amount },
          { headers: apiHeaders() },
        );

        log.info({ asset, signer, amount }, "Lend deposit transaction crafted");
        return {
          transaction: data.transaction,
          asset,
          signer,
          amount,
          action: "deposit",
        };
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to craft deposit transaction",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Withdraw from earn (build unsigned tx) ─────────────────────────
  app.post<{ Body: EarnActionBody }>(
    "/v1/lend/withdraw",
    async (req, reply) => {
      const { asset, signer, amount } = req.body;
      if (!asset || !signer || !amount) {
        return reply.status(400).send({ error: "asset, signer, and amount are required" });
      }
      try {
        const { data } = await axios.post(
          `${LEND_BASE_URL}/earn/withdraw`,
          { asset, signer, amount },
          { headers: apiHeaders() },
        );

        log.info({ asset, signer, amount }, "Lend withdraw transaction crafted");
        return {
          transaction: data.transaction,
          asset,
          signer,
          amount,
          action: "withdraw",
        };
      } catch (err: any) {
        const status = err.response?.status ?? 502;
        return reply.status(status).send({
          error: "Failed to craft withdraw transaction",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ── Send signed lend tx ────────────────────────────────────────────
  app.post<{ Body: SendSignedTxBody }>(
    "/v1/lend/send",
    async (req, reply) => {
      const { signedTransaction } = req.body;
      if (!signedTransaction) {
        return reply.status(400).send({ error: "signedTransaction is required" });
      }

      const heliusApiKey = process.env.HELIUS_API_KEY;
      const senderEndpoint = getSenderEndpoint();

      try {
        const url = heliusApiKey
          ? `${senderEndpoint}?api-key=${heliusApiKey}`
          : senderEndpoint;

        const { data } = await axios.post(url, {
          jsonrpc: "2.0",
          id: "lend-send",
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

        log.info({ sig: data.result }, "Lend tx sent via Helius Sender");
        return { signature: data.result, method: "helius_sender" };
      } catch (err: any) {
        return reply.status(502).send({
          error: "Failed to send lend transaction",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );
}
