import axios from "axios";
import { createLogger } from "../utils/logger.js";
import db from "../db.js";

const log = createLogger("kol");

// ══════════════════════════════════════════════
// DATABASE — real KOL wallets collected from Lore
// ══════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS kol_wallets (
    address TEXT PRIMARY KEY,
    label TEXT,
    twitter TEXT,
    image_url TEXT,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    profit_sol REAL NOT NULL DEFAULT 0,
    tokens_seen INTEGER NOT NULL DEFAULT 1,
    total_holdings_pct REAL NOT NULL DEFAULT 0,
    is_sniper INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrations for existing tables
try { db.exec(`ALTER TABLE kol_wallets ADD COLUMN twitter TEXT`); } catch {}
try { db.exec(`ALTER TABLE kol_wallets ADD COLUMN image_url TEXT`); } catch {}
try { db.exec(`ALTER TABLE kol_wallets ADD COLUMN wins INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE kol_wallets ADD COLUMN losses INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE kol_wallets ADD COLUMN profit_sol REAL NOT NULL DEFAULT 0`); } catch {}

// Track which token a KOL was seen holding
db.exec(`
  CREATE TABLE IF NOT EXISTS kol_token_sightings (
    address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    owned_pct REAL NOT NULL DEFAULT 0,
    seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (address, token_mint)
  )
`);

const upsertKolStmt = db.prepare(`
  INSERT INTO kol_wallets (address, tokens_seen, total_holdings_pct, is_sniper, last_seen)
  VALUES (?, 1, ?, ?, datetime('now'))
  ON CONFLICT(address) DO UPDATE SET
    tokens_seen = tokens_seen + 1,
    total_holdings_pct = total_holdings_pct + excluded.total_holdings_pct,
    is_sniper = MAX(is_sniper, excluded.is_sniper),
    last_seen = datetime('now')
`);

const upsertKolscanStmt = db.prepare(`
  INSERT INTO kol_wallets (address, label, twitter, image_url, wins, losses, profit_sol, tokens_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  ON CONFLICT(address) DO UPDATE SET
    label = COALESCE(excluded.label, label),
    twitter = COALESCE(excluded.twitter, twitter),
    image_url = COALESCE(excluded.image_url, image_url),
    wins = excluded.wins,
    losses = excluded.losses,
    profit_sol = excluded.profit_sol,
    last_seen = datetime('now')
`);

const upsertSightingStmt = db.prepare(`
  INSERT OR REPLACE INTO kol_token_sightings (address, token_mint, owned_pct, seen_at)
  VALUES (?, ?, ?, datetime('now'))
`);

const getKolCountStmt = db.prepare(`SELECT COUNT(*) as cnt FROM kol_wallets`);
const getTopKolsStmt = db.prepare(`
  SELECT address, label, twitter, image_url, wins, losses, profit_sol, tokens_seen, total_holdings_pct, is_sniper, first_seen, last_seen
  FROM kol_wallets ORDER BY profit_sol DESC, tokens_seen DESC LIMIT ?
`);
const getKolByAddrStmt = db.prepare(`SELECT * FROM kol_wallets WHERE address = ?`);
const setKolLabelStmt = db.prepare(`UPDATE kol_wallets SET label = ? WHERE address = ?`);

// ══════════════════════════════════════════════
// LORE KOLSCAN — fetch + ingest
// ══════════════════════════════════════════════

export interface KolWallet {
  address: string;
  label: string | null;
  twitter: string | null;
  image_url: string | null;
  wins: number;
  losses: number;
  win_rate: number;
  profit_sol: number;
  tokens_seen: number;
  total_holdings_pct: number;
  is_sniper: boolean;
  first_seen: string;
  last_seen: string;
  tier: "elite" | "profitable" | null;
}

function assignTier(wins: number, losses: number, profitSol: number): KolWallet["tier"] {
  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0;
  if (winRate >= 0.55 && profitSol >= 50) return "elite";
  if (total >= 5 && profitSol > 0) return "profitable";
  return null;
}

