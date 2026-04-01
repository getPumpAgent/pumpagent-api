import axios from "axios";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";
import { enrichTokenData } from "./dexscreenerService.js";
import { getTokenInsights, isConfigured as stConfigured } from "./solanaTrackerService.js";
import { getCached, setCache, TTL, checkHeliusLimit } from "../utils/heliusCache.js";

const log = createLogger("risk");

// ── TYPES ──

export interface RiskResult {
  score: number;
  flags: string[];
  tier: "safe" | "moderate" | "risky" | "dangerous";
}

export interface PoolRiskResult extends RiskResult {
  breakdown: RiskBreakdownItem[];
  positiveSignals: string[];
}

export interface RiskBreakdownItem {
  icon: string;          // ❌ ⚠️ ✅
  label: string;
  points: number;        // positive = risk, negative = safe signal
}

// ── TIERS ──

function getTier(score: number): RiskResult["tier"] {
  if (score <= 25) return "safe";
  if (score <= 50) return "moderate";
  if (score <= 75) return "risky";
  return "dangerous";
}

// ── HELIUS HELPERS ──

async function getHeliusAsset(tokenAddress: string): Promise<any> {
  const cacheKey = `getAsset:${tokenAddress}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return null;

  try {
    checkHeliusLimit();
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "risk-asset",
      method: "getAsset",
      params: { id: tokenAddress },
    });
    const result = data.result ?? null;
    if (result) setCache(cacheKey, result, TTL.getAsset);
    return result;
  } catch {
    return null;
  }
}

async function getTopHolders(tokenAddress: string): Promise<{ amounts: number[]; total: number; addresses: string[] }> {
  const cacheKey = `holders:${tokenAddress}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return { amounts: [], total: 0, addresses: [] };

  try {
    checkHeliusLimit();
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
    const addresses = holders.map((h: any) => h.address ?? "");
    const total = amounts.reduce((s: number, a: number) => s + a, 0);
    const result = { amounts, total, addresses };
    setCache(cacheKey, result, TTL.getTokenLargestAccounts);
    return result;
  } catch {
    return { amounts: [], total: 0, addresses: [] };
  }
}

function getCreatorFromAsset(asset: any): string | null {
  return (
    asset?.authorities?.[0]?.address ??
    asset?.creators?.[0]?.address ??
    null
  );
}

async function checkCreatorSold(tokenAddress: string, asset: any): Promise<boolean> {
  const creator = getCreatorFromAsset(asset);
  if (!creator) return false;

  const cacheKey = `creatorSold:${creator}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return false;

  try {
    checkHeliusLimit();
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${creator}/transactions?api-key=${apiKey}&limit=10`
    );
    const result = (data ?? []).some(
      (tx: any) =>
        tx.type === "SWAP" ||
        tx.description?.toLowerCase().includes("sold") ||
        tx.description?.toLowerCase().includes("swap")
    );
    setCache(cacheKey, result, TTL.transactionHistory);
    return result;
  } catch {
    return false;
  }
}

// ── RUGGED CREATOR CHECK ──

const checkRuggedCreator = db.prepare(
  "SELECT * FROM rugged_creators WHERE wallet_address = ?"
);

export function isRuggedCreator(wallet: string): boolean {
  return !!checkRuggedCreator.get(wallet);
}

// ── BUNDLE DETECTION ──

async function detectBundle(tokenAddress: string): Promise<boolean> {
  const cacheKey = `bundle:${tokenAddress}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return false;

  try {
    checkHeliusLimit();
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${tokenAddress}/transactions?api-key=${apiKey}&limit=10`
    );
    const txs = data ?? [];
    if (txs.length < 5) return false;

    // Group by slot (same block)
    const slotBuyers = new Map<number, Set<string>>();
    for (const tx of txs) {
      if (tx.type !== "SWAP" && !tx.description?.toLowerCase().includes("buy")) continue;
      const slot = tx.slot;
      if (!slot) continue;
      if (!slotBuyers.has(slot)) slotBuyers.set(slot, new Set());
      const feePayer = tx.feePayer ?? tx.source ?? "";
      if (feePayer) slotBuyers.get(slot)!.add(feePayer);
    }

    // If > 5 unique wallets bought in same block = bundled
    for (const [, buyers] of slotBuyers) {
      if (buyers.size > 5) { setCache(cacheKey, true, TTL.transactionHistory); return true; }
    }
    setCache(cacheKey, false, TTL.transactionHistory);
    return false;
  } catch {
    return false;
  }
}

