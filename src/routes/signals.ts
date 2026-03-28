import { FastifyInstance } from "fastify";
import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("signals");

interface CacheEntry { data: any; expiry: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30_000;

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

const BONDING_DEXES = new Set(["pumpfun", "pump"]);

function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function interpret(signals: any): { overall: string; confidence: number; reason: string } {
  let bullish = 0;
  let bearish = 0;

  if (signals.momentum > 5) bullish += 2;
  else if (signals.momentum > 0) bullish += 1;
  else if (signals.momentum < -5) bearish += 2;
  else if (signals.momentum < 0) bearish += 1;

  if (signals.buyPressure > 0.65) bullish += 2;
  else if (signals.buyPressure > 0.5) bullish += 1;
  else if (signals.buyPressure < 0.35) bearish += 2;
  else bearish += 1;

  if (signals.volSpike > 2) bullish += 2;
  else if (signals.volSpike > 1) bullish += 1;

  if (signals.trend > 5) bullish += 1;
  else if (signals.trend < -5) bearish += 1;

  if (signals.rsi != null) {
    if (signals.rsi > 70) bearish += 1; // overbought
    else if (signals.rsi < 30) bullish += 1; // oversold bounce
    else if (signals.rsi > 50) bullish += 1;
  }

  if (signals.activity > 20) bullish += 1;

  const total = bullish + bearish;
  const confidence = total > 0 ? Math.round((Math.max(bullish, bearish) / total) * 100) : 50;

  let overall: string;
  let reason: string;

  if (bullish >= bearish + 3) {
    overall = "strong";
    reason = "Strong buying pressure with positive momentum";
  } else if (bullish > bearish) {
    overall = "moderate";
    reason = "Leaning bullish — more buyers than sellers";
  } else if (bearish > bullish + 2) {
    overall = "bearish";
    reason = "Selling pressure dominant, momentum fading";
  } else {
    overall = "weak";
    reason = "Mixed signals, no clear direction";
  }

  if (signals.volSpike > 3) reason += ", volume spike detected";
  if (signals.activity < 3) reason += ", low activity";

  return { overall, confidence, reason };
}

export async function signalRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string } }>(
    "/v1/tokens/:address/signals",
    async (req, reply) => {
      const { address } = req.params;

      const cached = getCached(`signals:${address}`);
      if (cached) return cached;

      try {
        // Fetch DexScreener pair data
        const { data: dexData } = await axios.get(
          `https://api.dexscreener.com/tokens/v1/solana/${address}`,
          { timeout: 6000 },
        );

        const pairs = Array.isArray(dexData) ? dexData : dexData?.pairs ?? [];
        if (!pairs.length) {
          return reply.status(404).send({ error: "No pair data found for this token" });
        }

        const pair = pairs[0];
        const dexId = pair.dexId ?? "";
        const isBonding = BONDING_DEXES.has(dexId);
        const mode = isBonding ? "bonding_curve" : "graduated";

        // Extract DexScreener metrics
        const vol5m = pair.volume?.m5 ?? 0;
        const vol1h = pair.volume?.h1 ?? 0;
        const buys5m = pair.txns?.m5?.buys ?? 0;
        const sells5m = pair.txns?.m5?.sells ?? 0;
        const totalTxns5m = buys5m + sells5m;
        const priceChange5m = pair.priceChange?.m5 ?? 0;
        const priceChange1h = pair.priceChange?.h1 ?? 0;

        // Volume spike: 5m volume vs average 5m (1h / 12)
        const avg5m = vol1h / 12;
        const volSpike = avg5m > 0 ? Math.round((vol5m / avg5m) * 100) / 100 : 0;

        // Buy pressure: ratio of buys to total
        const buyPressure = totalTxns5m > 0 ? Math.round((buys5m / totalTxns5m) * 100) / 100 : 0.5;

        let rsi: number | null = null;
        let pricePosition: number | null = null;

        // MODE 2: graduated — fetch OHLCV for RSI
        if (!isBonding && pair.pairAddress) {
          try {
            const { data: ohlcvResp } = await axios.get(
              `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}/ohlcv/minute`,
              { params: { aggregate: 5, limit: 50, currency: "usd" }, timeout: 6000 },
            );
            const candles = ohlcvResp?.data?.attributes?.ohlcv_list ?? [];
            if (candles.length > 15) {
              const closes = candles.map((c: number[]) => c[4]).reverse();
              rsi = Math.round((computeRSI(closes) ?? 0) * 10) / 10;

              // Price position: where current price sits in recent range (0=low, 100=high)
              const high = Math.max(...closes);
              const low = Math.min(...closes);
              const current = closes[closes.length - 1];
              pricePosition = high > low ? Math.round(((current - low) / (high - low)) * 100) : 50;
            }
          } catch {
            // GeckoTerminal may not have data
          }
        }

        const signals = {
          volSpike,
          momentum: priceChange5m,
          buyPressure,
          trend: priceChange1h,
          activity: totalTxns5m,
          rsi,
          pricePosition,
        };

        const result = {
          address,
          mode,
          dexId,
          signals,
          interpretation: interpret(signals),
        };

        setCache(`signals:${address}`, result);
        return result;
      } catch (err: any) {
        return reply.status(502).send({ error: "Failed to compute signals", message: err.message });
      }
    },
  );
}
