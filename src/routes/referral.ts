import { FastifyInstance } from "fastify";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("referral");

function requireAdmin(req: any, reply: any): boolean {
  const key = req.headers["x-admin-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!key || key !== process.env.ADMIN_KEY) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function referralRoutes(app: FastifyInstance) {

  // Register a new referrer (self-service)
  app.post<{ Body: { ref: string; wallet?: string; notes?: string } }>(
    "/v1/referral/register",
    async (req, reply) => {
      const { ref, wallet, notes } = req.body;
      if (!ref) {
        return reply.status(400).send({ error: "ref is required" });
      }

      const code = ref.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_]/g, "");
      if (!code || code.length < 2) {
        return reply.status(400).send({ error: "Invalid handle" });
      }

      // If already exists, return their info
      const existing = db.prepare("SELECT * FROM referrals WHERE ref_code = ?").get(code) as any;
      if (existing) {
        return { success: true, ref: code, wallet: existing.wallet_address, existing: true };
      }

      db.prepare("INSERT INTO referrals (ref_code, wallet_address, notes) VALUES (?, ?, ?)").run(code, wallet ?? "", notes ?? null);
      log.info({ ref: code }, "Referrer self-registered");
      return { success: true, ref: code, wallet: wallet ?? null, existing: false };
    },
  );

  // Update wallet address
  app.put<{ Body: { ref: string; wallet: string } }>(
    "/v1/referral/wallet",
    async (req, reply) => {
      const { ref, wallet } = req.body;
      if (!ref || !wallet) {
        return reply.status(400).send({ error: "ref and wallet are required" });
      }

      const code = ref.toLowerCase().replace(/^@/, "");
      const existing = db.prepare("SELECT id FROM referrals WHERE ref_code = ?").get(code) as any;
      if (!existing) {
        return reply.status(404).send({ error: "Referral code not found" });
      }

      db.prepare("UPDATE referrals SET wallet_address = ? WHERE ref_code = ?").run(wallet, code);
      log.info({ ref: code, wallet }, "Wallet updated");
      return { success: true, ref: code, wallet };
    },
  );

  // Get stats for a referrer
  app.get<{ Params: { ref: string } }>(
    "/v1/referral/stats/:ref",
    async (req) => {
      const code = req.params.ref.toLowerCase().replace(/^@/, "");

      const referrer = db.prepare("SELECT * FROM referrals WHERE ref_code = ?").get(code) as any;
      if (!referrer) {
        return { ref: code, error: "not_found" };
      }

      const stats = db.prepare(`
        SELECT
          COUNT(*) as totalSwaps,
          COALESCE(SUM(amount_sol), 0) as totalVolumeSol,
          COALESCE(SUM(fee_net), 0) as totalFeesNet,
          COALESCE(SUM(referrer_earnings), 0) as totalEarnings,
          COALESCE(SUM(CASE WHEN paid = 0 THEN referrer_earnings ELSE 0 END), 0) as unpaidEarnings
        FROM referral_swaps WHERE ref_code = ?
      `).get(code) as any;

      const swaps = db.prepare(
        "SELECT * FROM referral_swaps WHERE ref_code = ? ORDER BY timestamp DESC LIMIT 100"
      ).all(code);

      return {
        ref: code,
        wallet: referrer.wallet_address,
        createdAt: referrer.created_at,
        ...stats,
        swaps,
      };
    },
  );

  // Leaderboard
  app.get("/v1/referral/leaderboard", async () => {
    const rows = db.prepare(`
      SELECT
        r.ref_code,
        r.wallet_address,
        COUNT(s.id) as totalSwaps,
        COALESCE(SUM(s.amount_sol), 0) as totalVolumeSol,
        COALESCE(SUM(s.referrer_earnings), 0) as totalEarnings,
        COALESCE(SUM(CASE WHEN s.paid = 0 THEN s.referrer_earnings ELSE 0 END), 0) as unpaidEarnings
      FROM referrals r
      LEFT JOIN referral_swaps s ON s.ref_code = r.ref_code
      GROUP BY r.ref_code
      ORDER BY unpaidEarnings DESC
      LIMIT 10
    `).all();

    return { leaderboard: rows };
  });

  // Track a swap
  app.post<{ Body: { ref: string; signature: string; amountSol: number; swapperWallet: string } }>(
    "/v1/referral/track",
    async (req, reply) => {
      const { ref, signature, amountSol, swapperWallet } = req.body;

      if (!ref || !signature || !amountSol || !swapperWallet) {
        return reply.status(400).send({ error: "ref, signature, amountSol, swapperWallet required" });
      }

      const code = ref.toLowerCase().replace(/^@/, "");

      // Validate ref exists
      const referrer = db.prepare("SELECT * FROM referrals WHERE ref_code = ?").get(code) as any;
      if (!referrer) {
        return reply.status(404).send({ error: "Unknown referral code" });
      }

      // No self-referral
      if (swapperWallet === referrer.wallet_address) {
        return reply.status(400).send({ error: "Self-referral not allowed" });
      }

      // Minimum amount
      if (amountSol < 0.05) {
        return reply.status(400).send({ error: "Minimum swap amount is 0.05 SOL" });
      }

      // Check duplicate
      const existing = db.prepare("SELECT id FROM referral_swaps WHERE swap_signature = ?").get(signature);
      if (existing) {
        return reply.status(409).send({ error: "Swap already tracked" });
      }

      const feeGross = amountSol * 0.005;      // 0.5% platform fee
      const feeNet = amountSol * 0.004;         // after Jupiter cut
      const payoutPct = Number(process.env.REFERRAL_PAYOUT_PCT) || 0.20;
      const referrerEarnings = feeNet * payoutPct;

      db.prepare(`
        INSERT INTO referral_swaps (ref_code, swap_signature, wallet_address, amount_sol, fee_gross, fee_net, referrer_earnings)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(code, signature, swapperWallet, amountSol, feeGross, feeNet, referrerEarnings);

      log.info({ ref: code, sig: signature.slice(0, 12), sol: amountSol, earnings: referrerEarnings }, "Swap tracked");

      return { success: true, ref: code, amountSol, referrerEarnings };
    },
  );

  // Mark swaps as paid (admin only)
  app.post<{ Body: { ref: string; through_date: string } }>(
    "/v1/referral/markpaid",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;

      const { ref, through_date } = req.body;
      if (!ref || !through_date) {
        return reply.status(400).send({ error: "ref and through_date required" });
      }

      const code = ref.toLowerCase().replace(/^@/, "");
      const result = db.prepare(
        "UPDATE referral_swaps SET paid = 1 WHERE ref_code = ? AND paid = 0 AND timestamp <= ?"
      ).run(code, through_date);

      log.info({ ref: code, through_date, updated: result.changes }, "Marked paid");
      return { success: true, ref: code, markedPaid: result.changes };
    },
  );

  // Admin: list all referrers
  app.get("/v1/referral/admin/all", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const rows = db.prepare(`
      SELECT
        r.ref_code,
        r.wallet_address,
        r.created_at,
        r.notes,
        COUNT(s.id) as totalSwaps,
        COALESCE(SUM(s.amount_sol), 0) as totalVolumeSol,
        COALESCE(SUM(s.fee_net), 0) as totalFeesNet,
        COALESCE(SUM(s.referrer_earnings), 0) as totalEarnings,
        COALESCE(SUM(CASE WHEN s.paid = 0 THEN s.referrer_earnings ELSE 0 END), 0) as unpaidEarnings
      FROM referrals r
      LEFT JOIN referral_swaps s ON s.ref_code = r.ref_code
      GROUP BY r.ref_code
      ORDER BY r.created_at DESC
    `).all();

    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM referrals) as totalReferrers,
        COALESCE(SUM(amount_sol), 0) as totalVolume,
        COALESCE(SUM(fee_net), 0) as totalFees,
        COALESCE(SUM(referrer_earnings), 0) as totalEarnings,
        COALESCE(SUM(CASE WHEN paid = 0 THEN referrer_earnings ELSE 0 END), 0) as totalOwed
      FROM referral_swaps
    `).get();

    return { totals, referrers: rows };
  });
}
