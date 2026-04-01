import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "referrals.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_code TEXT UNIQUE NOT NULL,
    wallet_address TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS referral_swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_code TEXT NOT NULL,
    swap_signature TEXT UNIQUE NOT NULL,
    wallet_address TEXT NOT NULL,
    amount_sol REAL NOT NULL,
    fee_gross REAL NOT NULL,
    fee_net REAL NOT NULL,
    referrer_earnings REAL NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    paid INTEGER DEFAULT 0,
    FOREIGN KEY (ref_code) REFERENCES referrals(ref_code)
  );

  CREATE INDEX IF NOT EXISTS idx_swaps_ref ON referral_swaps(ref_code);
  CREATE INDEX IF NOT EXISTS idx_swaps_paid ON referral_swaps(paid);

  CREATE TABLE IF NOT EXISTS telegram_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    score INTEGER NOT NULL,
    format_used TEXT NOT NULL,
    mcap_at_signal REAL,
    followup_sent INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_tg_mint ON telegram_sent(mint);
  CREATE INDEX IF NOT EXISTS idx_tg_sent ON telegram_sent(sent_at);

  CREATE TABLE IF NOT EXISTS pumpswap_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT UNIQUE NOT NULL,
    token_mint TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    token_image TEXT,
    twitter TEXT,
    telegram TEXT,
    website TEXT,
    initial_liquidity_sol REAL,
    initial_liquidity_usd REAL,
    fee_tier REAL,
    bin_step INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    risk_score INTEGER,
    risk_tier TEXT,
    kol_count INTEGER DEFAULT 0,
    current_apr REAL,
    current_volume_24h REAL,
    current_tvl_usd REAL,
    market_cap_usd REAL,
    status TEXT DEFAULT 'active',
    last_updated TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ps_pool ON pumpswap_pools(pool_address);
  CREATE INDEX IF NOT EXISTS idx_ps_risk ON pumpswap_pools(risk_score);
  CREATE INDEX IF NOT EXISTS idx_ps_token ON pumpswap_pools(token_mint);
  CREATE INDEX IF NOT EXISTS idx_ps_status ON pumpswap_pools(status);
  CREATE INDEX IF NOT EXISTS idx_ps_created ON pumpswap_pools(created_at);

  -- Rug tracking tables
  CREATE TABLE IF NOT EXISTS rugged_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_address TEXT UNIQUE,
    token_mint TEXT,
    token_name TEXT,
    creator_wallet TEXT,
    rug_time TEXT DEFAULT (datetime('now')),
    liquidity_before REAL,
    liquidity_after REAL,
    volume_before REAL,
    estimated_stolen_sol REAL,
    detected_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_rp_pool ON rugged_pools(pool_address);
  CREATE INDEX IF NOT EXISTS idx_rp_creator ON rugged_pools(creator_wallet);

  CREATE TABLE IF NOT EXISTS rugged_creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT UNIQUE,
    first_rug_at TEXT DEFAULT (datetime('now')),
    last_rug_at TEXT DEFAULT (datetime('now')),
    total_rugs INTEGER DEFAULT 1,
    total_stolen_sol REAL DEFAULT 0,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_rc_wallet ON rugged_creators(wallet_address);
`);

// Migrations: add columns if missing (idempotent)
const migrations = [
  "ALTER TABLE pumpswap_pools ADD COLUMN top_lp_pct REAL DEFAULT NULL",
  "ALTER TABLE pumpswap_pools ADD COLUMN lp_provider_count INTEGER DEFAULT NULL",
  "ALTER TABLE pumpswap_pools ADD COLUMN lp_locked INTEGER DEFAULT 0",
  "ALTER TABLE pumpswap_pools ADD COLUMN creator_wallet TEXT DEFAULT NULL",
  "ALTER TABLE pumpswap_pools ADD COLUMN risk_flags TEXT DEFAULT NULL",
  "ALTER TABLE pumpswap_pools ADD COLUMN prev_tvl_usd REAL DEFAULT NULL",
  "ALTER TABLE pumpswap_pools ADD COLUMN is_mayhem_mode INTEGER DEFAULT 0",
  "ALTER TABLE pumpswap_pools ADD COLUMN onchain_creator TEXT DEFAULT NULL",
];

for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

export default db;
