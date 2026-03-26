import axios from "axios";
import { createLogger } from "../utils/logger.js";
import { enrichTokenData } from "./dexscreenerService.js";
import { getMarketScoreModifier } from "./marketService.js";

const log = createLogger("risk");

export interface RiskResult {
  score: number;
  flags: string[];
  tier: "safe" | "moderate" | "risky" | "dangerous";
}

function getTier(score: number): RiskResult["tier"] {
  if (score <= 25) return "safe";
  if (score <= 50) return "moderate";
  if (score <= 75) return "risky";
  return "dangerous";
}

async function getHeliusAsset(tokenAddress: string): Promise<any> {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return null;

  try {
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "risk-asset",
      method: "getAsset",
      params: { id: tokenAddress },
    });
    return data.result ?? null;
  } catch {
    return null;
  }
}

async function getTokenHolders(tokenAddress: string): Promise<any[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.get(
      `https://api.helius.xyz/v1/mintlist?api-key=${apiKey}`,
      { params: { mints: [tokenAddress], limit: 20 } }
    );
    return data ?? [];
  } catch {
    // Fallback: use RPC to get largest accounts
    const rpcUrl = process.env.HELIUS_RPC_URL;
    if (!rpcUrl) return [];
    try {
      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenLargestAccounts",
        params: [tokenAddress],
      });
      return data.result?.value ?? [];
    } catch {
      return [];
    }
  }
}

async function getCreatorTransactions(
  creatorAddress: string
): Promise<any[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${creatorAddress}/transactions?api-key=${apiKey}&limit=10`
    );
    return data ?? [];
  } catch {
    return [];
  }
}

export async function scoreTokenRisk(
  tokenAddress: string
): Promise<RiskResult> {
  let score = 0;
  const flags: string[] = [];

  // Fetch data in parallel
  const [asset, holders, dexData, marketMod] = await Promise.all([
    getHeliusAsset(tokenAddress),
    getTokenHolders(tokenAddress),
    enrichTokenData(tokenAddress),
    getMarketScoreModifier(),
  ]);

  // Token age
  const createdAt = asset?.created_at
    ? new Date(asset.created_at).getTime()
    : null;
  const ageMs = createdAt ? Date.now() - createdAt : null;
  const isFresh = ageMs !== null && ageMs < 3600_000; // < 1 hour
  const isGraduated = dexData.liquidity !== null && dexData.liquidity > 0;

  if (isFresh) {
    // Fresh token checks
    if (ageMs < 300_000) {
      score += 10;
      flags.push("Token age < 5 minutes");
    }

    // Holder concentration
    if (holders.length > 0) {
      const amounts = holders.map((h: any) =>
        parseFloat(h.amount ?? h.uiAmount ?? "0")
      );
      const total = amounts.reduce((s: number, a: number) => s + a, 0);

      if (total > 0) {
        const topPct = (amounts[0] / total) * 100;
        if (topPct > 20) {
          score += 25;
          flags.push("High holder concentration");
        }

        const top5 = amounts.slice(0, 5).reduce((s: number, a: number) => s + a, 0);
        if ((top5 / total) * 100 > 50) {
          score += 20;
          flags.push("Top 5 holders > 50% supply");
        }
      }
    }

    // Creator sold check
    const creator = asset?.authorities?.[0]?.address;
    if (creator) {
      const txns = await getCreatorTransactions(creator);
      const sold = txns.some(
        (tx: any) =>
          tx.type === "TRANSFER" ||
          tx.description?.toLowerCase().includes("sold") ||
          tx.description?.toLowerCase().includes("swap")
      );
      if (sold) {
        score += 30;
        flags.push("Creator sold tokens");
      }
    }

    // Social links
    const hasLinks =
      asset?.content?.links?.external_url ||
      asset?.content?.links?.twitter ||
      asset?.content?.links?.telegram;
    if (!hasLinks) {
      score += 5;
      flags.push("No social links");
    }

    // Volume/mcap ratio
    if (dexData.volume24h !== null && dexData.fdv !== null && dexData.fdv > 0) {
      const ratio = dexData.volume24h / dexData.fdv;
      if (ratio < 0.01) {
        score += 15;
        flags.push("Suspicious volume");
      }
    }
  }

  if (isGraduated) {
    // Graduated token checks
    if (dexData.liquidity !== null && dexData.liquidity < 10_000) {
      score += 30;
      flags.push("Low liquidity");
    }

    if (dexData.volume24h !== null && dexData.volume24h < 1_000) {
      score += 20;
      flags.push("Low volume");
    }

    // Single wallet liquidity concentration
    if (holders.length > 0) {
      const amounts = holders.map((h: any) =>
        parseFloat(h.amount ?? h.uiAmount ?? "0")
      );
      const total = amounts.reduce((s: number, a: number) => s + a, 0);
      if (total > 0 && (amounts[0] / total) * 100 > 30) {
        score += 25;
        flags.push("Single wallet > 30% liquidity");
      }
    }

    // Creator dump at graduation
    const creator = asset?.authorities?.[0]?.address;
    if (creator) {
      const txns = await getCreatorTransactions(creator);
      const dumped = txns.some(
        (tx: any) =>
          tx.description?.toLowerCase().includes("swap") ||
          tx.description?.toLowerCase().includes("sell")
      );
      if (dumped) {
        score += 40;
        flags.push("Creator dumped at graduation");
      }
    }
  }

  // Market modifier
  score += marketMod;

  // Cap at 100
  score = Math.min(100, Math.max(0, score));

  return {
    score,
    flags,
    tier: getTier(score),
  };
}