// ── WASH TRADING DETECTION ──

async function detectWashTrading(tokenAddress: string): Promise<boolean> {
  const cacheKey = `wash:${tokenAddress}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return false;

  try {
    checkHeliusLimit();
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${tokenAddress}/transactions?api-key=${apiKey}&limit=50`
    );
    const txs = data ?? [];

    const buyers = new Set<string>();
    const sellers = new Set<string>();

    for (const tx of txs) {
      const wallet = tx.feePayer ?? tx.source ?? "";
      if (!wallet) continue;
      const desc = (tx.description ?? "").toLowerCase();
      if (desc.includes("buy") || desc.includes("swap")) buyers.add(wallet);
      if (desc.includes("sell") || desc.includes("sold")) sellers.add(wallet);
    }

    let washCount = 0;
    for (const w of buyers) {
      if (sellers.has(w)) washCount++;
    }
    const result = washCount >= 2;
    setCache(cacheKey, result, TTL.transactionHistory);
    return result;
  } catch {
    return false;
  }
}

// ── CREATOR WALLET AGE ──

async function getCreatorWalletAge(creatorWallet: string): Promise<number | null> {
  const cacheKey = `walletAge:${creatorWallet}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || !creatorWallet) return null;

  try {
    checkHeliusLimit();
    const { data } = await axios.get(
      `https://api.helius.xyz/v0/addresses/${creatorWallet}/transactions?api-key=${apiKey}&limit=1&before=`
    );
    const txs = data ?? [];
    if (!txs.length) return null;
    const oldest = txs[txs.length - 1];
    if (!oldest.timestamp) return null;
    const age = Math.floor((Date.now() / 1000 - oldest.timestamp));
    setCache(cacheKey, age, TTL.transactionHistory);
    return age;
  } catch {
    return null;
  }
}

// ── SOCIAL VERIFICATION ──

async function verifySocials(twitter: string | null, telegram: string | null): Promise<{
  twitterValid: boolean;
  telegramValid: boolean;
}> {
  let twitterValid = false;
  let telegramValid = false;

  if (twitter) {
    try {
      const resp = await axios.head(twitter, { timeout: 5000, maxRedirects: 3 });
      twitterValid = resp.status >= 200 && resp.status < 400;
    } catch {
      twitterValid = false;
    }
  }

  if (telegram) {
    try {
      const resp = await axios.head(telegram, { timeout: 5000, maxRedirects: 3 });
      telegramValid = resp.status >= 200 && resp.status < 400;
    } catch {
      telegramValid = false;
    }
  }

  return { twitterValid, telegramValid };
}

// ══════════════════════════════════════════════
// TOKEN RISK SCORING
// ══════════════════════════════════════════════

