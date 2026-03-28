import axios from "axios";
import { createLogger } from "../utils/logger.js";
import { enrichTokenData } from "./dexscreenerService.js";

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

async function getTopHolders(tokenAddress: string): Promise<{ amounts: number[]; total: number }> {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return { amounts: [], total: 0 };

  try {
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "holders",
      method: "getTokenLargestAccounts",
      params: [tokenAddress],
    });
    const holders = data.result?.value ?? [];
    const amounts = holders.map((h: any) => {
      const ui = parseFloat(h.uiAmount ?? h.uiAmountString ?? "0");
      return ui > 0 ? ui : parseFloat(h.amount ?? "0");
    });
    const total = amounts.reduce((s: number, a: number) => s + a, 0);
    return { amounts, total };
  } catch {
    return { amounts: [], total: 0 };
  }
}

async function checkCreatorSold(tokenAddress: string, asset: any): Promise<boolean> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return false;

  // Try authorities, then creators
  const creator =
    asset?.authorities?.[0]?.address ??
    asset?.creators?.[0]?.address ??
    null;
  if (!creator) return false;

  try {
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${creator}/transactions?api-key=${apiKey}&limit=10`
    );
    return (data ?? []).some(
      (tx: any) =>
        tx.type === "SWAP" ||
        tx.description?.toLowerCase().includes("sold") ||
        tx.description?.toLowerCase().includes("swap")
    );
  } catch {
    return false;
  }
}

export async function scoreTokenRisk(tokenAddress: string): Promise<RiskResult> {
  let score = 0;
  const flags: string[] = [];

  // Fetch all data in parallel
  const [asset, holders, dexData] = await Promise.all([
    getHeliusAsset(tokenAddress),
    getTopHolders(tokenAddress),
    enrichTokenData(tokenAddress),
  ]);

  // ── HOLDER CONCENTRATION (always check) ──
  if (holders.total > 0) {
    const topPct = (holders.amounts[0] / holders.total) * 100;
    if (topPct >= 99) {
      score += 40;
      flags.push("Single holder — just launched");
    } else if (topPct >= 50) {
      score += 35;
      flags.push(`Whale dominance — top holder owns ${topPct.toFixed(0)}%`);
    } else if (topPct >= 20) {
      score += 25;
      flags.push(`High holder concentration — ${topPct.toFixed(0)}%`);
    } else if (topPct >= 10) {
      score += 10;
      flags.push(`Top holder owns ${topPct.toFixed(0)}%`);
    }

    const top5Sum = holders.amounts.slice(0, 5).reduce((s, a) => s + a, 0);
    const top5Pct = (top5Sum / holders.total) * 100;
    if (top5Pct >= 80) {
      score += 25;
      flags.push(`Top 5 holders own ${top5Pct.toFixed(0)}% of supply`);
    } else if (top5Pct >= 60) {
      score += 20;
      flags.push(`Top 5 holders own ${top5Pct.toFixed(0)}%`);
    } else if (top5Pct >= 50) {
      score += 15;
      flags.push(`Top 5 holders own ${top5Pct.toFixed(0)}%`);
    }
  }

  // ── TOKEN AGE ──
  // Try DexScreener pairCreatedAt since Helius created_at is often null
  let ageSeconds: number | null = null;
  if (asset?.created_at) {
    const ts = new Date(asset.created_at).getTime();
    if (!isNaN(ts)) ageSeconds = Math.floor((Date.now() - ts) / 1000);
  }
  if (ageSeconds == null && dexData.pairCreatedAt) {
    const ts = typeof dexData.pairCreatedAt === "number" ? dexData.pairCreatedAt : new Date(dexData.pairCreatedAt).getTime();
    if (!isNaN(ts)) ageSeconds = Math.floor((Date.now() - ts) / 1000);
  }

  if (ageSeconds != null && ageSeconds < 300) {
    score += 10;
    flags.push("Token under 5 minutes old");
  }

  // ── METADATA QUALITY ──
  const hasName = !!asset?.content?.metadata?.name;
  const hasImage = !!asset?.content?.links?.image;
  if (!hasName || !hasImage) {
    score += 15;
    flags.push("Missing metadata or image");
  }

  // ── NO PAIR DATA (very new bonding curve) ──
  if (dexData.price == null && dexData.liquidity == null) {
    score += 20;
    flags.push("Very new token — no price history");
  }

  // ── LIQUIDITY ──
  if (dexData.liquidity != null && dexData.liquidity < 5_000) {
    score += 20;
    flags.push(`Low liquidity ($${dexData.liquidity.toFixed(0)})`);
  }

  // ── VOLUME ──
  if (dexData.volume24h != null && dexData.volume24h < 1_000) {
    score += 10;
    flags.push("Very low volume");
  }

  // ── CREATOR SOLD ──
  const creatorSold = await checkCreatorSold(tokenAddress, asset);
  if (creatorSold) {
    score += 30;
    flags.push("Creator wallet has sold");
  }

  // Cap at 100
  score = Math.min(100, Math.max(0, score));

  return { score, flags, tier: getTier(score) };
}
