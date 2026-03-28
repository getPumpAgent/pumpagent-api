import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("picks");

interface CacheEntry {
  data: any;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30_000;

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

async function fetchUpstream(path: string, params?: Record<string, any>): Promise<any> {
  const baseUrl = process.env.LORE_API_URL;
  const apiKey = process.env.LORE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Upstream not configured");

  const { data } = await axios.get(`${baseUrl}${path}`, {
    params,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 8000,
  });
  return data;
}

// Normalize a token from feature-boxes into our standard shape
function normalizeFeatureBox(token: any, tag: string): any {
  if (!token || !token.address) return null;
  const na = token.narrativeAnalysis?.comprehensive;
  const fw = token.narrativeAnalysis?.framework;
  return {
    mint: token.address,
    name: na?.threeWords?.join(" ") ?? token.address.slice(0, 8),
    symbol: na?.threeWords?.[0] ?? null,
    summary: na?.shortSummary ?? null,
    virality: fw?.memeticAnalysis?.virality ?? null,
    spreadFactors: fw?.memeticAnalysis?.spreadFactors ?? [],
    tag,
  };
}

// Normalize kolscan entries
function normalizeKol(entry: any): any {
  const creationTime = entry.creationTime;
  const age = creationTime ? Math.floor((Date.now() - creationTime) / 1000) : null;
  return {
    mint: entry.coinMint,
    name: entry.name,
    symbol: entry.ticker,
    image: entry.imageUrl ?? null,
    marketCap: entry.marketCap ?? null,
    volume: entry.volume ?? null,
    kolCount: entry.numKolsTraded ?? 0,
    holders: entry.numHolders ?? 0,
    snipers: entry.sniperCount ?? 0,
    bondingProgress: entry.bondingCurveProgress ?? null,
    age,
  };
}

// Normalize graduation entries
function normalizeGrad(entry: any): any {
  return {
    mint: entry.address,
    name: entry.name,
    symbol: entry.symbol,
    status: entry.status,
    summary: entry.narrativeAnalysis?.comprehensive?.shortSummary ?? null,
  };
}

// Normalize gains/hot entries
function normalizeGains(entry: any): any {
  return {
    mint: entry.tokenAddress,
    name: entry.tokenName,
    symbol: entry.tokenSymbol,
    marketCap: entry.currentMarketCap ?? null,
    changePercent: entry.currentChangePercent ?? null,
    multiplier: entry.currentMultiplier ?? null,
    featured: entry.isCurrentlyFeatured ?? false,
    featureType: entry.currentFeatureType ?? null,
  };
}

async function enrichWithMarketData(token: any): Promise<void> {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${token.mint}`);
    const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
    if (pairs.length) {
      const top = pairs[0];
      token.price = top.priceUsd ? parseFloat(top.priceUsd) : null;
      token.marketCap = top.marketCap ?? top.fdv ?? null;
      token.volume24h = top.volume?.h24 ?? null;
      token.liquidity = top.liquidity?.usd ?? null;
      token.priceChange24h = top.priceChange?.h24 ?? null;
    }
  } catch {
    // DexScreener may not have data for very new tokens
  }
}

async function enrichWithImages(tokens: any[]): Promise<any[]> {
  const needImages = tokens.filter((t) => !t.image && t.mint);
  if (!needImages.length) return tokens;

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return tokens;

  try {
    const mints = needImages.map((t) => t.mint).slice(0, 30);
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "picks-images",
      method: "getAssetBatch",
      params: { ids: mints },
    });

    const assetMap = new Map<string, any>();
    for (const item of data.result ?? []) {
      assetMap.set(item.id, item);
    }

    for (const t of tokens) {
      if (!t.image) {
        const asset = assetMap.get(t.mint);
        const img = asset?.content?.links?.image ?? null;
        if (img && img.startsWith("http")) t.image = img;
      }
    }
  } catch (err: any) {
    log.warn({ err: err.message }, "Failed to enrich picks with images");
  }

  return tokens;
}

export async function picksRoutes(app: FastifyInstance) {
  app.get("/v1/picks", async (req, reply) => {
    const { type } = req.query as { type?: string };

    if (!type) {
      return reply.status(400).send({ error: "type parameter required (momentum|degen|smartmoney|graduating|hot)" });
    }

    const cacheKey = `picks:${type}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
      let result: any;

      switch (type) {
        case "momentum": {
          const boxes = await fetchUpstream("/api/feature-boxes/current");
          const token = boxes?.Fastest;
          const item = normalizeFeatureBox(token, "momentum");
          if (item) await enrichWithMarketData(item);
          result = { type: "momentum", tokens: item ? [item] : [] };
          break;
        }

        case "degen": {
          const boxes = await fetchUpstream("/api/feature-boxes/current");
          const token = boxes?.Gamble;
          const item = normalizeFeatureBox(token, "degen");
          if (item) await enrichWithMarketData(item);
          result = { type: "degen", tokens: item ? [item] : [] };
          break;
        }

        case "smartmoney": {
          const data = await fetchUpstream("/api/market/kolscan");
          const tokens = Array.isArray(data) ? data.slice(0, 20).map(normalizeKol) : [];
          result = { type: "smartmoney", tokens };
          break;
        }

        case "graduating": {
          const data = await fetchUpstream("/api/graduation", { status: "active", limit: 20 });
          const tokens = (data?.data?.tokens ?? []).map(normalizeGrad);
          result = { type: "graduating", tokens };
          break;
        }

        case "hot": {
          const data = await fetchUpstream("/api/feature-snapshots/gains");
          const tokens = (data?.data ?? []).slice(0, 20).map(normalizeGains);
          result = { type: "hot", tokens };
          break;
        }

        default:
          return reply.status(400).send({ error: `Unknown type: ${type}` });
      }

      result.tokens = await enrichWithImages(result.tokens);
      setCache(cacheKey, result);
      return result;
    } catch (err: any) {
      log.error({ err: err.message, type }, "Failed to fetch picks");
      return reply.status(502).send({ error: "Failed to fetch data", message: err.message });
    }
  });
}
