import { FastifyInstance } from "fastify";
import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  OnlinePumpSdk,
  bondingCurvePda,
  bondingCurveMarketCap,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import * as dex from "../services/dexscreenerService.js";
import { scoreTokenRisk } from "../services/riskService.js";
import { getKolSignalStrength } from "../services/kolService.js";
import { createLogger } from "../utils/logger.js";
import {
  getTokenOHLCV as stGetOHLCV,
  getTokenInsights as stGetInsights,
  getFirstBuyers as stGetFirstBuyers,
  isConfigured as stConfigured,
  getGraduatingTokens as stGetGraduating,
  getGraduatedTokens as stGetGraduated,
} from "../services/solanaTrackerService.js";
import {
  getAccumulatedGraduating as accGetGraduating,
  getAccumulatedGraduated as accGetGraduated,
  getAccumulatedHot as accGetHot,
} from "../services/tokenAccumulator.js";
import { getCached, setCache, TTL, checkHeliusLimit } from "../utils/heliusCache.js";

const log = createLogger("tokens");
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Bonding curve graduates at ~85 SOL real reserves (varies slightly)
const GRADUATION_SOL_THRESHOLD = 85 * 1_000_000_000; // lamports

export async function tokenRoutes(app: FastifyInstance) {
  // Newest PumpFun token launches — fresh from Helius, no caching
  // New tokens — from WebSocket accumulator (free, no Helius credits)
  app.get("/v1/tokens/new", async () => {
    const { getAccumulatedFresh } = await import("../services/tokenAccumulator.js");
    const fresh = getAccumulatedFresh(20);
    const nowMs = Date.now();
    const tokens = fresh.map((raw: any) => {
      const token = raw.token || raw;
      const created = token.creation?.created_time || 0;
      const createdMs = created > 1e12 ? created : created * 1000;
      return {
        mint: token.mint || raw.mint,
        name: token.name || raw.name || null,
        symbol: token.symbol || raw.symbol || null,
        image: token.image || raw.image || null,
        createdAt: createdMs || null,
        age: createdMs ? Math.floor((nowMs - createdMs) / 1000) : null,
      };
    });
    return { tokens };
  });

  // Trending: DexScreener top Solana pairs + PumpFun
  app.get("/v1/tokens/trending", async (_req, reply) => {
    try {
      const pairs = await dex.getTopSolanaPairs();
      return {
        pairs: pairs.slice(0, 20).map((p: any) => ({
          tokenAddress: p.baseToken?.address,
          name: p.baseToken?.name,
          symbol: p.baseToken?.symbol,
          price: p.priceUsd,
          volume24h: p.volume?.h24,
          priceChange24h: p.priceChange?.h24,
          liquidity: p.liquidity?.usd,
          pairAddress: p.pairAddress,
        })),
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch trending", message: err.message });
    }
  });

  // Graduating: tokens near 100% bonding curve — reads actual on-chain state
  app.get("/v1/tokens/graduating", async (_req, reply) => {
    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const connection = new Connection(rpcUrl, "confirmed");
      const pumpSdk = new OnlinePumpSdk(connection);

      // Step 1: Fetch recent PumpFun tokens via Helius DAS
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "pump-graduating",
        method: "getAssetsByAuthority",
        params: {
          authorityAddress: PUMPFUN_PROGRAM,
          page: 1,
          limit: 50,
          sortBy: { sortBy: "created", sortDirection: "desc" },
          displayOptions: { showFungible: true },
        },
      });

      const items = data.result?.items ?? [];
      if (!items.length) return { tokens: [] };

      // Step 2: Read bonding curve state for each token on-chain
      const candidates: any[] = [];
      const batchSize = 10;
      for (let i = 0; i < Math.min(items.length, 50); i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (item: any) => {
            const mint = new PublicKey(item.id);
            const bcPda = bondingCurvePda(mint);
            const accountInfo = await connection.getAccountInfo(bcPda);
            if (!accountInfo) return null;

            const bc = PUMP_SDK.decodeBondingCurveNullable(accountInfo);
            if (!bc || bc.complete) return null; // skip already graduated

            // Calculate completion %: realSolReserves / graduation threshold
            const realSol = bc.realSolReserves.toNumber();
            const completionPct = Math.min(100, (realSol / GRADUATION_SOL_THRESHOLD) * 100);

            // Only include tokens > 50% complete
            if (completionPct < 50) return null;

            const mcap = bondingCurveMarketCap({
              mintSupply: bc.tokenTotalSupply,
              virtualSolReserves: bc.virtualSolReserves,
              virtualTokenReserves: bc.virtualTokenReserves,
            });

            return {
              mint: item.id,
              name: item.content?.metadata?.name ?? null,
              symbol: item.content?.metadata?.symbol ?? null,
              image: item.content?.links?.image ?? null,
              createdAt: item.created_at ?? null,
              bondingCurve: {
                completionPct: parseFloat(completionPct.toFixed(1)),
                realSolReserves: realSol / 1_000_000_000,
                virtualSolReserves: bc.virtualSolReserves.toNumber() / 1_000_000_000,
                virtualTokenReserves: bc.virtualTokenReserves.toString(),
                marketCapLamports: mcap.toString(),
                complete: bc.complete,
              },
            };
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) candidates.push(r.value);
        }
      }

      // Sort by completion % descending (closest to graduating first)
      candidates.sort((a, b) => b.bondingCurve.completionPct - a.bondingCurve.completionPct);

      // Enrich top 10 with DEX data
      const top = candidates.slice(0, 10);
      const enriched = await Promise.all(
        top.map(async (token) => {
          const dexData = await dex.enrichTokenData(token.mint).catch(() => null);
          return {
            ...token,
            price: dexData?.price ?? null,
            volume24h: dexData?.volume24h ?? null,
            liquidity: dexData?.liquidity ?? null,
            fdv: dexData?.fdv ?? null,
          };
        })
      );

      return { tokens: enriched };
    } catch (err: any) {
      log.error({ err: err.message }, "Graduating fetch failed");
      return reply.status(502).send({ error: "Failed to fetch graduating tokens", message: err.message });
    }
  });

  // Boosted tokens
  app.get("/v1/tokens/boosted", async (_req, reply) => {
    try {
      const boosted = await dex.getBoostedTokens();
      return { tokens: boosted };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch boosted tokens", message: err.message });
    }
  });

  // Search
  app.get("/v1/tokens/search", async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q) {
      return reply.status(400).send({ error: "Query parameter 'q' is required" });
    }

    try {
      const results = await dex.searchTokens(q);
      return results;
    } catch (err: any) {
      return reply.status(502).send({ error: "Search failed", message: err.message });
    }
  });

  // Token detail
  app.get("/v1/tokens/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const rpcUrl = process.env.HELIUS_RPC_URL;

    try {
      // Fetch metadata, dex data, risk, KOL signal, and ST insights in parallel
      const [asset, dexData, risk, kolSignal, stData] = await Promise.all([
        rpcUrl
          ? axios
              .post(rpcUrl, {
                jsonrpc: "2.0",
                id: "token-detail",
                method: "getAsset",
                params: { id: address },
              })
              .then((r) => r.data.result)
              .catch(() => null)
          : Promise.resolve(null),
        dex.enrichTokenData(address),
        scoreTokenRisk(address),
        getKolSignalStrength(address),
        stGetInsights(address),
      ]);

      return {
        mint: address,
        name: asset?.content?.metadata?.name ?? stData.name ?? null,
        symbol: asset?.content?.metadata?.symbol ?? stData.symbol ?? null,
        image: asset?.content?.links?.image ?? stData.image ?? null,
        uri: asset?.content?.json_uri ?? null,
        createdAt: asset?.created_at ?? null,
        // Use DexScreener for price/volume/liquidity (more reliable), ST as fallback
        price: dexData.price ?? stData.priceUsd ?? null,
        volume24h: dexData.volume24h ?? stData.volume_24h ?? null,
        liquidity: dexData.liquidity ?? stData.liquidityUsd ?? null,
        priceChange24h: dexData.priceChange24h,
        fdv: dexData.fdv ?? stData.marketCapUsd ?? null,
        risk,
        kolSignal,
        // Enrichment from Solana Tracker (fields DexScreener lacks)
        holders: stData.holders || null,
        socials: stData.socials || { twitter: null, telegram: null, website: null },
        hasSocials: stData.hasSocials || false,
        stRiskScore: stData.riskScore || null,
        deployer: stData.deployer || null,
        poolAddress: stData.poolAddress || null,
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch token detail", message: err.message });
    }
  });

  // Risk score
  app.get("/v1/tokens/:address/risk", async (req, reply) => {
    const { address } = req.params as { address: string };
    try {
      const risk = await scoreTokenRisk(address);
      return { mint: address, risk };
    } catch (err: any) {
      return reply.status(502).send({ error: "Risk scoring failed", message: err.message });
    }
  });

  // OHLCV candles — GeckoTerminal (free) for graduated, Solana Tracker for bonding curve only
  app.get("/v1/tokens/:address/ohlcv", async (req, reply) => {
    const { address } = req.params as { address: string };
    const { interval, timeframe } = req.query as { interval?: string; timeframe?: string };
    const validIntervals = ["1s", "1m", "5m", "15m", "1h", "4h", "1d"];
    const iv = validIntervals.includes(timeframe ?? interval ?? "") ? (timeframe ?? interval!) : "1m";

    // Step 1: Try GeckoTerminal (free, works for graduated tokens with DEX pools)
    let geckoCandles: any[] = [];
    try {
      geckoCandles = await dex.getOhlcv(address, iv) || [];
      if (geckoCandles.length >= 10) {
        return { mint: address, timeframe: iv, source: "geckoterminal", candles: geckoCandles };
      }
    } catch (e: any) {
      log.debug({ err: e.message }, "GeckoTerminal OHLCV failed");
    }

    // Step 2: Solana Tracker — for bonding curve tokens or when GeckoTerminal has too few candles
    if (stConfigured()) {
      try {
        const candles = await stGetOHLCV(address, iv);
        if (candles && candles.length > geckoCandles.length) {
          return { mint: address, timeframe: iv, source: "solanatracker", candles };
        }
      } catch (e: any) {
        log.debug({ err: e.message }, "Solana Tracker OHLCV failed");
      }
    }

    // Step 3: Return whatever we have (GeckoTerminal partial data, or empty)
    return { mint: address, timeframe: iv, source: geckoCandles.length ? "geckoterminal" : "none", candles: geckoCandles };
  });

  // Holders
  app.get("/v1/tokens/:address/holders", async (req, reply) => {
    const { address } = req.params as { address: string };
    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenLargestAccounts",
        params: [address],
      });

      const holders = data.result?.value ?? [];
      const amounts = holders.map((h: any) => parseFloat(h.uiAmount ?? "0"));
      const total = amounts.reduce((s: number, a: number) => s + a, 0);

      return {
        mint: address,
        holders: holders.map((h: any, i: number) => ({
          address: h.address,
          amount: h.uiAmount,
          percentage: total > 0 ? parseFloat(((amounts[i] / total) * 100).toFixed(2)) : 0,
        })),
        concentration: {
          top1: total > 0 ? parseFloat(((amounts[0] / total) * 100).toFixed(2)) : 0,
          top5: total > 0
            ? parseFloat(
                ((amounts.slice(0, 5).reduce((s: number, a: number) => s + a, 0) / total) * 100).toFixed(2)
              )
            : 0,
          top10: total > 0
            ? parseFloat(
                ((amounts.slice(0, 10).reduce((s: number, a: number) => s + a, 0) / total) * 100).toFixed(2)
              )
            : 0,
        },
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch holders", message: err.message });
    }
  });

  // Transactions
  app.get("/v1/tokens/:address/txns", async (req, reply) => {
    const { address } = req.params as { address: string };
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      return reply.status(500).send({ error: "Helius credentials not configured" });
    }

    try {
      const { data } = await axios.get(
        `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=20`
      );

      return {
        mint: address,
        transactions: (data ?? []).map((tx: any) => ({
          signature: tx.signature,
          type: tx.type,
          timestamp: tx.timestamp,
          description: tx.description,
          fee: tx.fee,
        })),
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch transactions", message: err.message });
    }
  });

  // Insiders / first buyers — Solana Tracker
  app.get("/v1/tokens/:address/insiders", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!stConfigured()) {
      return reply.status(503).send({ error: "Solana Tracker not configured" });
    }
    try {
      const buyers = await stGetFirstBuyers(address);
      const buyersList = Array.isArray(buyers) ? buyers : [];
      // Detect suspicious patterns: many early buyers with similar amounts
      let suspiciousPattern = false;
      let reason = "";
      if (buyersList.length >= 5) {
        const early = buyersList.slice(0, 20);
        const holdingAll = early.filter((b: any) => b.holding > 0).length;
        const soldAll = early.filter((b: any) => b.sold > 0 && b.holding === 0).length;
        if (soldAll > early.length * 0.7) {
          suspiciousPattern = true;
          reason = `${soldAll} of first ${early.length} buyers have sold everything — possible coordinated dump`;
        }
        // Check for similar buy amounts (within 10%)
        const amounts = early.map((b: any) => b.first_buy?.amount ?? 0).filter((a: number) => a > 0);
        if (amounts.length >= 5) {
          const avg = amounts.reduce((s: number, a: number) => s + a, 0) / amounts.length;
          const similar = amounts.filter((a: number) => Math.abs(a - avg) / avg < 0.1).length;
          if (similar > amounts.length * 0.6) {
            suspiciousPattern = true;
            reason = `${similar} of ${amounts.length} early buys have similar amounts — possible bot/bundle`;
          }
        }
      }
      return {
        buyers: buyersList.slice(0, 100).map((b: any) => ({
          wallet: b.wallet,
          amountSol: b.total_invested ?? 0,
          currentPnlSol: b.total ?? 0,
          currentPnlUsd: b.realized + b.unrealized,
          stillHolding: b.holding > 0,
          firstBuyTime: b.first_buy_time,
        })),
        suspiciousPattern,
        reason,
        total: buyersList.length,
      };
    } catch (err: any) {
      return reply.status(502).send({ error: "Failed to fetch insiders", message: err.message });
    }
  });

  // ── Token risk scan via Solana Tracker (24h SQLite cache) ──
  app.get("/v1/tokens/:address/scan", async (req, reply) => {
    const { address } = req.params as { address: string };
    try {
      const insights = await stGetInsights(address);
      return insights;
    } catch (err: any) {
      return reply.status(502).send({ error: "Scan failed", message: err.message });
    }
  });

  // ── Trenches pre-population: WebSocket accumulator only (no stale REST data) ──

  app.get("/v1/tokens/st-graduating", async () => {
    return accGetGraduating(20);
  });

  app.get("/v1/tokens/st-graduated", async () => {
    return accGetGraduated(20);
  });
}