// Import KOLs from kolscan.io scraped data
// Format per entry: { address, name, twitter, wins, losses, profit_sol }
export function importKolscanEntries(entries: Array<{
  address: string; name: string; twitter?: string;
  wins: number; losses: number; profit_sol: number;
}>): number {
  let imported = 0;
  const tx = db.transaction(() => {
    for (const e of entries) {
      const imgUrl = `https://cdn.kolscan.io/profiles/${e.address}.png`;
      upsertKolscanStmt.run(
        e.address, e.name, e.twitter || null, imgUrl,
        e.wins, e.losses, e.profit_sol
      );
      imported++;
    }
  });
  tx();
  log.info({ imported }, "KOLs imported from kolscan data");
  return imported;
}

let kolscanCache: { data: any[] | null; expiry: number } = { data: null, expiry: 0 };

async function fetchKolscan(): Promise<any[]> {
  if (kolscanCache.data && Date.now() < kolscanCache.expiry) return kolscanCache.data;

  const baseUrl = process.env.LORE_API_URL;
  const apiKey = process.env.LORE_API_KEY;
  if (!baseUrl || !apiKey) return [];

  try {
    const { data } = await axios.get(`${baseUrl}/api/market/kolscan`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    const list = Array.isArray(data) ? data : [];
    kolscanCache = { data: list, expiry: Date.now() + 30_000 };
    return list;
  } catch {
    return kolscanCache.data ?? [];
  }
}

// Ingest all holder wallets from kolscan into kol_wallets table
export async function ingestKolWallets(): Promise<number> {
  const tokens = await fetchKolscan();
  if (!tokens.length) return 0;

  let ingested = 0;
  const ingestTx = db.transaction(() => {
    for (const token of tokens) {
      const mint = token.coinMint;
      const holders = token.holders || [];
      for (const h of holders) {
        const addr = h.holderId;
        if (!addr) continue;
        const pct = h.ownedPercentage || 0;
        const sniper = h.isSniper ? 1 : 0;

        // Check if we already have this sighting (avoid double counting)
        const existing = db.prepare(
          `SELECT 1 FROM kol_token_sightings WHERE address = ? AND token_mint = ?`
        ).get(addr, mint);

        if (!existing) {
          upsertKolStmt.run(addr, pct, sniper);
          upsertSightingStmt.run(addr, mint, pct);
          ingested++;
        }
      }
    }
  });

  ingestTx();
  if (ingested > 0) {
    const total = (getKolCountStmt.get() as any).cnt;
    log.info({ ingested, total }, "KOL wallets ingested from Lore");
  }
  return ingested;
}

// ══════════════════════════════════════════════
// CRON — poll Lore every 5 minutes
// ══════════════════════════════════════════════

let kolCronInterval: ReturnType<typeof setInterval> | null = null;

export function startKolCollector() {
  const baseUrl = process.env.LORE_API_URL;
  const apiKey = process.env.LORE_API_KEY;
  if (!baseUrl || !apiKey) {
    log.warn("LORE_API_URL/KEY not set — KOL collector disabled");
    return;
  }

  // Initial ingest
  ingestKolWallets().catch(() => {});

  // Poll every 5 minutes
  kolCronInterval = setInterval(() => {
    ingestKolWallets().catch((e) => {
      log.warn({ err: (e as Error).message }, "KOL ingest failed");
    });
  }, 5 * 60 * 1000);

  log.info("KOL wallet collector started (polling every 5m)");
}

// ══════════════════════════════════════════════
// PUBLIC API — used by routes and other services
// ══════════════════════════════════════════════

export function getKolTier(wallet: string): "elite" | "profitable" | null {
  const row = getKolByAddrStmt.get(wallet) as any;
  if (!row) return null;
  return assignTier(row.wins || 0, row.losses || 0, row.profit_sol || 0);
}

export async function getKolSignalStrength(tokenMint: string): Promise<{
  score: number;
  eliteCount: number;
  profitableCount: number;
}> {
  const kolscan = await fetchKolscan();
  const match = kolscan.find((t: any) => t.coinMint === tokenMint);

  if (match) {
    const kolCount = match.numKolsTraded ?? 0;
    const score = Math.min(30, Math.floor(kolCount * 1.5));
    const kolHolders = match.numKolsHolding ?? Math.min(kolCount, 3);
    return { score, eliteCount: kolCount, profitableCount: kolHolders };
  }

  return { score: 0, eliteCount: 0, profitableCount: 0 };
}

export function getKolLeaderboard(limit: number = 50): KolWallet[] {
  const rows = getTopKolsStmt.all(limit) as any[];
  return rows.map((r) => {
    const total = (r.wins || 0) + (r.losses || 0);
    return {
      address: r.address,
      label: r.label,
      twitter: r.twitter,
      image_url: r.image_url,
      wins: r.wins || 0,
      losses: r.losses || 0,
      win_rate: total > 0 ? Math.round(((r.wins || 0) / total) * 100 * 10) / 10 : 0,
      profit_sol: r.profit_sol || 0,
      tokens_seen: r.tokens_seen,
      total_holdings_pct: r.total_holdings_pct,
      is_sniper: !!r.is_sniper,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      tier: assignTier(r.wins || 0, r.losses || 0, r.profit_sol || 0),
    };
  });
}

export function getKolStats() {
  const total = (getKolCountStmt.get() as any).cnt;
  const labeled = (db.prepare(`SELECT COUNT(*) as cnt FROM kol_wallets WHERE label IS NOT NULL`).get() as any).cnt;
  const withTwitter = (db.prepare(`SELECT COUNT(*) as cnt FROM kol_wallets WHERE twitter IS NOT NULL`).get() as any).cnt;
  const profitable = (db.prepare(`SELECT COUNT(*) as cnt FROM kol_wallets WHERE profit_sol > 0`).get() as any).cnt;
  const elite = (db.prepare(`SELECT COUNT(*) as cnt FROM kol_wallets WHERE profit_sol >= 50 AND wins > losses`).get() as any).cnt;
  return { total, labeled, withTwitter, profitable, elite };
}

export function setKolLabel(address: string, label: string): boolean {
  const result = setKolLabelStmt.run(label, address);
  return result.changes > 0;
}

export async function getKolActivity(): Promise<any[]> {
  // Get top KOLs from our real database
  const topKols = getTopKolsStmt.all(5) as any[];
  if (!topKols.length) return [];

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];

  const results: any[] = [];
  for (const kol of topKols) {
    try {
      const { data } = await axios.get(
        `https://api.helius.xyz/v0/addresses/${kol.address}/transactions?api-key=${apiKey}&limit=5`
      );
      for (const tx of data ?? []) {
        results.push({
          wallet: kol.address,
          label: kol.label || `KOL (${kol.tokens_seen} tokens)`,
          tier: assignTier(kol.wins || 0, kol.losses || 0, kol.profit_sol || 0),
          tokensSeen: kol.tokens_seen,
          signature: tx.signature,
          type: tx.type,
          timestamp: tx.timestamp,
          description: tx.description,
        });
      }
    } catch {}
  }

  return results.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export async function getKolTrades(wallet: string): Promise<any[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=20`
    );
    return (data ?? []).map((tx: any) => ({
      signature: tx.signature,
      type: tx.type,
      timestamp: tx.timestamp,
      description: tx.description,
    }));
  } catch {
    return [];
  }
}

// Get tokens a specific KOL has been seen holding
export function getKolTokens(address: string): any[] {
  return db.prepare(
    `SELECT token_mint, owned_pct, seen_at FROM kol_token_sightings WHERE address = ? ORDER BY seen_at DESC LIMIT 50`
  ).all(address);
}
