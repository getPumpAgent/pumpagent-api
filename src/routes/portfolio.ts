import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("portfolio");

interface CacheEntry { data: any; expiry: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60_000;

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

async function getTokenPrice(mint: string): Promise<{ priceUsd: number | null; priceChange24h: number | null }> {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { timeout: 5000 });
    const pair = Array.isArray(data) && data.length ? data[0] : null;
    if (!pair) return { priceUsd: null, priceChange24h: null };
    return {
      priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
      priceChange24h: pair.priceChange?.h24 ?? null,
    };
  } catch {
    return { priceUsd: null, priceChange24h: null };
  }
}

export async function portfolioRoutes(app: FastifyInstance) {
  app.get<{ Params: { wallet: string } }>(
    "/v1/portfolio/:wallet",
    async (req, reply) => {
      const { wallet } = req.params;
      const rpcUrl = process.env.HELIUS_RPC_URL;

      if (!rpcUrl) {
        return reply.status(500).send({ error: "HELIUS_RPC_URL not configured" });
      }

      const cached = getCached(`portfolio:${wallet}`);
      if (cached) return cached;

      try {
        const { data } = await axios.post(rpcUrl, {
          jsonrpc: "2.0",
          id: "portfolio",
          method: "getAssetsByOwner",
          params: {
            ownerAddress: wallet,
            displayOptions: {
              showFungible: true,
              showNativeBalance: true,
            },
          },
        });

        if (data.error) {
          return reply.status(502).send({ error: "Helius error", details: data.error });
        }

        const result = data.result ?? {};
        const items = result.items ?? [];
        const nativeBalance = result.nativeBalance;

        // SOL balance
        const solBalance = nativeBalance
          ? (nativeBalance.lamports ?? 0) / 1e9
          : 0;
        const solPrice = nativeBalance?.price_per_sol ?? null;
        const solValueUsd = solPrice ? solBalance * solPrice : null;

        // Filter fungible tokens with balance > 0
        const fungibles = items.filter((item: any) => {
          if (item.interface !== "FungibleToken" && item.interface !== "FungibleAsset") return false;
          const balance = item.token_info?.balance;
          return balance && Number(balance) > 0;
        });

        // Get prices in parallel (batch of 10 max to avoid rate limits)
        const tokenList = fungibles.slice(0, 30).map((item: any) => {
          const info = item.token_info ?? {};
          const decimals = info.decimals ?? 0;
          const rawBalance = Number(info.balance ?? 0);
          const balance = decimals > 0 ? rawBalance / Math.pow(10, decimals) : rawBalance;
          return {
            mint: item.id,
            name: item.content?.metadata?.name ?? null,
            symbol: item.content?.metadata?.symbol ?? null,
            balance,
            decimals,
            isPumpFun: item.id.endsWith("pump"),
          };
        });

        // Fetch prices in batches of 5
        const pricePromises = tokenList.map((t) => getTokenPrice(t.mint));
        const prices = await Promise.all(pricePromises);

        let totalValueUsd = solValueUsd ?? 0;

        const tokens = tokenList.map((t, i) => {
          const { priceUsd, priceChange24h } = prices[i];
          const valueUsd = priceUsd ? t.balance * priceUsd : null;
          if (valueUsd) totalValueUsd += valueUsd;
          return { ...t, priceUsd, valueUsd, priceChange24h };
        });

        // Sort by value descending
        tokens.sort((a: any, b: any) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

        const response = {
          wallet,
          solBalance: Math.round(solBalance * 1e6) / 1e6,
          solValueUsd: solValueUsd ? Math.round(solValueUsd * 100) / 100 : null,
          totalValueUsd: Math.round(totalValueUsd * 100) / 100,
          tokenCount: tokens.length,
          tokens,
        };

        setCache(`portfolio:${wallet}`, response);
        return response;
      } catch (err: any) {
        return reply.status(502).send({ error: "Failed to fetch portfolio", message: err.message });
      }
    },
  );
}
