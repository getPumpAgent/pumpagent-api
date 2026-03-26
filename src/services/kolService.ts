import axios from "axios";
import { createLogger } from "../utils/logger.js";

const log = createLogger("kol");

export interface KolWallet {
  address: string;
  label: string;
  winRate: number;
  volumeSol: number;
  tier: "elite" | "profitable" | null;
}

const KOL_WALLETS: Omit<KolWallet, "tier">[] = [
  { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", label: "KOL_Alpha1", winRate: 72, volumeSol: 450 },
  { address: "9aUn5Gyc2JCdFrMqfHPFfZxTJK85Gw2YxGEwmYZ3p6mc", label: "KOL_Whale2", winRate: 68, volumeSol: 320 },
  { address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH", label: "KOL_Degen3", winRate: 66, volumeSol: 280 },
  { address: "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj", label: "KOL_Sniper4", winRate: 64, volumeSol: 210 },
  { address: "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSZa2hPfLRPFr", label: "KOL_Smart5", winRate: 62, volumeSol: 175 },
  { address: "JD2qCFnnYBe98fq7HnEZFqPLscXGQE7Mq27dUZfBpYSd", label: "KOL_Pro6", winRate: 60, volumeSol: 150 },
  { address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", label: "KOL_Trader7", winRate: 58, volumeSol: 130 },
  { address: "Bxp8yhXfRbSqPMx3C9HZcA5j5V7tDHNBxiaPDhKpKsxR", label: "KOL_Flow8", winRate: 57, volumeSol: 115 },
  { address: "FbGeZS8LiPCnnz9mP7zs3sGu2CDvg3mSR1HqPZH3JXSR", label: "KOL_Quick9", winRate: 56, volumeSol: 105 },
  { address: "2Cq2BeLTsNPLJRsTpX98DRjGE7HCzme6fEBnGvtbcAiW", label: "KOL_Gem10", winRate: 55, volumeSol: 95 },
  { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", label: "KOL_Moon11", winRate: 70, volumeSol: 380 },
  { address: "CuieVDEDtLo7FypA946wnMtqFjYBn8GRaBNjgfRelqkm", label: "KOL_Pump12", winRate: 67, volumeSol: 250 },
  { address: "7Ppx8JYkMSJeTGLmDGbzjEH4qS5dWFpoJJdmV1zcuVAg", label: "KOL_Ape13", winRate: 63, volumeSol: 200 },
  { address: "4wQA2yBSmvkFqCqPYGEXkuPBHFG6a5dKVMSBUt3CAj2k", label: "KOL_Fomo14", winRate: 59, volumeSol: 140 },
  { address: "6j5nNrozTJkk1zatiziF47qV7toHt6tkgVfbfRMVspBb", label: "KOL_Based15", winRate: 71, volumeSol: 400 },
  { address: "AYFSHJi4UhdnCuF9bo6pERFshGWgbGqk3MNR7JfcqJEo", label: "KOL_Chad16", winRate: 65, volumeSol: 190 },
  { address: "BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskCH9CYkFwaJ", label: "KOL_Sigma17", winRate: 58, volumeSol: 120 },
  { address: "CVkzbsnwATBDDbGke7o1KzprgDsaKhdET7zioE9ssFXp", label: "KOL_Guru18", winRate: 69, volumeSol: 300 },
  { address: "B9c39CDkaN3X2bgSvHBjGkGruaVLJ2K9oGJ9Xj1UDPDY", label: "KOL_Lord19", winRate: 61, volumeSol: 160 },
  { address: "FxteHm6Sd7G6eNHxpGHxnQQ8ot4dK7fGiDT7JW53pbnL", label: "KOL_Sage20", winRate: 56, volumeSol: 85 },
];

function assignTier(wallet: Omit<KolWallet, "tier">): KolWallet["tier"] {
  if (wallet.winRate >= 65 && wallet.volumeSol >= 100) return "elite";
  if (wallet.winRate >= 55 && wallet.volumeSol >= 50) return "profitable";
  return null;
}

const kolList: KolWallet[] = KOL_WALLETS.map((w) => ({
  ...w,
  tier: assignTier(w),
}));

export function getKolTier(wallet: string): "elite" | "profitable" | null {
  const kol = kolList.find((k) => k.address === wallet);
  return kol?.tier ?? null;
}

export function getKolSignalStrength(tokenMint: string): {
  score: number;
  eliteCount: number;
  profitableCount: number;
} {
  // In a full implementation, this would check on-chain for KOL buys of this token.
  // For now, return base signal with counts from tracked wallets.
  const eliteCount = kolList.filter((k) => k.tier === "elite").length;
  const profitableCount = kolList.filter((k) => k.tier === "profitable").length;

  // Score: up to 30 based on KOL activity (placeholder until real-time tracking)
  const score = Math.min(30, Math.floor((eliteCount * 3 + profitableCount) * 0.5));

  return { score, eliteCount, profitableCount };
}

export async function getKolActivity(): Promise<any[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    log.warn("HELIUS_API_KEY not set, cannot fetch KOL activity");
    return [];
  }

  const url = `https://api.helius.xyz/v0/addresses/transactions?api-key=${apiKey}`;
  const results: any[] = [];

  // Fetch recent signatures for each elite KOL
  const eliteKols = kolList.filter((k) => k.tier === "elite").slice(0, 5);

  for (const kol of eliteKols) {
    try {
      const { data } = await axios.get(
        `https://api.helius.xyz/v0/addresses/${kol.address}/transactions?api-key=${apiKey}&limit=5`
      );

      for (const tx of data ?? []) {
        results.push({
          wallet: kol.address,
          label: kol.label,
          tier: kol.tier,
          signature: tx.signature,
          type: tx.type,
          timestamp: tx.timestamp,
          description: tx.description,
        });
      }
    } catch (err: any) {
      log.warn(`Failed to fetch activity for ${kol.label}: ${err.message}`);
    }
  }

  return results.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export function getKolLeaderboard(): KolWallet[] {
  return [...kolList]
    .filter((k) => k.tier !== null)
    .sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return b.volumeSol - a.volumeSol;
    });
}

export async function getKolTrades(wallet: string): Promise<any[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=20`
    );
    return (data ?? []).map((tx: any) => ({
      signature: tx.signature,
      type: tx.type,
      timestamp: tx.timestamp,
      description: tx.description,
    }));
  } catch (err: any) {
    log.warn(`Failed to fetch trades for ${wallet}: ${err.message}`);
    return [];
  }
}
