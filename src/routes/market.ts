import { FastifyInstance } from "fastify";
import { getMarketSentiment, getMarketScoreModifier } from "../services/marketService.js";
import { getTopSolanaPairs } from "../services/dexscreenerService.js";
import { createLogger } from "../utils/logger.js";
import db from "../db.js";

const log = createLogger("market-routes");

export async function marketRoutes(app: FastifyInstance) {
  app.get("/v1/market/stats", async (_req, reply) => {
    try {
      const [sentiment, pairs] = await Promise.all([
        getMarketSentiment(),
        getTopSolanaPairs(),
      ]);

      const topGaining = pairs
        .filter((p: any) => p.priceChange?.h24 != null)
        .sort((a: any, b: any) => (b.priceChange?.h24 ?? 0) - (a.priceChange?.h24 ?? 0))
        .slice(0, 10)
        .map((p: any) => ({
          tokenAddress: p.baseToken?.address,
          name: p.baseToken?.name,
          symbol: p.baseToken?.symbol,
          priceChange24h: p.priceChange?.h24,
          volume24h: p.volume?.h24,
        }));

      const mostActive = pairs
        .filter((p: any) => p.volume?.h24 != null)
        .sort((a: any, b: any) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
        .slice(0, 10)
        .map((p: any) => ({
          tokenAddress: p.baseToken?.address,
          name: p.baseToken?.name,
          symbol: p.baseToken?.symbol,
          volume24h: p.volume?.h24,
          liquidity: p.liquidity?.usd,
        }));

      return {
        sentiment: sentiment.sentiment,
        modifier: sentiment.modifier,
        confidence: sentiment.confidence,
        topGaining,
        mostActive,
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch market stats", message: err.message });
    }
  });

  // Rugged mints list — lightweight endpoint for client-side filtering
  const ruggedMintsCache = { mints: [] as string[], expiry: 0 };
  app.get("/v1/rugged/mints", async (_req, reply) => {
    try {
      if (Date.now() < ruggedMintsCache.expiry) return { mints: ruggedMintsCache.mints };
      const rows = db.prepare("SELECT token_mint FROM rugged_pools WHERE token_mint IS NOT NULL").all() as any[];
      ruggedMintsCache.mints = rows.map((r: any) => r.token_mint);
      ruggedMintsCache.expiry = Date.now() + 60_000; // cache 1 min
      return { mints: ruggedMintsCache.mints };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch rugged mints", message: err.message });
    }
  });

  // Rugwatch — confirmed rugs
  app.get("/v1/rugwatch", async (_req, reply) => {
    try {
      const rugs = db.prepare(
        "SELECT token_name, token_mint, pool_address, estimated_stolen_sol, liquidity_before, liquidity_after, rug_time, creator_wallet FROM rugged_pools ORDER BY rug_time DESC LIMIT 50"
      ).all() as any[];
      const totals = db.prepare(
        "SELECT COUNT(*) as count, COALESCE(SUM(estimated_stolen_sol), 0) as totalSol FROM rugged_pools"
      ).get() as any;
      return {
        rugs: rugs.map((r: any) => ({
          tokenName: r.token_name,
          tokenMint: r.token_mint,
          poolAddress: r.pool_address,
          solStolen: r.estimated_stolen_sol,
          usdStolen: (r.estimated_stolen_sol ?? 0) * 150,
          rugTime: r.rug_time,
          creatorWallet: r.creator_wallet,
        })),
        totalRugged: totals?.count ?? 0,
        totalSolStolen: totals?.totalSol ?? 0,
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch rug data", message: err.message });
    }
  });
}
