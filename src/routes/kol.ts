import { FastifyInstance } from "fastify";
import {
  getKolActivity,
  getKolLeaderboard,
  getKolTrades,
  getKolStats,
  getKolTokens,
  setKolLabel,
  ingestKolWallets,
  importKolscanEntries,
} from "../services/kolService.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("kol-routes");

const ADMIN_KEY = process.env.ADMIN_KEY || "";

export async function kolRoutes(app: FastifyInstance) {
  app.get("/v1/kol/activity", async (_req, reply) => {
    try {
      const activity = await getKolActivity();
      return { activity };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch KOL activity", message: err.message });
    }
  });

  app.get("/v1/kol/leaderboard", async (req, reply) => {
    try {
      const query = req.query as { limit?: string };
      const limit = Math.min(200, parseInt(query.limit || "50") || 50);
      const leaderboard = getKolLeaderboard(limit);
      return { leaderboard };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch leaderboard", message: err.message });
    }
  });

  app.get("/v1/kol/stats", async () => {
    return getKolStats();
  });

  app.get("/v1/kol/:wallet/trades", async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    try {
      const trades = await getKolTrades(wallet);
      return { wallet, trades };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch trades", message: err.message });
    }
  });

  app.get("/v1/kol/:wallet/tokens", async (req) => {
    const { wallet } = req.params as { wallet: string };
    return { wallet, tokens: getKolTokens(wallet) };
  });

  // Admin: label a KOL wallet
  app.post("/v1/kol/:wallet/label", async (req, reply) => {
    const key = (req.headers["x-admin-key"] as string) || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const { wallet } = req.params as { wallet: string };
    const { label } = req.body as { label: string };
    if (!label) return { error: "label required" };
    const ok = setKolLabel(wallet, label);
    return ok ? { success: true, wallet, label } : { error: "Wallet not found" };
  });

  // Admin: bulk import from kolscan.io data
  // Body: { kols: [{ address, name, twitter, wins, losses, profit_sol }] }
  app.post("/v1/kol/import", async (req, reply) => {
    const key = (req.headers["x-admin-key"] as string) || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const { kols } = req.body as { kols: any[] };
    if (!Array.isArray(kols) || !kols.length) return { error: "kols array required" };
    const count = importKolscanEntries(kols);
    return { imported: count, ...getKolStats() };
  });

  // Admin: force ingest now
  app.post("/v1/kol/ingest", async (req, reply) => {
    const key = (req.headers["x-admin-key"] as string) || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    const count = await ingestKolWallets();
    return { ingested: count, ...getKolStats() };
  });
}
