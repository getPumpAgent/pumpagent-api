import { FastifyInstance } from "fastify";
import { createLogger } from "../utils/logger.js";
import db from "../db.js";
import { randomUUID } from "crypto";
import { solPrice } from "../services/datastream.js";

const log = createLogger("game");

// ── Database ──

db.exec(`
  CREATE TABLE IF NOT EXISTS game_players (
    player_id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    balance REAL NOT NULL DEFAULT 1000,
    streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    daily_pnl REAL NOT NULL DEFAULT 0,
    daily_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrate existing players: add streak columns if missing
try { db.exec(`ALTER TABLE game_players ADD COLUMN streak INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE game_players ADD COLUMN best_streak INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE game_players ADD COLUMN daily_pnl REAL NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE game_players ADD COLUMN daily_date TEXT NOT NULL DEFAULT '2000-01-01'`); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS game_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    amount REAL NOT NULL,
    price REAL NOT NULL,
    target_price REAL,
    tile_column INTEGER,
    multiplier REAL,
    pnl REAL,
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  )
`);

// Migrate: add tile columns if missing
try { db.exec(`ALTER TABLE game_trades ADD COLUMN target_price REAL`); } catch {}
try { db.exec(`ALTER TABLE game_trades ADD COLUMN tile_column INTEGER`); } catch {}
try { db.exec(`ALTER TABLE game_trades ADD COLUMN multiplier REAL`); } catch {}

try { db.exec(`CREATE INDEX IF NOT EXISTS idx_gt_player ON game_trades (player_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_gt_status ON game_trades (player_id, status)`); } catch {}

// ── Prepared statements ──