export async function scoreTokenRisk(tokenAddress: string): Promise<RiskResult> {
  let score = 0;
  const flags: string[] = [];

  // Fetch DexScreener data (free) + ST insights (cached 24h, 1 credit per new token)
  const dexData = await enrichTokenData(tokenAddress);

  // ── DEX DATA CHECKS ──

  // No pair data (very new bonding curve)
  if (dexData.price == null && dexData.liquidity == null) {
    score += 20;
    flags.push("Very new token — no price history");
  }

  // Liquidity
  if (dexData.liquidity != null && dexData.liquidity < 5_000) {
    score += 20;
    flags.push(`Low liquidity ($${dexData.liquidity.toFixed(0)})`);
  }

  // Volume
  if (dexData.volume24h != null && dexData.volume24h < 1_000) {
    score += 10;
    flags.push("Very low volume");
  }

  // Price spike
  if (dexData.priceChange24h != null && dexData.priceChange24h > 500) {
    score += 15;
    flags.push(`Extreme price spike — ${dexData.priceChange24h.toFixed(0)}% change`);
  }

  // Sell pressure
  if (dexData.priceChange24h != null && dexData.priceChange24h < -65) {
    score += 10;
    flags.push("High sell pressure detected");
  }

  // Token age from DexScreener
  if (dexData.pairCreatedAt) {
    const ts = typeof dexData.pairCreatedAt === "number" ? dexData.pairCreatedAt : new Date(dexData.pairCreatedAt).getTime();
    if (!isNaN(ts)) {
      const ageSeconds = Math.floor((Date.now() - ts) / 1000);
      if (ageSeconds < 300) { score += 10; flags.push("Token under 5 minutes old"); }
      else if (ageSeconds < 3600) { score += 10; flags.push("Token under 1 hour old"); }
      else if (ageSeconds > 86400) { score -= 10; }
    }
  }

  // ── CREATOR SOLD CHECK (Helius — only on-chain way to verify this) ──
  // Only check if we have creator from ST data, uses cached Helius calls
  let stData: any = null;
  if (stConfigured()) {
    try { stData = await getTokenInsights(tokenAddress); } catch {}
  }
  if (stData?.deployer) {
    const creator = stData.deployer;
    if (isRuggedCreator(creator)) {
      score += 60;
      flags.push("Creator previously rugged tokens");
    }
    const creatorSold = await checkCreatorSold(tokenAddress, { authorities: [{ address: creator }] });
    if (creatorSold) {
      score += 30;
      flags.push("Creator wallet has sold");
    }
  }

  // ── SOLANA TRACKER ENRICHMENT (replaces Helius getAsset/holders/bundle/wash) ──
  if (stConfigured()) {
    try {
      const st = await getTokenInsights(tokenAddress);

      // CRITICAL: Bundlers
      if (st.bundlers.percentage > 15) {
        score += 40;
        flags.push(`Heavy bundle activity — ${st.bundlers.count} bundlers (${st.bundlers.percentage.toFixed(0)}%)`);
      } else if (st.bundlers.percentage > 5) {
        score += 25;
        flags.push(`Bundle detected — ${st.bundlers.count} bundlers (${st.bundlers.percentage.toFixed(0)}%)`);
      } else if (st.bundlers.count > 0) {
        score += Math.min(45, st.bundlers.count * 15);
        flags.push(`${st.bundlers.count} bundler wallet(s) detected`);
      }

      // CRITICAL: Insiders
      if (st.insiders > 30) {
        score += 45;
        flags.push(`Insider dominated — ${st.insiders} insider wallets`);
      } else if (st.insiders > 15) {
        score += 30;
        flags.push(`Heavy insider activity — ${st.insiders} wallets`);
      } else if (st.insiders > 5) {
        score += 15;
        flags.push(`${st.insiders} insider wallets detected`);
      }

      // HIGH: Snipers
      if (st.snipers > 25) {
        score += 25;
        flags.push(`Sniper dominated — ${st.snipers} snipers`);
      } else if (st.snipers > 10) {
        score += 15;
        flags.push(`High sniper concentration — ${st.snipers}`);
      }

      // HIGH: Dev holding
      if (st.dev > 50) {
        score += 40;
        flags.push(`Dev controls ${st.dev.toFixed(0)}% of supply`);
      } else if (st.dev > 20) {
        score += 20;
        flags.push(`Dev holds ${st.dev.toFixed(0)}%`);
      }

      // HIGH: Authorities
      if (st.mintAuthority) {
        score += 20;
        flags.push("Mint authority active — can inflate supply");
      }
      if (st.freezeAuthority) {
        score += 15;
        flags.push("Freeze authority active — can freeze accounts");
      }

      // MEDIUM: Top 10 concentration
      if (st.top10 > 80) {
        score += 25;
        flags.push(`Top 10 own ${st.top10.toFixed(0)}% of supply`);
      } else if (st.top10 > 50) {
        score += 10;
        flags.push(`Top 10 hold ${st.top10.toFixed(0)}%`);
      }

      // POSITIVE signals
      if (st.lpBurn === 100) {
        score -= 20;
        flags.push("LP fully burned");
      } else if (st.lpBurn > 50) {
        score -= 10;
      }
      if (st.status === "graduated") {
        score -= 10;
        flags.push("Survived bonding curve");
      }
      if (!st.freezeAuthority) score -= 5;
      if (!st.mintAuthority) score -= 5;
      if (st.insiders === 0) {
        score -= 5;
        flags.push("No insider wallets detected");
      }
      if (st.bundlers.count === 0) {
        score -= 5;
        flags.push("No bundles detected");
      }
      if (st.rugged) {
        score = 100;
        flags.push("Token confirmed rugged by Solana Tracker");
      }
    } catch (e: any) {
      log.debug({ err: e.message, token: tokenAddress }, "Solana Tracker enrichment failed (skipped)");
    }
  }

  // Cap at 0-100
  score = Math.min(100, Math.max(0, score));

  return { score, flags, tier: getTier(score) };
}

