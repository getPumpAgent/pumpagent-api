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
}> {
  const pairs = await getTokenPairs(tokenAddress);
  const pairList = Array.isArray(pairs) ? pairs : pairs?.pairs ?? [];

  if (!pairList.length) {
    return { price: null, volume24h: null, liquidity: null, priceChange24h: null, fdv: null };
  }

  const top = pairList[0];
  return {
    price: top.priceUsd ? parseFloat(top.priceUsd) : null,
    volume24h: top.volume?.h24 ?? null,
    liquidity: top.liquidity?.usd ?? null,
    priceChange24h: top.priceChange?.h24 ?? null,
    fdv: top.fdv ?? null,
  };
}

export async function getOhlcv(
  tokenAddress: string,
  interval: string = "1h"
): Promise<any> {
  const key = `ohlcv:${tokenAddress}:${interval}`;
  const cached = getCached(key);
  if (cached) return cached;

  const pairs = await getTokenPairs(tokenAddress);
  const pairList = Array.isArray(pairs) ? pairs : pairs?.pairs ?? [];
  if (!pairList.length) return [];

  const pairAddress = pairList[0].pairAddress;
  const timeframeMap: Record<string, string> = {
    "1m": "1",
    "5m": "5",
    "1h": "60",
    "4h": "240",
    "1d": "1440",
  };

  const tf = timeframeMap[interval] || "60";
  const data = await dexGet<any>(
    `/dex/chart/solana/${pairAddress}?type=candlestick&res=${tf}`
  );
  setCache(key, data);
  return data;
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
