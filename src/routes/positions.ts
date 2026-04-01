import { FastifyInstance } from "fastify";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("positions");

// ── Create table + indexes ─────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    token_image TEXT,
    entry_price_usd REAL NOT NULL,
    entry_amount_sol REAL NOT NULL,
    token_amount REAL,
    entry_txid TEXT UNIQUE NOT NULL,
    entry_time INTEGER DEFAULT (strftime('%s','now')),
    exit_price_usd REAL,
    exit_amount_sol REAL,
    exit_txid TEXT,
    exit_time INTEGER,
    status TEXT DEFAULT 'open',
    pnl_usd REAL,
    pnl_pct REAL
  );
  CREATE INDEX IF NOT EXISTS idx_pos_wallet ON positions(wallet_address, status);
  CREATE INDEX IF NOT EXISTS idx_pos_mint ON positions(token_mint);
`);

// ── Prepared statements ────────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO positions (wallet_address, token_mint, token_name, token_symbol, token_image,
    entry_price_usd, entry_amount_sol, token_amount, entry_txid)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = db.prepare(`SELECT * FROM positions WHERE id = ?`);

const getByWalletStmt = db.prepare(`
  SELECT * FROM positions WHERE wallet_address = ?
  ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, entry_time DESC
  LIMIT 50
`);

const getByWalletStatusStmt = db.prepare(`
  SELECT * FROM positions WHERE wallet_address = ? AND status = ?
  ORDER BY entry_time DESC
  LIMIT 50
`);

const closeStmt = db.prepare(`
  UPDATE positions
  SET exit_price_usd = ?, exit_amount_sol = ?, exit_txid = ?,
      exit_time = strftime('%s','now'), status = 'closed',
      pnl_usd = ?, pnl_pct = ?
  WHERE id = ? AND status = 'open'
`);

const summaryStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
    COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl_usd ELSE 0 END), 0) AS total_pnl_usd,
    SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
    SUM(CASE WHEN status = 'closed' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS win_count
  FROM positions
  WHERE wallet_address = ?
`);

// ── Routes ─────────────────────────────────────────────────────────────

export async function positionRoutes(app: FastifyInstance) {

  // Record a new position
  app.post("/v1/positions", async (req, reply) => {
    const body = req.body as any;
    const { wallet, mint, name, symbol, image, entryPrice, entrySol, tokenAmount, txid } = body ?? {};

    if (!wallet || !mint || !entryPrice || !entrySol || !txid) {
      return reply.status(400).send({ error: "Missing required fields: wallet, mint, entryPrice, entrySol, txid" });
    }

    try {
      const result = insertStmt.run(wallet, mint, name ?? null, symbol ?? null, image ?? null,
        entryPrice, entrySol, tokenAmount ?? null, txid);
      const created = getByIdStmt.get(result.lastInsertRowid);
      return reply.status(201).send(created);
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return reply.status(409).send({ error: "Position with this txid already exists" });
      }
      log.error("insert position failed", err);
      return reply.status(500).send({ error: "Failed to create position" });
    }
  });

  // Get positions for a wallet
  app.get("/v1/positions/:wallet", async (req, reply) => {
    const { wallet } = req.params as any;
    const { status } = req.query as any;

    try {
      let positions;
      if (status === "open" || status === "closed") {
        positions = getByWalletStatusStmt.all(wallet, status);
      } else {
        positions = getByWalletStmt.all(wallet);
      }
      return { positions };
    } catch (err: any) {
      log.error("get positions failed", err);
      return reply.status(500).send({ error: "Failed to fetch positions" });
    }
  });

  // Close a position
  app.patch("/v1/positions/:id/close", async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const { exitPrice, exitSol, exitTxid } = body ?? {};

    if (!exitPrice || !exitTxid) {
      return reply.status(400).send({ error: "Missing required fields: exitPrice, exitTxid" });
    }

    const existing = getByIdStmt.get(Number(id)) as any;
    if (!existing) {
      return reply.status(404).send({ error: "Position not found" });
    }
    if (existing.status !== "open") {
      return reply.status(400).send({ error: "Position is already closed" });
    }

    const pnlUsd = (exitPrice - existing.entry_price_usd) * (existing.token_amount ?? 0);
    const pnlPct = existing.entry_price_usd > 0
      ? ((exitPrice - existing.entry_price_usd) / existing.entry_price_usd) * 100
      : 0;

    try {
      closeStmt.run(exitPrice, exitSol ?? null, exitTxid,
        Math.round(pnlUsd * 100) / 100,
        Math.round(pnlPct * 100) / 100,
        Number(id));
      const updated = getByIdStmt.get(Number(id));
      return updated;
    } catch (err: any) {
      log.error("close position failed", err);
      return reply.status(500).send({ error: "Failed to close position" });
    }
  });

  // Wallet summary
  app.get("/v1/positions/:wallet/summary", async (req, reply) => {
    const { wallet } = req.params as any;

    try {
      const row = summaryStmt.get(wallet) as any;
      const openCount = row?.open_count ?? 0;
      const totalPnlUsd = Math.round((row?.total_pnl_usd ?? 0) * 100) / 100;
      const closedCount = row?.closed_count ?? 0;
      const winCount = row?.win_count ?? 0;
      const winRate = closedCount > 0 ? Math.round((winCount / closedCount) * 10000) / 100 : 0;

      return { openCount, totalPnlUsd, winRate };
    } catch (err: any) {
      log.error("summary failed", err);
      return reply.status(500).send({ error: "Failed to fetch summary" });
    }
  });
}