// ══════════════════════════════════════════════
// POOL RISK SCORING (NEW)
// ══════════════════════════════════════════════

export async function scorePoolRisk(pool: any): Promise<PoolRiskResult> {
  let score = 0;
  const flags: string[] = [];
  const breakdown: RiskBreakdownItem[] = [];
  const positiveSignals: string[] = [];

  // ── CRITICAL: Creator previously rugged (check on-chain creator first) ──
  const creatorToCheck = pool.onchain_creator ?? pool.creator_wallet;
  if (creatorToCheck && isRuggedCreator(creatorToCheck)) {
    score += 60;
    const item = { icon: "❌", label: "Creator previously rugged tokens", points: 60 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── MAYHEM MODE: elevated fee routing risk ──
  if (pool.is_mayhem_mode) {
    score += 15;
    const item = { icon: "⚠️", label: "Mayhem mode active — fee routing may change", points: 15 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── CRITICAL: Single LP provider > 90% ──
  const topLpPct = pool.top_lp_pct ?? 0;
  if (topLpPct >= 90) {
    score += 50;
    const item = { icon: "❌", label: `Single LP provider (controls ${topLpPct.toFixed(0)}%)`, points: 50 };
    breakdown.push(item);
    flags.push(item.label);
  } else if (topLpPct >= 80) {
    score += 30;
    const item = { icon: "❌", label: `Dominant LP provider (controls ${topLpPct.toFixed(0)}%)`, points: 30 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── CRITICAL: LP not locked ──
  if (!pool.lp_locked) {
    score += 30;
    const item = { icon: "❌", label: "LP not locked", points: 30 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── HIGH RISK: Pool age ──
  const poolAge = pool.created_at
    ? (Date.now() - new Date(pool.created_at + "Z").getTime()) / 1000
    : null;

  if (poolAge != null && poolAge < 1800) {
    score += 20;
    const mins = Math.floor(poolAge / 60);
    const item = { icon: "❌", label: `Pool age: ${mins} minutes`, points: 20 };
    breakdown.push(item);
    flags.push(item.label);
  } else if (poolAge != null && poolAge < 7200) {
    score += 10;
    const hrs = (poolAge / 3600).toFixed(1);
    const item = { icon: "⚠️", label: `Pool age: ${hrs} hours`, points: 10 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── HIGH RISK: Liquidity drops ──
  const prevTvl = pool.prev_tvl_usd ?? pool.current_tvl_usd ?? 0;
  const currTvl = pool.current_tvl_usd ?? 0;
  if (prevTvl > 0) {
    const dropPct = ((prevTvl - currTvl) / prevTvl) * 100;
    if (dropPct > 50) {
      score += 40;
      const item = { icon: "❌", label: `Liquidity dropped ${dropPct.toFixed(0)}% in last hour`, points: 40 };
      breakdown.push(item);
      flags.push(item.label);
    } else if (dropPct > 20) {
      score += 25;
      const item = { icon: "❌", label: `Liquidity dropped ${dropPct.toFixed(0)}% in last hour`, points: 25 };
      breakdown.push(item);
      flags.push(item.label);
    }
  }

  // ── HIGH RISK: Few LP providers ──
  const lpCount = pool.lp_provider_count ?? 1;
  if (lpCount <= 2) {
    score += 20;
    const item = { icon: "❌", label: `Only ${lpCount} LP provider(s)`, points: 20 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── HIGH RISK: Volume/Liquidity ratio > 50x (wash trading signal) ──
  const vol = pool.current_volume_24h ?? 0;
  const tvl = pool.current_tvl_usd ?? 0;
  if (tvl > 0 && vol / tvl > 50) {
    score += 15;
    const ratio = (vol / tvl).toFixed(0);
    const item = { icon: "⚠️", label: `Volume/liquidity ratio ${ratio}x (wash trading signal)`, points: 15 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── MEDIUM: No socials ──
  if (!pool.twitter && !pool.telegram) {
    score += 10;
    const item = { icon: "⚠️", label: "No verified socials", points: 10 };
    breakdown.push(item);
    flags.push(item.label);
  }

  // ── POSITIVE SIGNALS ──

  // LP locked in verified contract
  if (pool.lp_locked) {
    score -= 20;
    const item = { icon: "✅", label: "LP locked in verified contract", points: -20 };
    breakdown.push(item);
    positiveSignals.push(item.label);
  }

  // Multiple LP providers (5+)
  if (lpCount >= 5) {
    score -= 15;
    const item = { icon: "✅", label: `${lpCount} LP providers`, points: -15 };
    breakdown.push(item);
    positiveSignals.push(item.label);
  }

  // Consistent volume > 6 hours
  if (poolAge != null && poolAge > 6 * 3600 && vol > 5000) {
    score -= 15;
    const item = { icon: "✅", label: "Consistent volume > 6 hours", points: -15 };
    breakdown.push(item);
    positiveSignals.push(item.label);
  }

  // KOL wallets providing LP
  if ((pool.kol_count ?? 0) > 0) {
    score -= 10;
    const item = { icon: "✅", label: `${pool.kol_count} KOL wallets active`, points: -10 };
    breakdown.push(item);
    positiveSignals.push(item.label);
  }

  // Verified socials (both twitter + telegram)
  if (pool.twitter && pool.telegram) {
    score -= 5;
    const item = { icon: "✅", label: "Verified socials (Twitter + Telegram)", points: -5 };
    breakdown.push(item);
    positiveSignals.push(item.label);
  }

  // Token age > 24h
  if (poolAge != null && poolAge > 86400) {
    score -= 10;
    const item = { icon: "✅", label: "Pool age > 24 hours", points: -10 };
    breakdown.push(item);
    positiveSignals.push(item.label);
  }

  // Cap at 0-100
  score = Math.min(100, Math.max(0, score));
  const tier = getTier(score);

  return { score, flags, tier, breakdown, positiveSignals };
}

// ══════════════════════════════════════════════
// LP TOKEN DISTRIBUTION CHECK
// ══════════════════════════════════════════════

export async function getLpDistribution(poolAddress: string): Promise<{
  topLpPct: number;
  lpProviderCount: number;
  lpLocked: boolean;
}> {
  const cacheKey = `lpDist:${poolAddress}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return { topLpPct: 0, lpProviderCount: 0, lpLocked: false };

  try {
    checkHeliusLimit();
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "lp-holders",
      method: "getTokenLargestAccounts",
      params: [poolAddress],
    });
    const holders = data.result?.value ?? [];
    if (!holders.length) return { topLpPct: 0, lpProviderCount: 0, lpLocked: false };

    const amounts = holders.map((h: any) => parseFloat(h.uiAmountString ?? h.amount ?? "0"));
    const total = amounts.reduce((s: number, a: number) => s + a, 0);

    const topLpPct = total > 0 ? (amounts[0] / total) * 100 : 0;
    const lpProviderCount = amounts.filter((a: number) => a > 0).length;

    // Check if top holder is a known lock/burn address
    const topAddress = holders[0]?.address ?? "";
    const BURN_ADDRESSES = new Set([
      "1nc1nerator11111111111111111111111111111111",
      "1111111111111111111111111111111111111111111",
    ]);
    // Streamflow, Unicrypt-like lock contracts
    const LOCK_PREFIXES = ["Lock", "Stream", "Vest"];
    const lpLocked = BURN_ADDRESSES.has(topAddress) ||
      LOCK_PREFIXES.some((p) => topAddress.startsWith(p));

    const result = { topLpPct, lpProviderCount, lpLocked };
    setCache(cacheKey, result, TTL.getTokenLargestAccounts);
    return result;
  } catch {
    return { topLpPct: 0, lpProviderCount: 0, lpLocked: false };
  }
}

// ══════════════════════════════════════════════
// RUG RECORDING
// ══════════════════════════════════════════════

const insertRuggedPool = db.prepare(`
  INSERT OR IGNORE INTO rugged_pools (
    pool_address, token_mint, token_name, creator_wallet,
    liquidity_before, liquidity_after, volume_before,
    estimated_stolen_sol, detected_by
  ) VALUES (
    @pool_address, @token_mint, @token_name, @creator_wallet,
    @liquidity_before, @liquidity_after, @volume_before,
    @estimated_stolen_sol, @detected_by
  )
`);

const upsertRuggedCreator = db.prepare(`
  INSERT INTO rugged_creators (wallet_address, total_stolen_sol, notes)
  VALUES (@wallet_address, @stolen_sol, @notes)
  ON CONFLICT(wallet_address) DO UPDATE SET
    last_rug_at = datetime('now'),
    total_rugs = total_rugs + 1,
    total_stolen_sol = total_stolen_sol + @stolen_sol
`);

export function recordRug(pool: any, tvlBefore: number, tvlAfter: number, detectedBy: string): void {
  const stolenSol = (tvlBefore - tvlAfter) / 150; // rough USD->SOL conversion

  try {
    insertRuggedPool.run({
      pool_address: pool.pool_address,
      token_mint: pool.token_mint,
      token_name: pool.token_name ?? null,
      creator_wallet: pool.creator_wallet ?? null,
      liquidity_before: tvlBefore,
      liquidity_after: tvlAfter,
      volume_before: pool.current_volume_24h ?? 0,
      estimated_stolen_sol: stolenSol,
      detected_by: detectedBy,
    });
    log.info({ pool: pool.pool_address }, "Rug recorded in rugged_pools");
  } catch (err: any) {
    log.warn({ err: err.message }, "Failed to record rugged pool");
  }

  // Record creator if known
  if (pool.creator_wallet) {
    try {
      upsertRuggedCreator.run({
        wallet_address: pool.creator_wallet,
        stolen_sol: stolenSol,
        notes: `Rug: ${pool.token_name ?? pool.token_mint}`,
      });
      log.info({ creator: pool.creator_wallet }, "Creator added/updated in rugged_creators");
    } catch (err: any) {
      log.warn({ err: err.message }, "Failed to record rugged creator");
    }
  }
}

// ══════════════════════════════════════════════
// SOCIAL VERIFICATION (exported for use in pool scoring)
// ══════════════════════════════════════════════

export { verifySocials, getLpDistribution as checkLpDistribution };