const getPlayerStmt = db.prepare(`SELECT * FROM game_players WHERE player_id = ?`);
const getPlayerByName = db.prepare(`SELECT * FROM game_players WHERE username = ?`);
const createPlayerStmt = db.prepare(`INSERT INTO game_players (player_id, username) VALUES (?, ?)`);
const updateBalanceStmt = db.prepare(`UPDATE game_players SET balance = ? WHERE player_id = ?`);
const updateStreakStmt = db.prepare(`UPDATE game_players SET streak = ?, best_streak = MAX(best_streak, ?) WHERE player_id = ?`);
const updateDailyPnlStmt = db.prepare(`UPDATE game_players SET daily_pnl = ?, daily_date = date('now') WHERE player_id = ?`);
const insertTileTradeStmt = db.prepare(
  `INSERT INTO game_trades (player_id, token_address, token_symbol, action, amount, price, target_price, tile_column, multiplier, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertTradeStmt = db.prepare(
  `INSERT INTO game_trades (player_id, token_address, token_symbol, action, amount, price, status) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const getOpenPositionsStmt = db.prepare(
  `SELECT * FROM game_trades WHERE player_id = ? AND status = 'open' ORDER BY opened_at DESC`
);
const getOpenByTokenStmt = db.prepare(
  `SELECT * FROM game_trades WHERE player_id = ? AND token_address = ? AND status = 'open'`
);
const countOpenStmt = db.prepare(
  `SELECT COUNT(*) as cnt FROM game_trades WHERE player_id = ? AND status = 'open'`
);
const getTradeByIdStmt = db.prepare(
  `SELECT * FROM game_trades WHERE id = ? AND player_id = ?`
);
const closeTradeStmt = db.prepare(
  `UPDATE game_trades SET status = 'closed', pnl = ?, closed_at = datetime('now') WHERE id = ?`
);
const getHistoryStmt = db.prepare(
  `SELECT * FROM game_trades WHERE player_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 20`
);
const getAllClosedStmt = db.prepare(
  `SELECT * FROM game_trades WHERE player_id = ? AND status = 'closed'`
);

// ── Rate limiting ──

const lastTradeTime = new Map<string, number>();

// ── Stats helpers ──

function calcPlayerStats(playerId: string) {
  const closed = getAllClosedStmt.all(playerId) as any[];
  const wins = closed.filter((t: any) => (t.pnl || 0) > 0).length;
  const losses = closed.filter((t: any) => (t.pnl || 0) < 0).length;
  const totalPnl = closed.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const totalTraded = closed.reduce((s: number, t: any) => s + t.amount, 0);
  const pnlPct = totalTraded > 0 ? (totalPnl / totalTraded) * 100 : 0;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  // Find biggest win
  const biggestWin = closed.reduce((max: number, t: any) => Math.max(max, t.pnl || 0), 0);
  return { totalPnl, pnlPct, wins, losses, totalTrades: closed.length, winRate, biggestWin };
}

// ── Leaderboard cache ──

let lbCache: { data: any[]; ts: number } = { data: [], ts: 0 };

function getLeaderboard() {
  if (Date.now() - lbCache.ts < 30_000) return lbCache.data;

  const players = db.prepare(`SELECT * FROM game_players`).all() as any[];
  const lb = players.map((p: any) => {
    const stats = calcPlayerStats(p.player_id);
    return {
      playerId: p.player_id,
      username: p.username,
      balance: p.balance,
      streak: p.streak,
      bestStreak: p.best_streak,
      ...stats,
    };
  }).filter((p: any) => p.totalTrades > 0)
    .sort((a: any, b: any) => b.balance - a.balance)
    .slice(0, 50);

  lbCache = { data: lb, ts: Date.now() };
  return lb;
}

// ══════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════

export async function gameRoutes(app: FastifyInstance) {

  // Register
  app.post("/v1/game/register", async (req, reply) => {
    const { username } = req.body as { username: string };
    if (!username || typeof username !== "string") return reply.code(400).send({ error: "Username required" });

    const clean = username.trim().slice(0, 15);
    if (!/^[a-zA-Z0-9_]+$/.test(clean)) return reply.code(400).send({ error: "Alphanumeric + underscores only" });

    const existing = getPlayerByName.get(clean) as any;
    if (existing) return reply.code(409).send({ error: "Username taken" });

    const playerId = randomUUID();
    createPlayerStmt.run(playerId, clean);
    log.info({ playerId, username: clean }, "New player registered");
    return { playerId, username: clean, balance: 1000 };
  });

  // ── Tile Trade (buy tile) ──
  app.post("/v1/game/trade", async (req, reply) => {
    const { playerId, tokenAddress, tokenSymbol, action, amount, targetPrice, tileColumn, multiplier } = req.body as {
      playerId: string; tokenAddress: string; tokenSymbol?: string;
      action: "buy" | "sell"; amount: number;
      targetPrice?: number; tileColumn?: number; multiplier?: number;
    };

    if (!playerId || !tokenAddress || !action || !amount) return reply.code(400).send({ error: "Missing fields" });
    if (amount <= 0) return reply.code(400).send({ error: "Amount must be positive" });

    const player = getPlayerStmt.get(playerId) as any;
    if (!player) return reply.code(404).send({ error: "Player not found" });

    // Rate limit: 1 trade per 500ms
    const lastTs = lastTradeTime.get(playerId) || 0;
    if (Date.now() - lastTs < 500) return reply.code(429).send({ error: "Too fast, wait a moment" });

    if (action === "buy") {
      if (amount > player.balance) return reply.code(400).send({ error: "Insufficient balance" });
      const openCount = (countOpenStmt.get(playerId) as any).cnt;
      if (openCount >= 20) return reply.code(400).send({ error: "Max 20 open tiles" });

      // Get current server SOL price for validation
      const currentPrice = solPrice;
      if (!currentPrice || currentPrice <= 0) return reply.code(502).send({ error: "Price feed unavailable" });

      const entryPrice = currentPrice;
      const tgt = targetPrice || entryPrice;
      const mult = multiplier || 1;

      updateBalanceStmt.run(player.balance - amount, playerId);
      insertTileTradeStmt.run(playerId, tokenAddress, tokenSymbol || "SOL", "buy", amount, entryPrice, tgt, tileColumn || 0, mult, "open");
      lastTradeTime.set(playerId, Date.now());

      const tradeId = (db.prepare(`SELECT last_insert_rowid() as id`).get() as any).id;
      log.info({ playerId, amount, entryPrice, targetPrice: tgt, mult }, "Tile buy");
      return { success: true, tradeId, action: "buy", amount, price: entryPrice, targetPrice: tgt, multiplier: mult, balance: player.balance - amount };
    }

    // Legacy sell support
    if (action === "sell") {
      const openTrades = getOpenByTokenStmt.all(playerId, tokenAddress) as any[];
      if (!openTrades.length) return reply.code(400).send({ error: "No open position" });

      const currentPrice = solPrice;
      if (!currentPrice || currentPrice <= 0) return reply.code(502).send({ error: "Price feed unavailable" });

      let remaining = amount;
      let totalPnl = 0;
      let totalProceeds = 0;

      for (const trade of openTrades) {
        if (remaining <= 0) break;
        const closeAmount = Math.min(remaining, trade.amount);
        const pnl = closeAmount * ((currentPrice - trade.price) / trade.price);
        const proceeds = closeAmount + pnl;

        if (closeAmount >= trade.amount) {
          closeTradeStmt.run(pnl, trade.id);
        } else {
          closeTradeStmt.run(pnl, trade.id);
          const leftover = trade.amount - closeAmount;
          insertTradeStmt.run(playerId, tokenAddress, tokenSymbol || trade.token_symbol, "buy", leftover, trade.price, "open");
        }

        totalPnl += pnl;
        totalProceeds += proceeds;
        remaining -= closeAmount;
      }

      updateBalanceStmt.run(player.balance + totalProceeds, playerId);
      lastTradeTime.set(playerId, Date.now());
      return { success: true, action: "sell", amount: amount - remaining, price: currentPrice, pnl: totalPnl, balance: player.balance + totalProceeds };
    }
  });

  // ── Resolve tile trade (frontend detects price reached or expired) ──
  app.post("/v1/game/trade/resolve", async (req, reply) => {
    const { playerId, tradeId, exitPrice, result } = req.body as {
      playerId: string; tradeId: number; exitPrice: number; result: "won" | "lost";
    };

    if (!playerId || !tradeId || !exitPrice || !result) return reply.code(400).send({ error: "Missing fields" });

    const trade = getTradeByIdStmt.get(tradeId, playerId) as any;
    if (!trade) return reply.code(404).send({ error: "Trade not found" });
    if (trade.status !== "open") return reply.code(400).send({ error: "Trade already resolved" });

    // Anti-cheat: verify exitPrice is close to real SOL price
    const currentPrice = solPrice;
    if (currentPrice > 0) {
      const diff = Math.abs(exitPrice - currentPrice) / currentPrice;
      if (diff > 0.005) {
        return reply.code(400).send({ error: "Exit price doesn't match market price" });
      }
    }

    const player = getPlayerStmt.get(playerId) as any;
    if (!player) return reply.code(404).send({ error: "Player not found" });

    let pnl = 0;
    let newBalance = player.balance;
    let newStreak = player.streak;

    if (result === "won") {
      // Pay out: bet × multiplier
      const mult = trade.multiplier || 1;
      const payout = trade.amount * mult;
      pnl = payout - trade.amount; // net profit

      // Streak bonus
      newStreak = player.streak + 1;
      let streakBonus = 0;
      if (newStreak >= 10) streakBonus = 0.25;
      else if (newStreak >= 5) streakBonus = 0.10;
      else if (newStreak >= 3) streakBonus = 0.05;
      pnl += trade.amount * streakBonus;

      newBalance = player.balance + trade.amount + pnl; // return bet + profit
      updateStreakStmt.run(newStreak, newStreak, playerId);
    } else {
      // Lost: bet already deducted, just record
      pnl = -trade.amount;
      newStreak = 0;
      updateStreakStmt.run(0, player.best_streak, playerId);
    }

    closeTradeStmt.run(pnl, tradeId);
    updateBalanceStmt.run(newBalance, playerId);

    // Update daily PnL
    const today = new Date().toISOString().slice(0, 10);
    const dailyPnl = player.daily_date === today ? player.daily_pnl + pnl : pnl;
    updateDailyPnlStmt.run(dailyPnl, playerId);

    log.info({ playerId, tradeId, result, pnl: pnl.toFixed(2), streak: newStreak }, "Tile resolved");
    return {
      success: true,
      tradeId,
      result,
      pnl,
      balance: newBalance,
      streak: newStreak,
      bestStreak: Math.max(player.best_streak, newStreak),
    };
  });

  // Portfolio
  app.get("/v1/game/portfolio/:playerId", async (req) => {
    const { playerId } = req.params as { playerId: string };
    const player = getPlayerStmt.get(playerId) as any;
    if (!player) return { error: "Player not found" };

    const openPositions = getOpenPositionsStmt.all(playerId) as any[];
    const tradeHistory = getHistoryStmt.all(playerId) as any[];
    const stats = calcPlayerStats(playerId);

    return {
      username: player.username,
      balance: player.balance,
      streak: player.streak,
      bestStreak: player.best_streak,
      openPositions,
      tradeHistory,
      ...stats,
    };
  });

  // Leaderboard
  app.get("/v1/game/leaderboard", async () => {
    return { leaderboard: getLeaderboard() };
  });

  // Player rank
  app.get("/v1/game/leaderboard/:playerId", async (req) => {
    const { playerId } = req.params as { playerId: string };
    const lb = getLeaderboard();
    const idx = lb.findIndex((p: any) => p.playerId === playerId);
    const player = getPlayerStmt.get(playerId) as any;
    if (!player) return { error: "Player not found" };
    const stats = calcPlayerStats(playerId);
    return { rank: idx >= 0 ? idx + 1 : null, username: player.username, balance: player.balance, streak: player.streak, bestStreak: player.best_streak, ...stats };
  });

  // ── Global stats ──
  app.get("/v1/game/stats", async () => {
    const totalPlayers = (db.prepare(`SELECT COUNT(*) as cnt FROM game_players`).get() as any).cnt;
    const totalTrades = (db.prepare(`SELECT COUNT(*) as cnt FROM game_trades`).get() as any).cnt;
    const biggestWin = (db.prepare(`SELECT MAX(pnl) as mx FROM game_trades WHERE status = 'closed'`).get() as any)?.mx || 0;
    const bestStreak = (db.prepare(`SELECT MAX(best_streak) as mx FROM game_players`).get() as any)?.mx || 0;
    return { totalPlayers, totalTrades, biggestWin, bestStreak, currentSolPrice: solPrice };
  });

  // ── Daily target check ──
  app.post("/v1/game/daily-target/check", async (req) => {
    const { playerId } = req.body as { playerId: string };
    const player = getPlayerStmt.get(playerId) as any;
    if (!player) return { error: "Player not found" };

    const today = new Date().toISOString().slice(0, 10);
    const dailyPnl = player.daily_date === today ? player.daily_pnl : 0;
    const target = 50; // 50 SOL daily target
    return { dailyPnl, target, progress: Math.min(1, Math.max(0, dailyPnl / target)), completed: dailyPnl >= target };
  });

  log.info("Game routes registered");
}
