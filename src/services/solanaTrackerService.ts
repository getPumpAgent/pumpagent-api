import { Client as SolanaTrackerClient } from "@solana-tracker/data-api";
import { createLogger } from "../utils/logger.js";
import db from "../db.js";

const log = createLogger("solana-tracker");

// ══════════════════════════════════════════════
// KILL SWITCH — set to false to disable ALL API calls
// Only enable for explicit /scan commands with SQLite cache
// ══════════════════════════════════════════════
const SOLANA_TRACKER_ENABLED = true;

const apiKey = process.env.SOLANA_TRACKER_API_KEY || "";
let client: SolanaTrackerClient | null = null;

function getClient(): SolanaTrackerClient {
  if (!client) {
    if (!apiKey) throw new Error("SOLANA_TRACKER_API_KEY not set");
    client = new SolanaTrackerClient({ apiKey });
  }
  return client;
}

// ── SQLite CACHE (24h TTL) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS solana_tracker_cache (
    token_address TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL
  )
`);

const getCacheStmt = db.prepare(
  "SELECT data FROM solana_tracker_cache WHERE token_address = ? AND cached_at > (strftime('%s','now') - 86400)"
);
const setCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO solana_tracker_cache (token_address, data, cached_at) VALUES (?, ?, strftime('%s','now'))"
);

function getFromCache(address: string): any | null {
  const row = getCacheStmt.get(address) as any;
  if (row) {
    try { return JSON.parse(row.data); } catch { return null; }
  }
  return null;
}

function setInCache(address: string, data: any): void {
  try { setCacheStmt.run(address, JSON.stringify(data)); } catch {}
}

// ── EMPTY RESPONSES (when disabled) ──

const EMPTY_INSIGHTS = {
  insiders: 0, insidersPercentage: 0, snipers: 0, snipersPercentage: 0,
  bundlers: { count: 0, balance: 0, percentage: 0 },
  dev: 0, top10: 0, lpBurn: 0, riskScore: 0, riskFactors: [], rugged: false,
  curvePercentage: null, status: "unknown",
  mintAuthority: null, freezeAuthority: null, deployer: null,
  socials: { twitter: null, telegram: null, website: null }, hasSocials: false,
  priceUsd: 0, marketCapUsd: 0, liquidityUsd: 0,
  volume_5m: 0, volume_1h: 0, volume_24h: 0, buys: 0, sells: 0, holders: 0,
  name: null, symbol: null, image: null,
  isCashbackCoin: false, isMayhemMode: false, poolAddress: null,
};

// ── 1. TOKEN INSIGHTS (only via /scan, SQLite cached 24h) ──

export async function getTokenInsights(address: string) {
  // Check SQLite cache first (always, even when enabled)
  const cached = getFromCache(address);
  if (cached) { log.debug({ address: address.slice(0, 8) }, "ST cache hit"); return cached; }

  // Check error cache (1h TTL) — don't retry known failures
  const errRow = db.prepare("SELECT data FROM solana_tracker_cache WHERE token_address = ? AND cached_at > (strftime('%s','now') - 3600)").get("err:" + address) as any;
  if (errRow) { log.debug({ address: address.slice(0, 8) }, "ST error cache hit — skipping"); return EMPTY_INSIGHTS; }

  // If disabled, return empty
  if (!SOLANA_TRACKER_ENABLED || !apiKey) return EMPTY_INSIGHTS;

  log.info({ address }, "ST API call: getTokenInfo");
  let d;
  try {
    const c = getClient();
    d = await c.getTokenInfo(address);
  } catch (err: any) {
    log.warn({ address, err: err.message }, "ST getTokenInfo failed — caching error for 1h");
    // Cache the error so we don't retry for 1 hour
    // Use a special key prefix and store a marker
    try {
      db.prepare("INSERT OR REPLACE INTO solana_tracker_cache (token_address, data, cached_at) VALUES (?, ?, strftime('%s','now'))").run("err:" + address, '"ERR"');
    } catch {}
    return EMPTY_INSIGHTS;
  }
  const pool = d.pools?.[0];
  const risk = d.risk;
  const result = {
    insiders: risk?.insiders?.count ?? 0,
    insidersPercentage: risk?.insiders?.totalPercentage ?? 0,
    snipers: risk?.snipers?.count ?? 0,
    snipersPercentage: risk?.snipers?.totalPercentage ?? 0,
    bundlers: {
      count: risk?.bundlers?.count ?? 0,
      balance: risk?.bundlers?.totalBalance ?? 0,
      percentage: risk?.bundlers?.totalPercentage ?? 0,
    },
    dev: risk?.dev?.percentage ?? 0,
    top10: risk?.top10 ?? 0,
    lpBurn: pool?.lpBurn ?? 0,
    riskScore: risk?.score ?? 0,
    riskFactors: risk?.risks ?? [],
    rugged: risk?.rugged ?? false,
    curvePercentage: pool?.curvePercentage ?? null,
    status: pool?.curvePercentage != null && pool.curvePercentage < 100 ? "graduating" : "graduated",
    mintAuthority: pool?.security?.mintAuthority ?? null,
    freezeAuthority: pool?.security?.freezeAuthority ?? null,
    deployer: pool?.deployer ?? null,
    socials: {
      twitter: d.token?.twitter ?? d.token?.strictSocials?.twitter ?? null,
      telegram: d.token?.telegram ?? d.token?.strictSocials?.telegram ?? null,
      website: d.token?.website ?? d.token?.strictSocials?.website ?? null,
    },
    hasSocials: !!(d.token?.twitter || d.token?.telegram || d.token?.website),
    priceUsd: pool?.price?.usd ?? 0,
    marketCapUsd: pool?.marketCap?.usd ?? 0,
    liquidityUsd: pool?.liquidity?.usd ?? 0,
    volume_5m: 0,
    volume_1h: pool?.txns?.volume ?? 0,
    volume_24h: pool?.txns?.volume24h ?? 0,
    buys: d.buys ?? 0,
    sells: d.sells ?? 0,
    holders: d.holders ?? 0,
    name: d.token?.name ?? null,
    symbol: d.token?.symbol ?? null,
    image: d.token?.image ?? null,
    isCashbackCoin: false,
    isMayhemMode: pool?.pumpfun?.isMayhemMode ?? pool?.["pumpfun-amm"]?.isMayhemMode ?? false,
    poolAddress: pool?.poolId ?? null,
  };
  setInCache(address, result);
  return result;
}

// ── ALL SEARCH/PICKS FUNCTIONS — DISABLED ──

export async function getMomentumPicks() { return []; }
export async function getDegenPicks() { return []; }
export async function getSafePicks() { return []; }

// ── GRADUATING / GRADUATED (REST, 60s cache) ──

let graduatingCache: { data: any; ts: number } | null = null;
let graduatedCache: { data: any; ts: number } | null = null;
const REST_CACHE_TTL = 60_000;

export async function getGraduatingTokens() {
  if (graduatingCache && Date.now() - graduatingCache.ts < REST_CACHE_TTL) {
    return graduatingCache.data;
  }
  if (!SOLANA_TRACKER_ENABLED || !apiKey) return [];
  log.info("ST API call: getGraduatingTokens");
  try {
    const c = getClient();
    const res = await c.getGraduatingTokens();
    const data = (res || []).slice(0, 20);
    graduatingCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    log.error({ err: e }, "getGraduatingTokens failed");
    return graduatingCache?.data || [];
  }
}

export async function getGraduatedTokens() {
  if (graduatedCache && Date.now() - graduatedCache.ts < REST_CACHE_TTL) {
    return graduatedCache.data;
  }
  if (!SOLANA_TRACKER_ENABLED || !apiKey) return [];
  log.info("ST API call: getGraduatedTokens");
  try {
    const c = getClient();
    const res = await c.getGraduatedTokens();
    const data = (res || []).slice(0, 20);
    graduatedCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    log.error({ err: e }, "getGraduatedTokens failed");
    return graduatedCache?.data || [];
  }
}

export async function getGraduatingPicks() { return getGraduatingTokens(); }

// ── OHLCV — enabled for bonding curve tokens (fallback when GeckoTerminal has no pool) ──

const ohlcvCache = new Map<string, { data: any[]; ts: number }>();
const OHLCV_CACHE_TTL = 30_000;

export async function getTokenOHLCV(address: string, timeframe: string = "1m") {
  const cacheKey = `ohlcv:${address}:${timeframe}`;
  const cached = ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OHLCV_CACHE_TTL) return cached.data;

  if (!SOLANA_TRACKER_ENABLED || !apiKey) return [];

  log.info({ address: address.slice(0, 8), timeframe }, "ST API call: getChartData");
  try {
    const c = getClient();
    const now = Math.floor(Date.now() / 1000);
    const tfSeconds: Record<string, number> = { "1s": 300, "1m": 18000, "5m": 90000, "15m": 270000, "1h": 1080000, "4h": 4320000, "1d": 25920000 };
    const lookback = tfSeconds[timeframe] || 18000;
    const res = await c.getChartData({
      tokenAddress: address,
      type: timeframe,
      timeFrom: now - lookback,
      timeTo: now,
      currency: "usd",
    });
    const candles = (res.oclhv || []).map((c: any) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume || 0,
    }));
    ohlcvCache.set(cacheKey, { data: candles, ts: Date.now() });
    return candles;
  } catch (e: any) {
    log.warn({ address: address.slice(0, 8), err: e.message }, "ST getChartData failed");
    return cached?.data || [];
  }
}

// ── FIRST BUYERS — DISABLED unless cache hit ──

export async function getFirstBuyers(address: string) {
  const cached = getFromCache("buyers:" + address);
  if (cached) return cached;
  if (!SOLANA_TRACKER_ENABLED || !apiKey) return [];
  log.info({ address: address.slice(0, 8) }, "ST API call: getFirstBuyers");
  const c = getClient();
  const res = await c.getFirstBuyers(address);
  const result = res || [];
  setInCache("buyers:" + address, result);
  return result;
}

// ── HEALTH CHECK ──

export function isConfigured(): boolean {
  // Return false so no callers attempt to use ST
  return SOLANA_TRACKER_ENABLED && !!apiKey;
}
