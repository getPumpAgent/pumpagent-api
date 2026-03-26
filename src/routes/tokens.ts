import { FastifyInstance } from "fastify";
import axios from "axios";

export async function tokenRoutes(app: FastifyInstance) {
  app.get("/v1/tokens/new", async (_req, reply) => {
    const rpcUrl = process.env.HELIUS_RPC_URL;
    const apiKey = process.env.HELIUS_API_KEY;

    if (!rpcUrl || !apiKey) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    // Fetch recent PumpFun token launches via Helius DAS API
    // PumpFun program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
    const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

    try {
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "pump-new-tokens",
        method: "getAssetsByAuthority",
        params: {
          authorityAddress: PUMPFUN_PROGRAM,
          page: 1,
          limit: 20,
          sortBy: { sortBy: "created", sortDirection: "desc" },
          displayOptions: {
            showFungible: true,
          },
        },
      });

      if (data.error) {
        return reply.status(502).send({ error: "Helius RPC error", details: data.error });
      }

      const tokens = (data.result?.items ?? []).map((item: any) => ({
        mint: item.id,
        name: item.content?.metadata?.name ?? null,
        symbol: item.content?.metadata?.symbol ?? null,
        uri: item.content?.json_uri ?? null,
        image: item.content?.links?.image ?? null,
        createdAt: item.created_at ?? null,
      }));

      return { tokens };
    } catch (err: any) {
      return reply.status(502).send({
        error: "Failed to fetch tokens from Helius",
        message: err.message,
      });
    }
  });
}
