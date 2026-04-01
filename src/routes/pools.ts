import { FastifyInstance } from "fastify";
import {
  queryPools,
  getPoolByAddress,
  getTopPools,
  calculateCompositeScore,
} from "../services/pumpswapMonitor.js";
import { getKolSignalStrength } from "../services/kolService.js";
import { enrichTokenData, getOhlcv } from "../services/dexscreenerService.js";
import { scorePoolRisk, isRuggedCreator } from "../services/riskService.js";
import { getOnChainPoolState, lookupPoolByMint } from "../services/liquidityService.js";

export async function poolRoutes(app: FastifyInstance) {
  // GET /v1/pools — list pools with filters
  app.get("/v1/pools", async (req) => {
    const q = req.query as Record<string, string>;

    const pools = queryPools({
      category: q.category,
      minApr: q.minApr ? Number(q.minApr) : undefined,
      maxRisk: q.maxRisk ? Number(q.maxRisk) : undefined,
      minKol: q.minKol ? Number(q.minKol) : undefined,
      sort: q.sort,
      limit: q.limit ? Number(q.limit) : 20,
    });

    return { pools, count: pools.length };
  });

  // GET /v1/pools/lookup/:mint — derive PumpSwap pool PDA from token mint, fetch on-chain state
  app.get("/v1/pools/lookup/:mint", async (req, reply) => {
    const { mint } = req.params as { mint: string };
    if (!mint || mint.length < 32) {
      return reply.status(400).send({ error: "Invalid token mint address" });
    }

    // First check our DB
    const dbPool = queryPools({ limit: 200 }).find(
      (p: any) => p.token_mint === mint
    );
    if (dbPool) {
      return {
        source: "database",
        poolAddress: dbPool.pool_address,
        tokenMint: mint,
        tokenName: dbPool.token_name,
        tokenSymbol: dbPool.token_symbol,
        currentApr: dbPool.current_apr,
        tvlUsd: dbPool.current_tvl_usd,
        volume24h: dbPool.current_volume_24h,
        marketCapUsd: dbPool.market_cap_usd,
        riskScore: dbPool.risk_score,
        riskTier: dbPool.risk_tier,
        kolCount: dbPool.kol_count,
        createdAt: dbPool.created_at,
        status: dbPool.status,
      };
    }

    // Not in DB — derive PDA and check on-chain
    const onChain = await lookupPoolByMint(mint);
    if (!onChain) {
      return reply.status(404).send({ error: "No PumpSwap pool found for this token" });
    }

    return {
      source: "onchain",
      poolAddress: onChain.poolAddress,
      tokenMint: mint,
      currentApr: onChain.estimatedApr,
      tvlSol: onChain.tvlSol,
      tvlUsd: onChain.liquidityUsd,
      volume24h: onChain.volume24h,
      marketCapUsd: onChain.marketCapUsd,
      createdAt: onChain.createdAt,
      creator: onChain.creator,
      coinCreator: onChain.coinCreator,
      isMayhemMode: onChain.isMayhemMode,
      lpSupply: onChain.lpSupply,
      baseReserve: onChain.baseReserve,
      quoteReserve: onChain.quoteReserve,
    };
  });

  // GET /v1/pools/top — top 10 by composite score
  app.get("/v1/pools/top", async () => {
    const pools = getTopPools();
    return { pools, count: pools.length };
  });

  // GET /v1/pools/:address — full pool detail with risk breakdown
  app.get("/v1/pools/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const pool = getPoolByAddress(address);

    if (!pool) {
      return reply.status(404).send({ error: "Pool not found" });
    }

    // Enrich with live data + pool risk scoring + on-chain state
    const [dexData, kolSignal, chartData, poolRisk, onChainState] = await Promise.all([
      enrichTokenData(pool.token_mint).catch(() => null),
      getKolSignalStrength(pool.token_mint).catch(() => ({
        score: 0,
        eliteCount: 0,
        profitableCount: 0,
      })),
      getOhlcv(pool.token_mint, "1h").catch(() => []),
      scorePoolRisk(pool).catch(() => null),
      getOnChainPoolState(address).catch(() => null),
    ]);

    // UPGRADE 4: Use on-chain creator for blacklist check (more reliable than tx parsing)
    const onChainCreator = onChainState?.creator ?? null;
    const creatorToCheck = onChainCreator ?? pool.creator_wallet;

    // UPGRADE 5: Mayhem mode detection
    const isMayhemMode = onChainState?.isMayhemMode ?? false;

    // UPGRADE 6: Exact APR from on-chain reserves when available
    let exactApr: number | null = null;
    let aprLabel = "est";
    if (onChainState && pool.initial_liquidity_sol && pool.created_at) {
      const currentQuoteSol = parseInt(onChainState.quoteReserve) / 1_000_000_000;
      const initialSol = pool.initial_liquidity_sol;
      // Quote reserve grows as fees accumulate (LP fees go back into reserves)
      // Total pool value in SOL ~ 2x quote reserve
      const currentTotalSol = currentQuoteSol * 2;
      const initialTotalSol = initialSol * 2;
      if (initialTotalSol > 0 && currentTotalSol > initialTotalSol) {
        const poolAge = new Date(pool.created_at + "Z").getTime();
        const daysActive = Math.max(0.01, (Date.now() - poolAge) / 86400000);
        const feeReturn = (currentTotalSol - initialTotalSol) / initialTotalSol;
        exactApr = (feeReturn / daysActive) * 365 * 100;
        aprLabel = "exact";
      }
    }

    // Find similar pools
    const similarPools = queryPools({
      maxRisk: (pool.risk_score ?? 50) + 20,
      limit: 5,
      sort: "score",
    }).filter((p: any) => p.pool_address !== address);

    // Build warnings
    const warnings: string[] = [];
    if (pool.top_lp_pct != null && pool.top_lp_pct >= 80) {
      warnings.push("⚠️ Single LP provider — rug risk");
    }
    if (creatorToCheck && isRuggedCreator(creatorToCheck)) {
      warnings.push("⚠️ Creator previously rugged tokens");
    }
    if (!pool.lp_locked) {
      warnings.push("⚠️ LP tokens not locked");
    }
    if (isMayhemMode) {
      warnings.push("⚡ Mayhem mode active — elevated fee routing risk");
    }

    // Build badges
    const badges: string[] = [];
    if (pool.lp_locked) badges.push("🔒");
    if ((pool.top_lp_pct ?? 0) >= 80) badges.push("👤");
    if (creatorToCheck && isRuggedCreator(creatorToCheck)) badges.push("⚠️");
    if (isMayhemMode) badges.push("⚡");

    // Risk breakdown for display
    const riskDisplay = poolRisk ? {
      score: poolRisk.score,
      tier: poolRisk.tier,
      breakdown: poolRisk.breakdown,
      positiveSignals: poolRisk.positiveSignals,
      recommendation: poolRisk.tier === "dangerous"
        ? "Do not provide liquidity"
        : poolRisk.tier === "risky"
        ? "Proceed with extreme caution"
        : poolRisk.tier === "moderate"
        ? "Exercise caution"
        : "Appears safe",
    } : null;

    return {
      ...pool,
      composite_score: calculateCompositeScore(pool),
      live: dexData
        ? {
            price: dexData.price,
            volume24h: dexData.volume24h,
            liquidity: dexData.liquidity,
            priceChange24h: dexData.priceChange24h,
            fdv: dexData.fdv,
          }
        : null,
      socials: {
        twitter: pool.twitter,
        telegram: pool.telegram,
        website: pool.website,
      },
      kol: {
        count: kolSignal.eliteCount + kolSignal.profitableCount,
        eliteCount: kolSignal.eliteCount,
        profitableCount: kolSignal.profitableCount,
      },
      chart: chartData,
      similar: similarPools.slice(0, 3),
      warnings,
      badges,
      risk: riskDisplay,
      // On-chain state from SDK
      onChain: onChainState ? {
        creator: onChainState.creator,
        coinCreator: onChainState.coinCreator,
        isMayhemMode: onChainState.isMayhemMode,
        isCashbackCoin: onChainState.isCashbackCoin,
        lpSupply: onChainState.lpSupply,
        baseReserve: onChainState.baseReserve,
        quoteReserve: onChainState.quoteReserve,
      } : null,
      apr: {
        value: exactApr ?? pool.current_apr,
        label: aprLabel,
        estimated: pool.current_apr,
        exact: exactApr,
      },
    };
  });
}
