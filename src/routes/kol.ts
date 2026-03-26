import { FastifyInstance } from "fastify";
import {
  getKolActivity,
  getKolLeaderboard,
  getKolTrades,
} from "../services/kolService.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("kol-routes");

export async function kolRoutes(app: FastifyInstance) {
  app.get("/v1/kol/activity", async (_req, reply) => {
    try {
      const activity = await getKolActivity();
      return { activity };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch KOL activity", message: err.message });
    }
  });

  app.get("/v1/kol/leaderboard", async (_req, reply) => {
    try {
      const leaderboard = getKolLeaderboard();
      return { leaderboard };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch leaderboard", message: err.message });
    }
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
}
