/**
 * Token Accumulator — Builds a live cache of tokens from WebSocket streams.
 * Replaces LORE picks with our own data powered by Solana Tracker.
 *
 * Listens to datastream events (graduating, graduated, latest) and maintains
 * categorized token lists that the picks API can serve directly.
 */
import { datastreamEvents } from "./datastream.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("accumulator");

interface AccumulatedToken {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  price: number;
  marketCap: number;
  liquidity: number;
  curvePercentage: number | null;
  holders: number;
  riskScore: number;
  insiders: number;
  snipers: number;
  bundlers: number;
  lpBurn: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  hasSocials: boolean;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  createdTime: number;
  lastSeen: number;
  source: "graduating" | "graduated" | "latest";
  raw: any; // original WebSocket data for frontend compatibility
}

// ── In-memory stores ──
const graduatingTokens = new Map<string, AccumulatedToken>();
const graduatedTokens = new Map<string, AccumulatedToken>();
const latestTokens = new Map<string, AccumulatedToken>();

const MAX_PER_CATEGORY = 100;

function normalize(data: any, source: "graduating" | "graduated" | "latest"): AccumulatedToken | null {
  const token = data.token;
  const pool = (data.pools || [])[0];
  const risk = data.risk || {};
  if (!token?.mint) return null;

  const socials = token.strictSocials || {};
  return {
    mint: token.mint,
    name: token.name || "Unknown",
    symbol: token.symbol || "???",
    image: token.image || null,
    price: pool?.price?.usd || 0,
    marketCap: pool?.marketCap?.usd || 0,
    liquidity: pool?.liquidity?.usd || 0,
    curvePercentage: pool?.curvePercentage ?? null,
    holders: data.holders || 0,
    riskScore: risk.score || 0,
    insiders: risk.insiders?.count || 0,
    snipers: risk.snipers?.count || 0,
    bundlers: risk.bundlers?.count || 0,
    lpBurn: pool?.lpBurn || 0,
    mintAuthority: pool?.security?.mintAuthority ?? null,
    freezeAuthority: pool?.security?.freezeAuthority ?? null,
    hasSocials: !!(socials.twitter || socials.telegram || socials.website || token.twitter || token.telegram || token.website),
    twitter: socials.twitter || token.twitter || null,
    telegram: socials.telegram || token.telegram || null,
    website: socials.website || token.website || null,
    createdTime: token.creation?.created_time || 0,
    lastSeen: Date.now(),
    source,
    raw: data,
  };
}

function addToMap(map: Map<string, AccumulatedToken>, token: AccumulatedToken) {
  map.set(token.mint, token);
  // Trim oldest if over limit
  if (map.size > MAX_PER_CATEGORY) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, val] of map) {
      if (val.lastSeen < oldestTime) { oldestTime = val.lastSeen; oldestKey = key; }
    }
    if (oldestKey) map.delete(oldestKey);
  }
}

// ── Public API ──

/** Get recent graduating tokens sorted by curve % desc — returns raw WebSocket format */
export function getAccumulatedGraduating(limit = 20): any[] {
  return [...graduatingTokens.values()]
    .sort((a, b) => (b.curvePercentage ?? 0) - (a.curvePercentage ?? 0))
    .slice(0, limit)
    .map(t => t.raw);
}

/** Get recent graduated tokens sorted by recency — returns raw WebSocket format */
export function getAccumulatedGraduated(limit = 20): any[] {
  return [...graduatedTokens.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(t => t.raw);
}

/** Get "momentum" — graduated tokens sorted by market cap */
export function getAccumulatedMomentum(limit = 20): any[] {
  return [...graduatedTokens.values()]
    .filter(t => t.marketCap > 0)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, limit)
    .map(t => t.raw);
}

/** Get "degen" — newest tokens with low mcap */
export function getAccumulatedDegen(limit = 20): any[] {
  return [...graduatingTokens.values(), ...latestTokens.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(t => t.raw);
}

/** Get "hot" — highest liquidity tokens recently seen */
export function getAccumulatedHot(limit = 20): any[] {
  return [...graduatedTokens.values(), ...graduatingTokens.values()]
    .filter(t => t.liquidity > 0)
    .sort((a, b) => b.liquidity - a.liquidity)
    .slice(0, limit)
    .map(t => t.raw);
}

/** Get "fresh" — most recently seen across all streams */
export function getAccumulatedFresh(limit = 20): any[] {
  return [...graduatingTokens.values(), ...graduatedTokens.values(), ...latestTokens.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(t => t.raw);
}

/** All active mints (for per-token subscriptions) */
export function getActiveMints(): string[] {
  const mints = new Set<string>();
  for (const m of graduatingTokens.keys()) mints.add(m);
  for (const m of graduatedTokens.keys()) mints.add(m);
  return [...mints];
}

/** Update a token's price/mcap/liq from a pool update */
export function updateTokenFromPool(mint: string, poolData: any) {
  for (const map of [graduatingTokens, graduatedTokens, latestTokens]) {
    const t = map.get(mint);
    if (t) {
      t.price = poolData.price?.usd ?? t.price;
      t.marketCap = poolData.marketCap?.usd ?? t.marketCap;
      t.liquidity = poolData.liquidity?.usd ?? t.liquidity;
      t.lastSeen = Date.now();
    }
  }
}

/** Update a token's holder count */
export function updateTokenHolders(mint: string, total: number) {
  for (const map of [graduatingTokens, graduatedTokens, latestTokens]) {
    const t = map.get(mint);
    if (t) t.holders = total;
  }
}

export function getAccumulatorStats() {
  return {
    graduating: graduatingTokens.size,
    graduated: graduatedTokens.size,
    latest: latestTokens.size,
    total: graduatingTokens.size + graduatedTokens.size + latestTokens.size,
  };
}

// ── Start listening to datastream events ──
export function startAccumulator() {
  datastreamEvents.on("graduating", (data: any) => {
    const t = normalize(data, "graduating");
    if (t) addToMap(graduatingTokens, t);
  });

  datastreamEvents.on("graduated", (data: any) => {
    const t = normalize(data, "graduated");
    if (t) {
      addToMap(graduatedTokens, t);
      // Remove from graduating if it migrated
      graduatingTokens.delete(t.mint);
    }
  });

  datastreamEvents.on("latest", (data: any) => {
    const t = normalize(data, "latest");
    if (t) addToMap(latestTokens, t);
  });

  log.info("Token accumulator started — caching WebSocket tokens for picks");
}
