import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dexscreener");
const BASE_URL = "https://api.dexscreener.com";

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const cache = new Map<string, CacheEntry<any>>();
const CACHE_TTL = 30_000;

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data as T;
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

async function dexGet<T>(path: string): Promise<T> {
  const { data } = await axios.get<T>(`${BASE_URL}${path}`);
  return data;
}

export async function getTokenPairs(tokenAddress: string): Promise<any> {
  const key = `pairs:${tokenAddress}`;
  const cached = getCached(key);
  if (cached) return cached;

  const data = await dexGet<any>(`/tokens/v1/solana/${tokenAddress}`);
  setCache(key, data);
  return data;
}

export async function searchTokens(query: string): Promise<any> {
  const key = `search:${query}`;
  const cached = getCached(key);
  if (cached) return cached;

  const data = await dexGet<any>(`/latest/dex/search?q=${encodeURIComponent(query)}`);
  const filtered = {
    ...data,
    pairs: (data.pairs ?? []).filter((p: any) => p.chainId === "solana"),
  };
  setCache(key, filtered);
  return filtered;
}

export async function getBoostedTokens(): Promise<any> {
  const key = "boosted:latest";
  const cached = getCached(key);
  if (cached) return cached;

  const data = await dexGet<any>("/token-boosts/latest/v1");
  const filtered = Array.isArray(data)
    ? data.filter((t: any) => t.chainId === "solana")
    : data;
  setCache(key, filtered);
  return filtered;
}

export async function getTopBoostedTokens(): Promise<any> {
  const key = "boosted:top";
  const cached = getCached(key);
  if (cached) return cached;

  const data = await dexGet<any>("/token-boosts/top/v1");
  const filtered = Array.isArray(data)
    ? data.filter((t: any) => t.chainId === "solana")
    : data;
  setCache(key, filtered);
  return filtered;
}

export async function enrichTokenData(tokenAddress: string): Promise<{
  price: number | null;
  volume24h: number | null;
  liquidity: number | null;
  priceChange24h: number | null;
  fdv: number | null;
  pairCreatedAt: number | null;
}> {
  const pairs = await getTokenPairs(tokenAddress);
  const pairList = Array.isArray(pairs) ? pairs : pairs?.pairs ?? [];

  if (!pairList.length) {
    return { price: null, volume24h: null, liquidity: null, priceChange24h: null, fdv: null, pairCreatedAt: null };
  }

  const top = pairList[0];
  return {
    price: top.priceUsd ? parseFloat(top.priceUsd) : null,
    volume24h: top.volume?.h24 ?? null,
    liquidity: top.liquidity?.usd ?? null,
    priceChange24h: top.priceChange?.h24 ?? null,
    fdv: top.fdv ?? null,
    pairCreatedAt: top.pairCreatedAt ?? null,
  };
}

// Separate long-lived cache for pool address lookups (24h — pair addresses don't change)
const poolAddressCache = new Map<string, CacheEntry>();
function getCachedPool(mint: string): string | null {
  const entry = poolAddressCache.get(mint);
  if (entry && Date.now() < entry.expiry) return entry.data;
  poolAddressCache.delete(mint);
  return null;
}
function setCachedPool(mint: string, addr: string): void {
  poolAddressCache.set(mint, { data: addr, expiry: Date.now() + 86_400_000 });
}

export async function getOhlcv(
  tokenAddress: string,
  interval: string = "1h"
): Promise<any[]> {
  const key = `ohlcv:${tokenAddress}:${interval}`;
  const cached = getCached<any[]>(key);
  if (cached) return cached;

  const GECKO = "https://api.geckoterminal.com/api/v2";

  // Step 1: Check pool address cache first (avoids redundant lookups)
  let poolAddress: string | null = getCachedPool(tokenAddress);

  // Step 1a: Try DexScreener first (faster, more reliable for PumpSwap)
  if (!poolAddress) {
    try {
      const { data: dexData } = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`,
        { timeout: 5000 },
      );
      const pairs = Array.isArray(dexData) ? dexData : dexData?.pairs ?? [];
      if (pairs.length) poolAddress = pairs[0].pairAddress;
    } catch {}
  }

  // Step 1b: Fall back to GeckoTerminal token lookup
  if (!poolAddress) {
    try {
      const { data: poolsResp } = await axios.get(
        `${GECKO}/networks/solana/tokens/${tokenAddress}/pools`,
        { params: { page: 1 }, timeout: 5000 },
      );
      const pools = poolsResp?.data ?? [];
      if (pools.length) poolAddress = pools[0].attributes.address;
    } catch {}
  }

  if (!poolAddress) return [];
  setCachedPool(tokenAddress, poolAddress);

  // Step 2: Map interval to GeckoTerminal timeframe
  const tfMap: Record<string, { timeframe: string; aggregate: number }> = {
    "1m":  { timeframe: "minute", aggregate: 1 },
    "5m":  { timeframe: "minute", aggregate: 5 },
    "15m": { timeframe: "minute", aggregate: 15 },
    "1h":  { timeframe: "hour",   aggregate: 1 },
    "4h":  { timeframe: "hour",   aggregate: 4 },
    "1d":  { timeframe: "day",    aggregate: 1 },
  };
  const tf = tfMap[interval] ?? tfMap["1h"];

  // Step 3: Fetch OHLCV from GeckoTerminal
  let raw: number[][] = [];
  try {
    const { data: ohlcvResp } = await axios.get(
      `${GECKO}/networks/solana/pools/${poolAddress}/ohlcv/${tf.timeframe}`,
      { params: { aggregate: tf.aggregate, limit: 300, currency: "usd" } },
    );
    raw = ohlcvResp?.data?.attributes?.ohlcv_list ?? [];
  } catch {
    // Pool exists but no candle data yet (common for very new tokens)
    return [];
  }

  // Step 4: Format as { time, open, high, low, close, volume }
  const candles = raw.map((c: number[]) => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  })).reverse(); // GeckoTerminal returns newest-first

  setCache(key, candles);
  return candles;
}

export async function getLatestSolanaTokens(): Promise<any[]> {
  const data = await dexGet<any[]>("/token-profiles/latest/v1");
  return (data ?? []).filter((t: any) => t.chainId === "solana");
}

export async function getTopSolanaPairs(): Promise<any[]> {
  const key = "top:solana";
  const cached = getCached<any[]>(key);
  if (cached) return cached;

  const data = await dexGet<any>(`/tokens/v1/solana/So11111111111111111111111111111111111111112`);
  const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
  setCache(key, pairs);
  return pairs;
}
