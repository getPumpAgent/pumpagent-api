import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";
import {
  getMomentumPicks,
  getGraduatingPicks,
  getDegenPicks,
  getSafePicks,
  isConfigured as stConfigured,
} from "../services/solanaTrackerService.js";
import { getCached as hGet, setCache as hSet, TTL as hTTL, checkHeliusLimit } from "../utils/heliusCache.js";

const log = createLogger("picks");

interface CacheEntry {
  data: any;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 120_000; // 2 minutes

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
  // Try DexScreener first (free, no key)
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${token.mint}`, { timeout: 8000 });
    const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
    if (pairs.length) {
      const top = pairs[0];
      token.price = top.priceUsd ? parseFloat(top.priceUsd) : null;
      token.marketCap = top.marketCap ?? top.fdv ?? null;
      token.volume24h = top.volume?.h24 ?? null;
      token.liquidity = top.liquidity?.usd ?? null;
      token.priceChange24h = top.priceChange?.h24 ?? null;
      if (top.baseToken?.name && !token.name) token.name = top.baseToken.name;
      if (top.baseToken?.symbol) token.symbol = top.baseToken.symbol;
      if (top.info?.imageUrl && !token.image) token.image = top.info.imageUrl;
    }
  } catch {}

  // Fallback: Solana Tracker cache
  if (!token.price && token.mint) {
    try {
      const { getTokenInsights } = await import("../services/solanaTrackerService.js");
      const st = await getTokenInsights(token.mint);
      if (st && st.priceUsd > 0) {
        token.price = token.price ?? st.priceUsd;
        token.marketCap = token.marketCap ?? st.marketCapUsd;
        token.volume24h = token.volume24h ?? st.volume_24h;
        token.liquidity = token.liquidity ?? st.liquidityUsd;
        if (st.name && !token.name) token.name = st.name;
        if (st.symbol) token.symbol = st.symbol;
        if (st.image && !token.image) token.image = st.image;
      }
    } catch {}
  }
}

async function enrichWithImages(tokens: any[]): Promise<any[]> {
  const needImages = tokens.filter((t) => !t.image && t.mint);
  if (!needImages.length) return tokens;

  // Check individual asset caches first
  const uncachedMints: string[] = [];
  for (const t of needImages) {
    const hCached = hGet(`getAsset:${t.mint}`);
    if (hCached) {
      const img = hCached?.content?.links?.image ?? null;
      if (img && img.startsWith("http")) t.image = img;
    } else {
      uncachedMints.push(t.mint);
    }
  }

  // Only call Helius for truly uncached mints
  if (!uncachedMints.length) return tokens;
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return tokens;

  try {
    checkHeliusLimit();
    const mints = uncachedMints.slice(0, 20); // limit batch size
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "picks-images",
      method: "getAssetBatch",
      params: { ids: mints },
    });

    for (const item of data.result ?? []) {
      // Cache each asset individually for 24h
      hSet(`getAsset:${item.id}`, item, hTTL.getAssetBatch);
    }

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
        // ── LORE PICKS (primary for Terminal sidebar) ──
        case "momentum": {
          const boxes = await fetchUpstream("/api/feature-boxes/current");
          const token = boxes?.Fastest;
          const item = normalizeFeatureBox(token, "momentum");
          if (item) await enrichWithMarketData(item);
          result = { type: "momentum", tokens: item ? [item] : [], source: "lore" };
          break;
        }

        case "degen": {
          const boxes = await fetchUpstream("/api/feature-boxes/current");
          const dToken = boxes?.Gamble;
          const dItem = normalizeFeatureBox(dToken, "degen");
          if (dItem) await enrichWithMarketData(dItem);
          result = { type: "degen", tokens: dItem ? [dItem] : [], source: "lore" };
          break;
        }

        case "smartmoney": {
          const smData = await fetchUpstream("/api/market/kolscan");
          const smTokens = Array.isArray(smData) ? smData.slice(0, 20).map(normalizeKol) : [];
          result = { type: "smartmoney", tokens: smTokens, source: "lore" };
          break;
        }

        case "graduating": {
          const data = await fetchUpstream("/api/graduation", { status: "active", limit: 20 });
          const gTokens = (data?.data?.tokens ?? []).map(normalizeGrad);
          result = { type: "graduating", tokens: gTokens, source: "lore" };
          break;
        }

        case "hot": {
          const hotData = await fetchUpstream("/api/feature-snapshots/gains");
          const hotTokens = (hotData?.data ?? []).slice(0, 20).map(normalizeGains);
          result = { type: "hot", tokens: hotTokens, source: "lore" };
          break;
        }

        // ── NEW TABS (non-LORE sources) ──
        case "trending": {
          // Solana Tracker volume momentum — new angle, doesn't replace LORE
          if (stConfigured()) {
            try {
              const tokens = await getMomentumPicks();
              result = { type: "trending", tokens, source: "solanatracker" };
              break;
            } catch (e: any) {
              log.warn({ err: e.message }, "Solana Tracker trending failed");
            }
          }
          result = { type: "trending", tokens: [], source: "none" };
          break;
        }

        case "boosted": {
          // DexScreener boosted tokens — free, no key
          try {
            const { data: boostData } = await axios.get(
              "https://api.dexscreener.com/token-boosts/latest/v1",
              { timeout: 8000 }
            );
            const solTokens = (boostData || [])
              .filter((t: any) => t.chainId === "solana")
              .slice(0, 20)
              .map((t: any) => ({
                mint: t.tokenAddress,
                name: t.description || t.tokenAddress?.slice(0, 8),
                symbol: null,
                image: t.icon ?? null,
                boostAmount: t.totalAmount ?? 0,
                url: t.url ?? null,
              }));
            // Enrich with DexScreener market data
            for (const t of solTokens.slice(0, 10)) {
              await enrichWithMarketData(t);
            }
            result = { type: "boosted", tokens: solTokens, source: "dexscreener" };
          } catch (e: any) {
            log.warn({ err: e.message }, "DexScreener boosted failed");
            result = { type: "boosted", tokens: [], source: "none" };
          }
          break;
        }

        default:
          return reply.status(400).send({ error: `Unknown type: ${type}. Valid: momentum|degen|smartmoney|graduating|hot|trending|boosted` });
      }

      // ST enrichment removed — use /v1/tokens/{mint}/scan on-demand instead
      // This saves ~40 ST API calls/minute

      result.tokens = await enrichWithImages(result.tokens);
      // Only cache non-empty results
      if (result.tokens.length > 0) setCache(cacheKey, result);
      return result;
    } catch (err: any) {
      log.error({ err: err.message, type }, "Failed to fetch picks");
      return reply.status(502).send({ error: "Failed to fetch data", message: err.message });
    }
  });
}
