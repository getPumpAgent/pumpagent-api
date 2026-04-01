import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("jupiter-data");

const PRICE_V3_URL = "https://api.jup.ag/price/v3";
const TOKENS_V2_URL = "https://api.jup.ag/tokens/v2";
const PORTFOLIO_V1_URL = "https://api.jup.ag/portfolio/v1";

function getApiKey(): string {
  const key = process.env.JUPITER_API_KEY;
  if (!key) throw new Error("JUPITER_API_KEY not configured");
  return key;
}

function apiHeaders() {
  return { "x-api-key": getApiKey() };
}

// ── Routes ──────────────────────────────────────────────────────────────

export async function jupiterDataRoutes(app: FastifyInstance) {
  // ═══════════════════════════════════════════════════════════════════════
  // PRICE API v3
  // ═══════════════════════════════════════════════════════════════════════

  // GET /v1/jupiter/prices?ids=mint1,mint2 (max 50)
  app.get<{ Querystring: { ids: string } }>(
    "/v1/jupiter/prices",
    async (req, reply) => {
      const { ids } = req.query;
      if (!ids) {
        return reply.status(400).send({ error: "ids query param required (comma-separated mints, max 50)" });
      }
      try {
        const { data } = await axios.get(PRICE_V3_URL, {
          params: { ids },
          headers: apiHeaders(),
        });
        return data;
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to fetch prices",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TOKEN API v2
  // ═══════════════════════════════════════════════════════════════════════

  // Search tokens by mint address(es)
  app.get<{ Querystring: { query: string } }>(
    "/v1/jupiter/tokens/search",
    async (req, reply) => {
      const { query } = req.query;
      if (!query) {
        return reply.status(400).send({ error: "query param required" });
      }
      try {
        const { data } = await axios.get(`${TOKENS_V2_URL}/search`, {
          params: { query },
          headers: apiHeaders(),
        });
        return data;
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to search tokens",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // Get verified / LST tagged tokens
  app.get<{ Querystring: { tag: string } }>(
    "/v1/jupiter/tokens/tag",
    async (req, reply) => {
      const { tag } = req.query;
      if (!tag) {
        return reply.status(400).send({ error: "tag param required (verified, lst)" });
      }
      try {
        const { data } = await axios.get(`${TOKENS_V2_URL}/tag`, {
          params: { query: tag },
          headers: apiHeaders(),
        });
        return data;
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to fetch tagged tokens",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // Trending / top tokens by category + interval
  // Categories: toporganicscore, toptraded, toptrending
  // Intervals: 5m, 1h, 6h, 24h
  app.get<{ Params: { category: string; interval: string } }>(
    "/v1/jupiter/tokens/:category/:interval",
    async (req, reply) => {
      const { category, interval } = req.params;
      const validCategories = ["toporganicscore", "toptraded", "toptrending"];
      const validIntervals = ["5m", "1h", "6h", "24h"];

      if (!validCategories.includes(category)) {
        return reply.status(400).send({
          error: `Invalid category. Use: ${validCategories.join(", ")}`,
        });
      }
      if (!validIntervals.includes(interval)) {
        return reply.status(400).send({
          error: `Invalid interval. Use: ${validIntervals.join(", ")}`,
        });
      }

      try {
        const { data } = await axios.get(`${TOKENS_V2_URL}/${category}/${interval}`, {
          headers: apiHeaders(),
        });
        return data;
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to fetch token rankings",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // Recently created tokens
  app.get("/v1/jupiter/tokens/recent", async (_req, reply) => {
    try {
      const { data } = await axios.get(`${TOKENS_V2_URL}/recent`, {
        headers: apiHeaders(),
      });
      return data;
    } catch (err: any) {
      return reply.status(err.response?.status ?? 502).send({
        error: "Failed to fetch recent tokens",
        details: err.response?.data ?? err.message,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PORTFOLIO API v1 (Beta)
  // ═══════════════════════════════════════════════════════════════════════

  // All DeFi positions for a wallet
  app.get<{ Params: { wallet: string }; Querystring: { platforms?: string } }>(
    "/v1/jupiter/portfolio/:wallet",
    async (req, reply) => {
      const { wallet } = req.params;
      const { platforms } = req.query;

      try {
        const params: Record<string, string> = {};
        if (platforms) params.platforms = platforms;

        const { data } = await axios.get(`${PORTFOLIO_V1_URL}/positions/${wallet}`, {
          headers: apiHeaders(),
          params,
        });
        return data;
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to fetch portfolio positions",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );

  // Staked JUP positions
  app.get<{ Params: { wallet: string } }>(
    "/v1/jupiter/portfolio/:wallet/staked-jup",
    async (req, reply) => {
      const { wallet } = req.params;
      try {
        const { data } = await axios.get(`${PORTFOLIO_V1_URL}/staked-jup/${wallet}`, {
          headers: apiHeaders(),
        });
        return data;
      } catch (err: any) {
        return reply.status(err.response?.status ?? 502).send({
          error: "Failed to fetch staked JUP",
          details: err.response?.data ?? err.message,
        });
      }
    },
  );
}
