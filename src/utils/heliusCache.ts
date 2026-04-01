import db from "../db.js";
import { createLogger } from "./logger.js";

const log = createLogger("helius-cache");

// ── SQLite CACHE ──

db.exec(`
  CREATE TABLE IF NOT EXISTS helius_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    ttl INTEGER NOT NULL
  )
`);

const getStmt = db.prepare(
  "SELECT data FROM helius_cache WHERE cache_key = ? AND cached_at + ttl > ?"
);
const setStmt = db.prepare(
  "INSERT OR REPLACE INTO helius_cache (cache_key, data, cached_at, ttl) VALUES (?, ?, ?, ?)"
);

// TTL rules (seconds)
export const TTL = {
  getAsset: 86400,               // 24 hours — metadata never changes
  getAssetBatch: 86400,          // 24 hours
  getAssetsByAuthority: 300,     // 5 minutes
  getTokenLargestAccounts: 3600, // 1 hour
  getTransaction: 86400,         // 24 hours — transactions never change
  transactionHistory: 86400,     // 24 hours
  getAccountInfo: 300,           // 5 minutes
  getMultipleAccounts: 300,      // 5 minutes
  default: 300,                  // 5 minutes for anything else
};

export function getCached(key: string): any | null {
  const now = Math.floor(Date.now() / 1000);
  const row = getStmt.get(key, now) as any;
  if (row) {
    try { return JSON.parse(row.data); } catch { return null; }
  }
  return null;
}

export function setCache(key: string, data: any, ttl: number): void {
  const now = Math.floor(Date.now() / 1000);
  try { setStmt.run(key, JSON.stringify(data), now, ttl); } catch {}
}

// ── RATE LIMITER (50 calls per 60 seconds) ──

const rateLimit = { count: 0, resetAt: Date.now() + 60000 };

export function checkHeliusLimit(): void {
  const now = Date.now();
  if (now > rateLimit.resetAt) {
    rateLimit.count = 0;
    rateLimit.resetAt = now + 60000;
  }
  if (rateLimit.count > 50) {
    log.warn({ count: rateLimit.count }, "Helius rate limit exceeded — cooling down");
    throw new Error("Helius rate limit exceeded — cooling down");
  }
  rateLimit.count++;
}

export function getHeliusCallCount(): number {
  return rateLimit.count;
}
