import { FastifyInstance } from "fastify";
import axios from "axios";
import * as dex from "../services/dexscreenerService.js";
import { scoreTokenRisk } from "../services/riskService.js";
import { getKolSignalStrength } from "../services/kolService.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tokens");
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export async function tokenRoutes(app: FastifyInstance) {
  // Existing: newest tokens
  app.get("/v1/tokens/new", async (_req, reply) => {
    const rpcUrl = process.env.HELIUS_RPC_URL;
    const apiKey = process.env.HELIUS_API_KEY;

    if (!rpcUrl || !apiKey) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

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
          displayOptions: { showFungible: true },
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

  // Trending: DexScreener top Solana pairs + PumpFun
  app.get("/v1/tokens/trending", async (_req, reply) => {
    try {
      const pairs = await dex.getTopSolanaPairs();
      return {
        pairs: pairs.slice(0, 20).map((p: any) => ({
          tokenAddress: p.baseToken?.address,
          name: p.baseToken?.name,
          symbol: p.baseToken?.symbol,
          price: p.priceUsd,
          volume24h: p.volume?.h24,
          priceChange24h: p.priceChange?.h24,
          liquidity: p.liquidity?.usd,
          pairAddress: p.pairAddress,
        })),
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch trending", message: err.message });
    }
  });

  // Graduating: tokens near 100% bonding curve
  app.get("/v1/tokens/graduating", async (_req, reply) => {
    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "pump-graduating",
        method: "getAssetsByAuthority",
        params: {
          authorityAddress: PUMPFUN_PROGRAM,
          page: 1,
          limit: 50,
          sortBy: { sortBy: "created", sortDirection: "desc" },
          displayOptions: { showFungible: true },
        },
      });

      const items = data.result?.items ?? [];
      const enriched = await Promise.all(
        items.slice(0, 10).map(async (item: any) => {
          const mint = item.id;
          const dexData = await dex.enrichTokenData(mint).catch(() => null);
          return {
            mint,
            name: item.content?.metadata?.name ?? null,
            symbol: item.content?.metadata?.symbol ?? null,
            image: item.content?.links?.image ?? null,
            createdAt: item.created_at ?? null,
            price: dexData?.price ?? null,
            volume24h: dexData?.volume24h ?? null,
            liquidity: dexData?.liquidity ?? null,
            fdv: dexData?.fdv ?? null,
          };
        })
      );

      return { tokens: enriched };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch graduating tokens", message: err.message });
    }
  });

  // Boosted tokens
  app.get("/v1/tokens/boosted", async (_req, reply) => {
    try {
      const boosted = await dex.getBoostedTokens();
      return { tokens: boosted };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch boosted tokens", message: err.message });
    }
  });

  // Search
  app.get("/v1/tokens/search", async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q) {
      return reply.status(400).send({ error: "Query parameter 'q' is required" });
    }

    try {
      const results = await dex.searchTokens(q);
      return results;
    } catch (err: any) {
      return reply.status(502).send({ error: "Search failed", message: err.message });
    }
  });

  // Token detail
  app.get("/v1/tokens/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const rpcUrl = process.env.HELIUS_RPC_URL;

    try {
      // Fetch metadata, dex data, risk, and KOL signal in parallel
      const [asset, dexData, risk, kolSignal] = await Promise.all([
        rpcUrl
          ? axios
              .post(rpcUrl, {
                jsonrpc: "2.0",
                id: "token-detail",
                method: "getAsset",
                params: { id: address },
              })
              .then((r) => r.data.result)
              .catch(() => null)
          : Promise.resolve(null),
        dex.enrichTokenData(address),
        scoreTokenRisk(address),
        Promise.resolve(getKolSignalStrength(address)),
      ]);

      return {
        mint: address,
        name: asset?.content?.metadata?.name ?? null,
        symbol: asset?.content?.metadata?.symbol ?? null,
        image: asset?.content?.links?.image ?? null,
        uri: asset?.content?.json_uri ?? null,
        createdAt: asset?.created_at ?? null,
        price: dexData.price,
        volume24h: dexData.volume24h,
        liquidity: dexData.liquidity,
        priceChange24h: dexData.priceChange24h,
        fdv: dexData.fdv,
        risk,
        kolSignal,
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch token detail", message: err.message });
    }
  });

  // Risk score
  app.get("/v1/tokens/:address/risk", async (req, reply) => {
    const { address } = req.params as { address: string };
    try {
      const risk = await scoreTokenRisk(address);
      return { mint: address, risk };
    } catch (err: any) {
      return reply.status(502).send({ error: "Risk scoring failed", message: err.message });
    }
  });

  // OHLCV candles
  app.get("/v1/tokens/:address/ohlcv", async (req, reply) => {
    const { address } = req.params as { address: string };
    const { interval } = req.query as { interval?: string };
    const validIntervals = ["1m", "5m", "1h", "4h", "1d"];
    const iv = validIntervals.includes(interval ?? "") ? interval! : "1h";

    try {
      const candles = await dex.getOhlcv(address, iv);
      return { mint: address, interval: iv, candles };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch OHLCV", message: err.message });
    }
  });

  // Holders
  app.get("/v1/tokens/:address/holders", async (req, reply) => {
    const { address } = req.params as { address: string };
    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenLargestAccounts",
        params: [address],
      });

      const holders = data.result?.value ?? [];
      const amounts = holders.map((h: any) => parseFloat(h.uiAmount ?? "0"));
      const total = amounts.reduce((s: number, a: number) => s + a, 0);

      return {
        mint: address,
        holders: holders.map((h: any, i: number) => ({
          address: h.address,
          amount: h.uiAmount,
          percentage: total > 0 ? parseFloat(((amounts[i] / total) * 100).toFixed(2)) : 0,
        })),
        concentration: {
          top1: total > 0 ? parseFloat(((amounts[0] / total) * 100).toFixed(2)) : 0,
          top5: total > 0
            ? parseFloat(
                ((amounts.slice(0, 5).reduce((s: number, a: number) => s + a, 0) / total) * 100).toFixed(2)
              )
            : 0,
          top10: total > 0
            ? parseFloat(
                ((amounts.slice(0, 10).reduce((s: number, a: number) => s + a, 0) / total) * 100).toFixed(2)
              )
            : 0,
        },
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch holders", message: err.message });
    }
  });

  // Transactions
  app.get("/v1/tokens/:address/txns", async (req, reply) => {
    const { address } = req.params as { address: string };
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const { data } = await axios.get(
        `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=20`
      );

      return {
        mint: address,
        transactions: (data ?? []).map((tx: any) => ({
          signature: tx.signature,
          type: tx.type,
          timestamp: tx.timestamp,
          description: tx.description,
          fee: tx.fee,
        })),
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch transactions", message: err.message });
    }
  });
}
