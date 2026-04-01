import { FastifyInstance } from "fastify";
import {
  buildDepositTransaction,
  buildWithdrawTransaction,
  buildApeTransaction,
  getDepositQuote,
  getUserPositions,
  getAllUserPositions,
  recordDeposit,
  recordWithdrawal,
  getLivePositionPnl,
  getApeQuote,
  getSmartDepositQuote,
} from "../services/liquidityService.js";
import { getPoolByAddress } from "../services/pumpswapMonitor.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("liquidity-routes");

export async function liquidityRoutes(app: FastifyInstance) {
  // Ape: buy token + add LP in one transaction
  app.post("/v1/pools/ape", async (req, reply) => {
    const { userWallet, poolAddress, amountSol, slippage } = req.body as any;

    if (!userWallet || !poolAddress || !amountSol || amountSol <= 0) {
      return reply.status(400).send({ error: "userWallet, poolAddress, amountSol required" });
    }
    if (amountSol < 0.01) {
      return reply.status(400).send({ error: "Minimum is 0.01 SOL" });
    }

    try {
      const result = await buildApeTransaction({
        userWallet,
        poolAddress,
        amountSol,
        slippage: slippage ?? 2,
      });

      const pool = getPoolByAddress(poolAddress);
      return {
        ...result,
        pool: pool ? {
          tokenMint: pool.token_mint,
          tokenName: pool.token_name,
          tokenSymbol: pool.token_symbol,
        } : null,
        feeBps: 50,
        feePercent: "0.5%",
      };
    } catch (err: any) {
      const msg = err.message ?? String(err);
      log.error({ err: msg, pool: poolAddress }, "Ape build failed");

      // Mark pool as invalid if the on-chain account is bad
      if (msg.includes("discriminator") || msg.includes("not found") || msg.includes("does not exist")) {
        try {
          const db = (await import("../db.js")).default;
          db.prepare("UPDATE pumpswap_pools SET status = 'invalid' WHERE pool_address = ?").run(poolAddress);
          log.info({ pool: poolAddress }, "Marked invalid pool");
        } catch {}
      }

      const userMsg = msg.includes("discriminator")
        ? "This pool is no longer valid on-chain"
        : msg.includes("insufficient") ? "Insufficient SOL balance"
        : msg;
      return reply.status(502).send({ error: userMsg });
    }
  });

  // Quote: preview deposit without building tx
  app.post("/v1/pools/quote", async (req, reply) => {
    const { poolAddress, amountSol, slippage } = req.body as any;

    if (!poolAddress || !amountSol || amountSol <= 0) {
      return reply.status(400).send({ error: "poolAddress and amountSol > 0 required" });
    }

    try {
      const quote = await getDepositQuote({
        poolAddress,
        amountSol,
        slippage: slippage ?? 1,
      });

      const pool = getPoolByAddress(poolAddress);

      return {
        ...quote,
        pool: pool
          ? {
              tokenName: pool.token_name,
              tokenSymbol: pool.token_symbol,
              apr: pool.current_apr,
              riskTier: pool.risk_tier,
              riskScore: pool.risk_score,
            }
          : null,
        feeBps: 50,
        feePercent: "0.5%",
      };
    } catch (err: any) {
      log.error({ err: err.message }, "Quote failed");
      return reply.status(502).send({ error: "Failed to get deposit quote", message: err.message });
    }
  });

  // Ape quote: price impact preview before aping in
  app.post("/v1/pools/ape-quote", async (req, reply) => {
    const { poolAddress, userWallet, amountSol, slippage } = req.body as any;

    if (!poolAddress || !userWallet || !amountSol || amountSol <= 0) {
      return reply.status(400).send({ error: "poolAddress, userWallet, amountSol required" });
    }

    try {
      const quote = await getApeQuote({
        poolAddress,
        userWallet,
        amountSol,
        slippage: slippage ?? 2,
      });

      const pool = getPoolByAddress(poolAddress);
      return {
        ...quote,
        pool: pool ? {
          tokenName: pool.token_name,
          tokenSymbol: pool.token_symbol,
        } : null,
        feeBps: 50,
        feePercent: "0.5%",
      };
    } catch (err: any) {
      log.error({ err: err.message, pool: poolAddress }, "Ape quote failed");
      return reply.status(502).send({ error: "Failed to get ape quote", message: err.message });
    }
  });

  // Smart deposit: shows exact amounts needed + token shortfall
  app.post("/v1/pools/smart-deposit", async (req, reply) => {
    const { poolAddress, userWallet, amountSol, slippage } = req.body as any;

    if (!poolAddress || !userWallet || !amountSol || amountSol <= 0) {
      return reply.status(400).send({ error: "poolAddress, userWallet, amountSol required" });
    }

    try {
      const result = await getSmartDepositQuote({
        poolAddress,
        userWallet,
        amountSol,
        slippage: slippage ?? 1,
      });

      return {
        ...result,
        feeBps: 50,
        feePercent: "0.5%",
      };
    } catch (err: any) {
      log.error({ err: err.message, pool: poolAddress }, "Smart deposit quote failed");
      return reply.status(502).send({ error: "Failed to get deposit quote", message: err.message });
    }
  });

  // Build deposit transaction
  app.post("/v1/pools/deposit", async (req, reply) => {
    const { userWallet, poolAddress, amountSol, slippage } = req.body as any;

    if (!userWallet || !poolAddress || !amountSol || amountSol <= 0) {
      return reply.status(400).send({ error: "userWallet, poolAddress, amountSol required" });
    }

    if (amountSol < 0.01) {
      return reply.status(400).send({ error: "Minimum deposit is 0.01 SOL" });
    }

    try {
      const result = await buildDepositTransaction({
        userWallet,
        poolAddress,
        amountSol,
        slippage: slippage ?? 1,
      });

      const pool = getPoolByAddress(poolAddress);

      return {
        ...result,
        pool: pool
          ? {
              tokenMint: pool.token_mint,
              tokenName: pool.token_name,
              tokenSymbol: pool.token_symbol,
            }
          : null,
        feeBps: 50,
        feePercent: "0.5%",
      };
    } catch (err: any) {
      log.error({ err: err.message, pool: poolAddress }, "Deposit build failed");
      return reply.status(502).send({ error: "Failed to build deposit transaction", message: err.message });
    }
  });

  // Build withdraw transaction
  app.post("/v1/pools/withdraw", async (req, reply) => {
    const { userWallet, poolAddress, lpTokenAmount, slippage } = req.body as any;

    if (!userWallet || !poolAddress || !lpTokenAmount) {
      return reply.status(400).send({ error: "userWallet, poolAddress, lpTokenAmount required" });
    }

    try {
      const result = await buildWithdrawTransaction({
        userWallet,
        poolAddress,
        lpTokenAmount,
        slippage: slippage ?? 1,
      });

      return {
        ...result,
        feeBps: 50,
        feePercent: "0.5%",
      };
    } catch (err: any) {
      log.error({ err: err.message, pool: poolAddress }, "Withdraw build failed");
      return reply.status(502).send({ error: "Failed to build withdraw transaction", message: err.message });
    }
  });

  // Record deposit after user signs & submits
  app.post("/v1/lp/positions/deposit", async (req, reply) => {
    const body = req.body as any;

    if (!body.wallet || !body.poolAddress || !body.txSignature) {
      return reply.status(400).send({ error: "wallet, poolAddress, txSignature required" });
    }

    try {
      const pool = getPoolByAddress(body.poolAddress);

      recordDeposit({
        wallet: body.wallet,
        poolAddress: body.poolAddress,
        tokenMint: pool?.token_mint ?? body.tokenMint ?? "",
        tokenName: pool?.token_name ?? body.tokenName ?? null,
        tokenSymbol: pool?.token_symbol ?? body.tokenSymbol ?? null,
        lpTokens: body.lpTokens ?? "0",
        baseAmount: body.baseAmount ?? "0",
        quoteAmount: body.quoteAmount ?? "0",
        solValue: body.solValue ?? 0,
        priceUsd: body.priceUsd ?? null,
        txSignature: body.txSignature,
        feeSol: body.feeSol ?? 0,
      });

      return { success: true };
    } catch (err: any) {
      log.error({ err: err.message }, "Record deposit failed");
      return reply.status(500).send({ error: "Failed to record position" });
    }
  });

  // Record withdrawal after user signs & submits
  app.post("/v1/lp/positions/withdraw", async (req, reply) => {
    const body = req.body as any;

    if (!body.positionId || !body.txSignature) {
      return reply.status(400).send({ error: "positionId, txSignature required" });
    }

    try {
      recordWithdrawal({
        positionId: body.positionId,
        txSignature: body.txSignature,
        baseAmount: body.baseAmount ?? "0",
        quoteAmount: body.quoteAmount ?? "0",
        solValue: body.solValue ?? 0,
        feeSol: body.feeSol ?? 0,
      });

      return { success: true };
    } catch (err: any) {
      log.error({ err: err.message }, "Record withdrawal failed");
      return reply.status(500).send({ error: "Failed to record withdrawal" });
    }
  });

  // Get user positions with live PnL
  app.get("/v1/lp/:wallet/positions", async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    const { status, live: wantLive } = req.query as { status?: string; live?: string };

    try {
      const db = (await import("../db.js")).default;
      const positions = status === "all"
        ? db.prepare("SELECT * FROM lp_positions WHERE wallet = ? ORDER BY entry_at DESC").all(wallet) as any[]
        : db.prepare("SELECT * FROM lp_positions WHERE wallet = ? AND status = 'active' ORDER BY entry_at DESC").all(wallet) as any[];

      log.info({ wallet: wallet.slice(0, 8), count: positions.length }, "Positions query");

      if (!positions.length) {
        return { wallet, positions: [], count: 0 };
      }

      // Optionally skip live PnL enrichment for speed (frontend can request without it)
      if (wantLive === "false") {
        return {
          wallet,
          positions: positions.map((p: any) => ({ ...p, live: null })),
          count: positions.length,
        };
      }

      // Enrich active positions with live PnL (max 5 to avoid rate limits)
      const enriched = [];
      for (const pos of positions.slice(0, 20)) {
        if (pos.status === "active") {
          try {
            const pnl = await getLivePositionPnl(pos);
            enriched.push({ ...pos, live: pnl });
          } catch (e: any) {
            log.warn({ pool: pos.pool_address?.slice(0, 8), err: e.message }, "PnL fetch failed");
            enriched.push({ ...pos, live: null });
          }
        } else {
          enriched.push({ ...pos, live: null });
        }
      }

      return { wallet, positions: enriched, count: enriched.length };
    } catch (err: any) {
      log.error({ err: err.message }, "Get positions failed");
      return reply.status(502).send({ error: "Failed to fetch positions" });
    }
  });
}
