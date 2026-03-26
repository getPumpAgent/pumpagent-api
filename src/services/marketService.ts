import { createLogger } from "../utils/logger.js";
import { getTopSolanaPairs } from "./dexscreenerService.js";

const log = createLogger("market");

interface VolumeSnapshot {
  timestamp: number;
  totalVolume: number;
}

interface SentimentResult {
  sentiment: "bullish" | "bearish" | "neutral";
  modifier: number;
  confidence: number;
}

const volumeHistory: VolumeSnapshot[] = [];
const WINDOW_MS = 30 * 60 * 1000; // 30 minutes

let cachedSentiment: SentimentResult | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 60_000;

async function updateVolumeSnapshot(): Promise<number> {
  const pairs = await getTopSolanaPairs();
  const totalVolume = pairs.reduce(
    (sum: number, p: any) => sum + (p.volume?.h1 ?? 0),
    0
  );

  const now = Date.now();
  volumeHistory.push({ timestamp: now, totalVolume });

  // Prune old entries outside the 30-minute window
  const cutoff = now - WINDOW_MS;
  while (volumeHistory.length > 0 && volumeHistory[0].timestamp < cutoff) {
    volumeHistory.shift();
  }

  return totalVolume;
}

function calculateSentiment(): SentimentResult {
  if (volumeHistory.length < 2) {
    return { sentiment: "neutral", modifier: 0, confidence: 0.3 };
  }

  const oldest = volumeHistory[0];
  const newest = volumeHistory[volumeHistory.length - 1];

  if (oldest.totalVolume === 0) {
    return { sentiment: "neutral", modifier: 0, confidence: 0.3 };
  }

  const change =
    (newest.totalVolume - oldest.totalVolume) / oldest.totalVolume;

  let sentiment: SentimentResult["sentiment"] = "neutral";
  let modifier = 0;

  if (change > 0.2) {
    sentiment = "bullish";
    modifier = -5;
  } else if (change < -0.2) {
    sentiment = "bearish";
    modifier = 10;
  }

  const confidence = Math.min(
    1,
    volumeHistory.length / 10 + Math.abs(change)
  );

  return { sentiment, modifier, confidence: parseFloat(confidence.toFixed(2)) };
}

export async function getMarketSentiment(): Promise<SentimentResult> {
  const now = Date.now();
  if (cachedSentiment && now < cacheExpiry) return cachedSentiment;

  await updateVolumeSnapshot();
  cachedSentiment = calculateSentiment();
  cacheExpiry = now + CACHE_TTL;

  return cachedSentiment;
}

export async function getMarketScoreModifier(): Promise<number> {
  const { sentiment } = await getMarketSentiment();
  switch (sentiment) {
    case "bullish":
      return -5;
    case "bearish":
      return 10;
    default:
      return 0;
  }
}
