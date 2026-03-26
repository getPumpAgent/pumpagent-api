import { FastifyInstance } from "fastify";
import { getMarketSentiment, getMarketScoreModifier } from "../services/marketService.js";
import { getTopSolanaPairs } from "../services/dexscreenerService.js";
import { createLogger } from "../utils/logger.js";

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
}
