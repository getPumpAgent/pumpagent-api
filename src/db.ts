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
`);

export default db;
