import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("narratives");

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "by", "is", "it",
  "and", "or", "not", "no", "my", "me", "i", "we", "you", "he", "she",
  "token", "coin", "sol", "solana", "pump", "fun", "test", "new",
]);

export async function narrativesRoutes(app: FastifyInstance) {
  app.get("/v1/narratives/trending", async (_req, reply) => {
    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "narratives",
        method: "getAssetsByAuthority",
        params: {
          authorityAddress: PUMPFUN_PROGRAM,
          page: 1,
          limit: 100,
          sortBy: { sortBy: "created", sortDirection: "desc" },
          displayOptions: { showFungible: true },
        },
      });

      const items = data.result?.items ?? [];
      const wordCount = new Map<string, number>();

      for (const item of items) {
        const name = (item.content?.metadata?.name ?? "").toLowerCase();
        const words = name
          .replace(/[^a-z0-9\s]/g, "")
          .split(/\s+/)
          .filter((w: string) => w.length > 2 && !STOP_WORDS.has(w));

        for (const word of words) {
          wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
        }
      }

      const narratives = [...wordCount.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ narrative: word, count }));

      return { narratives, tokensSampled: items.length };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to analyze narratives", message: err.message });
    }
  });
}
