import WebSocket from "ws";
import axios from "axios";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";
import {
  scoreTokenRisk,
  scorePoolRisk,
  getLpDistribution,
  recordRug,
  isRuggedCreator,
} from "./riskService.js";
import { getOnChainPoolState } from "./liquidityService.js";
import { getCached, setCache, TTL, checkHeliusLimit } from "../utils/heliusCache.js";
import { getKolSignalStrength } from "./kolService.js";
import { enrichTokenData } from "./dexscreenerService.js";
import TelegramBot from "node-telegram-bot-api";

const log = createLogger("pumpswap");

const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SOL_MINT = "So11111111111111111111111111111111111111112";

let ws: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let rescoreInterval: ReturnType<typeof setInterval> | null = null;
let rugCheckInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let isShuttingDown = false;

// ── TELEGRAM ──

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL_ID;
let bot: TelegramBot | null = null;
if (botToken) {
  bot = new TelegramBot(botToken, { polling: false });
}

// ── DB HELPERS ──

const insertPool = db.prepare(`
  INSERT OR IGNORE INTO pumpswap_pools (
    pool_address, token_mint, token_name, token_symbol, token_image,
    twitter, telegram, website,
    initial_liquidity_sol, initial_liquidity_usd, fee_tier, bin_step,
    created_at, risk_score, risk_tier, kol_count,
    current_apr, current_volume_24h, current_tvl_usd, market_cap_usd,
    creator_wallet, onchain_creator, is_mayhem_mode,
    top_lp_pct, lp_provider_count, lp_locked, risk_flags,
    status
  ) VALUES (
    @pool_address, @token_mint, @token_name, @token_symbol, @token_image,
    @twitter, @telegram, @website,
    @initial_liquidity_sol, @initial_liquidity_usd, @fee_tier, @bin_step,
    datetime('now'), @risk_score, @risk_tier, @kol_count,
    @current_apr, @current_volume_24h, @current_tvl_usd, @market_cap_usd,
    @creator_wallet, @onchain_creator, @is_mayhem_mode,
    @top_lp_pct, @lp_provider_count, @lp_locked, @risk_flags,
    'active'
  )
`);

const updatePoolData = db.prepare(`
  UPDATE pumpswap_pools SET
    current_apr = @current_apr,
    current_volume_24h = @current_volume_24h,
    current_tvl_usd = @current_tvl_usd,
    prev_tvl_usd = @prev_tvl_usd,
    market_cap_usd = @market_cap_usd,
    risk_score = @risk_score,
    risk_tier = @risk_tier,
    kol_count = @kol_count,
    status = @status,
    last_updated = datetime('now')
  WHERE pool_address = @pool_address
`);

const updatePoolLpData = db.prepare(`
  UPDATE pumpswap_pools SET
    top_lp_pct = @top_lp_pct,
    lp_provider_count = @lp_provider_count,
    lp_locked = @lp_locked,
    risk_flags = @risk_flags,
    risk_score = @risk_score,
    risk_tier = @risk_tier
  WHERE pool_address = @pool_address
`);

const getActivePools = db.prepare(
  "SELECT * FROM pumpswap_pools WHERE status = 'active'"
);

// ── POOL DETECTION ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── PROCESSING QUEUE (avoid rate limits) ──

const pendingSignatures: string[] = [];
let isProcessingQueue = false;

function enqueueSignature(signature: string): void {
  pendingSignatures.push(signature);
  if (!isProcessingQueue) processQueue();
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (pendingSignatures.length > 0) {
    const sig = pendingSignatures.shift()!;
    try {
      const { poolAddress, tokenMint } = await fetchTransactionAccounts(sig);
      if (poolAddress && tokenMint) {
        await processNewPool(poolAddress, tokenMint, sig);
      } else {
        log.warn({ signature: sig }, "Could not extract pool/token from transaction");
      }
    } catch (err: any) {
      log.error({ err: err.message, signature: sig }, "Failed to process pool");
    }
    // Rate limit: wait 1s between queue items
    await sleep(1000);
  }

  isProcessingQueue = false;
}

const SYSTEM_ADDRESSES = new Set([
  PUMPSWAP_PROGRAM,
  SOL_MINT,
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
]);

async function fetchTransactionAccounts(
  signature: string
): Promise<{ poolAddress: string | null; tokenMint: string | null; creatorWallet: string | null }> {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return { poolAddress: null, tokenMint: null, creatorWallet: null };

  // Retry up to 4 times with increasing delays (tx may not be indexed yet)
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const result = await fetchTransactionAccountsOnce(signature, rpcUrl);
    if (result.poolAddress && result.tokenMint) return result;
  }

  return { poolAddress: null, tokenMint: null, creatorWallet: null };
}

async function fetchTransactionAccountsOnce(
  signature: string,
  rpcUrl: string
): Promise<{ poolAddress: string | null; tokenMint: string | null; creatorWallet: string | null }> {
  // Check cache first (transactions never change)
  const cacheKey = `tx:${signature}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    checkHeliusLimit();
    const { data } = await axios.post(
      rpcUrl,
      {
        jsonrpc: "2.0",
        id: "ps-tx",
        method: "getTransaction",
        params: [
          signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ],
      },
      { timeout: 8000 }
    );

    const txResult = data.result;
    if (!txResult) {
      log.warn({ signature }, "Transaction not found (may not be indexed yet)");
      return { poolAddress: null, tokenMint: null, creatorWallet: null };
    }

    const instructions = txResult.transaction?.message?.instructions ?? [];

    // Extract fee payer (creator wallet)
    const accountKeys = txResult.transaction?.message?.accountKeys ?? [];
    let creatorWallet: string | null = null;
    if (accountKeys.length > 0) {
      const first = accountKeys[0];
      creatorWallet = typeof first === "string" ? first : first.pubkey ?? null;
    }

    // Find the PumpSwap program instruction
    const pumpswapIx = instructions.find(
      (ix: any) => ix.programId === PUMPSWAP_PROGRAM
    );

    if (pumpswapIx?.accounts?.length >= 5) {
      const poolAddress = pumpswapIx.accounts[0];
      let tokenMint = pumpswapIx.accounts[4];
      if (tokenMint === SOL_MINT) {
        tokenMint = pumpswapIx.accounts[3];
      }

      log.info(
        { signature, poolAddress, tokenMint, creatorWallet },
        "Extracted pool info from PumpSwap instruction"
      );
      var txResult1 = { poolAddress, tokenMint, creatorWallet };
      setCache(cacheKey, txResult1, TTL.getTransaction);
      return txResult1;
    }

    // Fallback: scan all instructions for ATA creates to find mint
    let tokenMint: string | null = null;
    let poolAddress: string | null = null;

    for (const ix of instructions) {
      if (ix.parsed?.info?.mint && ix.parsed.info.mint !== SOL_MINT) {
        tokenMint = ix.parsed.info.mint;
      }
    }

    for (const k of accountKeys) {
      const pubkey = typeof k === "string" ? k : k.pubkey;
      const writable = typeof k === "object" ? k.writable : false;
      if (writable && !SYSTEM_ADDRESSES.has(pubkey) && pubkey !== tokenMint) {
        if (typeof k === "object" && k.signer) continue;
        poolAddress = pubkey;
        break;
      }
    }

    log.info(
      { signature, poolAddress, tokenMint, creatorWallet },
      "Extracted pool info (fallback)"
    );
    var txResult2 = { poolAddress, tokenMint, creatorWallet };
    if (poolAddress && tokenMint) setCache(cacheKey, txResult2, TTL.getTransaction);
    return txResult2;
  } catch (err: any) {
    log.warn(
      { err: err.message, signature, status: err.response?.status },
      "Failed to fetch transaction details"
    );
    return { poolAddress: null, tokenMint: null, creatorWallet: null };
  }
}

async function fetchPoolFromDexScreener(poolAddress: string): Promise<any> {
  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`,
      { timeout: 10000 }
    );
    return data?.pair ?? data?.pairs?.[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(tokenMint: string): Promise<any> {
  const cacheKey = `getAsset:${tokenMint}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) return null;

  try {
    checkHeliusLimit();
    const { data } = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: "pumpswap-asset",
      method: "getAsset",
      params: { id: tokenMint },
    });
    const result = data.result ?? null;
    if (result) setCache(cacheKey, result, TTL.getAsset);
    return result;
  } catch {
    return null;
  }
}

function extractSocials(
  asset: any,
  dexPair: any
): { twitter: string | null; telegram: string | null; website: string | null } {
  let twitter: string | null = null;
  let telegram: string | null = null;
  let website: string | null = null;

  const info = dexPair?.info ?? {};
  if (info.socials) {
    for (const s of info.socials) {
      if (s.type === "twitter") twitter = s.url;
      if (s.type === "telegram") telegram = s.url;
    }
  }
  if (info.websites?.length) {
    website = info.websites[0].url ?? null;
  }

  if (!twitter || !website) {
    const links = asset?.content?.links ?? {};
    if (!twitter && links.twitter) twitter = links.twitter;
    if (!website && links.external_url) website = links.external_url;
  }

  return { twitter, telegram, website };
}

function calculateApr(dexPair: any): number | null {
  if (!dexPair) return null;
  const volume24h = dexPair.volume?.h24 ?? 0;
  const liquidity = dexPair.liquidity?.usd ?? 0;
  if (liquidity <= 0) return null;

  const feeTier = 0.0025;
  const dailyFees = volume24h * feeTier;
  return (dailyFees / liquidity) * 365 * 100;
}

// ── COMPOSITE SCORE ──

export function calculateCompositeScore(pool: any): number {
  const apr = pool.current_apr ?? 0;
  const vol = pool.current_volume_24h ?? 0;
  const mcap = pool.market_cap_usd ?? 0;
  const risk = pool.risk_score ?? 50;
  const kol = pool.kol_count ?? 0;
  const tvl = pool.current_tvl_usd ?? 0;

  // APR score (0-100): diminishing returns
  const aprScore = apr > 0 ? Math.min(100, 20 * Math.log2(1 + apr / 100)) : 0;

  // Risk inverted (0-100)
  const riskInverted = 100 - risk;

  // KOL score (0-100)
  const kolScore = Math.min(100, kol * 10);

  // Volume score (0-100): continuous log scale
  const volScore = vol > 100 ? Math.min(100, 10 * Math.log10(vol)) : 0;

  // TVL score (0-100): higher TVL = safer
  const tvlScore = tvl > 100 ? Math.min(100, 12 * Math.log10(tvl)) : 0;

  // MCap score (0-100): bell curve peaking at $100K-$1M
  let mcapScore = 0;
  if (mcap > 0) {
    const logMcap = Math.log10(mcap);
    mcapScore = Math.max(0, 100 - Math.pow((logMcap - 5.3) * 30, 2));
  }

  const raw =
    aprScore * 0.20 +
    riskInverted * 0.20 +
    kolScore * 0.15 +
    volScore * 0.20 +
    tvlScore * 0.10 +
    mcapScore * 0.15;

  return Math.round(raw * 10) / 10;
}

// ── PROCESS NEW POOL ──

async function processNewPool(
  poolAddress: string,
  tokenMint: string,
  signature: string
): Promise<void> {
  log.info({ poolAddress, tokenMint, signature }, "New PumpSwap pool detected");

  // Check if already stored
  const existing = db
    .prepare("SELECT id FROM pumpswap_pools WHERE pool_address = ?")
    .get(poolAddress);
  if (existing) return;

  // Fetch all data in parallel (including on-chain state from SDK)
  const [dexPair, asset, risk, kolSignal, lpDist, onChainState] = await Promise.all([
    fetchPoolFromDexScreener(poolAddress),
    fetchTokenMetadata(tokenMint),
    scoreTokenRisk(tokenMint).catch(() => ({ score: 50, flags: [], tier: "moderate" as const })),
    getKolSignalStrength(tokenMint).catch(() => ({ score: 0, eliteCount: 0, profitableCount: 0 })),
    getLpDistribution(poolAddress).catch(() => ({ topLpPct: 0, lpProviderCount: 0, lpLocked: false })),
    getOnChainPoolState(poolAddress).catch(() => null),
  ]);

  // Use on-chain creator from SDK (more reliable than tx parsing fallback)
  const { creatorWallet } = await fetchTransactionAccounts(signature);
  const onChainCreator = onChainState?.creator ?? null;

  const socials = extractSocials(asset, dexPair);
  const apr = calculateApr(dexPair);

  const poolData = {
    pool_address: poolAddress,
    token_mint: tokenMint,
    token_name: asset?.content?.metadata?.name ?? dexPair?.baseToken?.name ?? null,
    token_symbol: asset?.content?.metadata?.symbol ?? dexPair?.baseToken?.symbol ?? null,
    token_image: asset?.content?.links?.image ?? null,
    twitter: socials.twitter,
    telegram: socials.telegram,
    website: socials.website,
    initial_liquidity_sol: dexPair?.liquidity?.base ?? null,
    initial_liquidity_usd: dexPair?.liquidity?.usd ?? null,
    fee_tier: 0.25,
    bin_step: null as number | null,
    risk_score: risk.score,
    risk_tier: risk.tier,
    kol_count: kolSignal.eliteCount + kolSignal.profitableCount,
    current_apr: apr,
    current_volume_24h: dexPair?.volume?.h24 ?? null,
    current_tvl_usd: dexPair?.liquidity?.usd ?? null,
    market_cap_usd: dexPair?.marketCap ?? dexPair?.fdv ?? null,
    creator_wallet: creatorWallet,
    onchain_creator: onChainCreator,
    is_mayhem_mode: onChainState?.isMayhemMode ? 1 : 0,
    top_lp_pct: lpDist.topLpPct,
    lp_provider_count: lpDist.lpProviderCount,
    lp_locked: lpDist.lpLocked ? 1 : 0,
    risk_flags: JSON.stringify(risk.flags),
  };

  try {
    insertPool.run(poolData);
    log.info(
      {
        pool: poolAddress,
        token: poolData.token_name ?? tokenMint,
        risk: risk.tier,
        kol: poolData.kol_count,
        topLpPct: lpDist.topLpPct,
        lpLocked: lpDist.lpLocked,
      },
      "Pool stored"
    );
  } catch (err: any) {
    log.error({ err: err.message, pool: poolAddress }, "Failed to store pool");
    return;
  }

  // Send Telegram alert if score >= 70 and not dangerous
  const score = calculateCompositeScore(poolData);
  if (score >= 70 && risk.tier !== "dangerous") {
    await sendPoolAlert(poolData, score);
  }
}

// ── TELEGRAM ALERTS ──

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "\\-";
  if (n >= 1e6) return "\\$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "\\$" + (n / 1e3).toFixed(1) + "K";
  return "\\$" + n.toFixed(0);
}

async function sendPoolAlert(pool: any, score: number): Promise<void> {
  if (!bot || !channelId) return;

  const name = esc(pool.token_name ?? "Unknown");
  const symbol = esc(pool.token_symbol ?? "???");
  const twitterLine = pool.twitter
    ? `\n\u{1F426} [Twitter](${pool.twitter})`
    : "";

  // Badge line
  const badges: string[] = [];
  if (pool.lp_locked) badges.push("\u{1F512} LP Locked");
  if ((pool.top_lp_pct ?? 0) >= 80) badges.push("\u{1F464} Single LP");
  if (pool.creator_wallet && isRuggedCreator(pool.creator_wallet)) badges.push("\u26A0\uFE0F Creator Flagged");
  const badgeLine = badges.length ? `\n${badges.join(" \\| ")}` : "";

  const text = `\u{1F3CA} *NEW PUMPSWAP POOL*

*${name}* \\(${symbol}\\)
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F4CA} Score: ${score}/100
\u{1F4B0} Initial Liquidity: ${fmtUsd(pool.initial_liquidity_usd)}
\u{1F4CA} MCap: ${fmtUsd(pool.market_cap_usd)}
\u{1F4C8} Fee Tier: ${pool.fee_tier ?? 0.25}%
\u{1F6E1} Risk: ${esc((pool.risk_tier ?? "unknown").toUpperCase())}
\u{1F40B} KOL Activity: ${pool.kol_count ?? 0} wallets${twitterLine}${badgeLine}

[Provide liquidity \\u2192](https://pumpapi.markets/pools/${pool.pool_address})`;

  try {
    await bot.sendMessage(channelId, text, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });
    log.info({ pool: pool.pool_address, score }, "Telegram pool alert sent");
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to send pool alert");
    try {
      const plain = text.replace(/[*_`\[\]()\\]/g, "");
      await bot.sendMessage(channelId, plain);
    } catch {}
  }
}

// ── POOL UPDATER ──

// Batch fetch from DexScreener: up to 30 tokens per call via /tokens/v1/solana/addr1,addr2,...
async function batchFetchDexScreener(
  tokenMints: string[]
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const BATCH = 30;
  for (let i = 0; i < tokenMints.length; i += BATCH) {
    const batch = tokenMints.slice(i, i + BATCH);
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`,
        { timeout: 12000 }
      );
      const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
      for (const pair of pairs) {
        const addr = pair.pairAddress;
        const mint = pair.baseToken?.address;
        if (addr) result.set(addr, pair);
        if (mint && !result.has(mint)) result.set(mint, pair);
      }
    } catch (err: any) {
      log.warn({ err: err.message, batchSize: batch.length }, "DexScreener batch fetch failed");
    }
    if (i + BATCH < tokenMints.length) await sleep(1000);
  }
  return result;
}

// Light update: DexScreener only (free, runs every 2 min)
async function updateActivePools(): Promise<void> {
  const pools = getActivePools.all() as any[];
  if (!pools.length) return;

  log.info({ count: pools.length }, "Updating active pools (DexScreener batch)");

  const mints = pools.map((p: any) => p.token_mint).filter(Boolean);
  const dexData = await batchFetchDexScreener(mints);

  for (const pool of pools) {
    try {
      const dexPair = dexData.get(pool.token_mint) ?? dexData.get(pool.pool_address) ?? null;

      const apr = calculateApr(dexPair);
      const volume24h = dexPair?.volume?.h24 ?? pool.current_volume_24h ?? 0;
      const volumeH1 = dexPair?.volume?.h1 ?? 0;
      const newTvl = dexPair?.liquidity?.usd ?? pool.current_tvl_usd ?? 0;
      const prevTvl = pool.current_tvl_usd ?? 0;

      let status = "active";

      // ── RUG DETECTION ──
      // TVL dropped > 50% since last check → potential rug
      // TVL dropped > 90% or below $100 → confirmed rug
      if (prevTvl > 500) {
        const dropPct = ((prevTvl - newTvl) / prevTvl) * 100;

        if (newTvl < 100 && dropPct > 50) {
          // Confirmed rug — liquidity essentially gone
          status = "rugged";
          log.warn(
            { pool: pool.pool_address, prevTvl, newTvl, token: pool.token_symbol },
            "RUG CONFIRMED — liquidity drained"
          );
          recordRug(pool, prevTvl, newTvl, "tvl_drain");
        } else if (dropPct > 90) {
          // > 90% drop = rug even if some dust remains
          status = "rugged";
          log.warn(
            { pool: pool.pool_address, prevTvl, newTvl, dropPct: dropPct.toFixed(1), token: pool.token_symbol },
            "RUG DETECTED — TVL dropped >90%"
          );
          recordRug(pool, prevTvl, newTvl, "tvl_drop_90pct");
        }
      }

      if (status === "active" && volume24h < 100 && volumeH1 < 100) {
        const lastUpdated = new Date(pool.last_updated).getTime();
        const hoursSinceUpdate = (Date.now() - lastUpdated) / (1000 * 60 * 60);
        if (hoursSinceUpdate >= 6 && volume24h < 100) {
          status = "dead";
        }
      }

      updatePoolData.run({
        pool_address: pool.pool_address,
        current_apr: apr ?? pool.current_apr,
        current_volume_24h: volume24h,
        current_tvl_usd: newTvl,
        prev_tvl_usd: prevTvl, // store previous for next comparison
        market_cap_usd: dexPair?.marketCap ?? dexPair?.fdv ?? pool.market_cap_usd,
        risk_score: pool.risk_score,
        risk_tier: pool.risk_tier,
        kol_count: pool.kol_count,
        status,
      });
    } catch (err: any) {
      log.warn({ err: err.message, pool: pool.pool_address }, "Failed to update pool");
    }
  }
}

// Heavy update: risk + KOL + LP distribution re-scoring via Helius (runs every 10 min)
async function rescoreActivePools(): Promise<void> {
  const pools = getActivePools.all() as any[];
  if (!pools.length) return;

  log.info({ count: pools.length }, "Re-scoring active pools (risk + KOL + LP)");

  for (const pool of pools) {
    try {
      const [risk, kolSignal, lpDist] = await Promise.all([
        scoreTokenRisk(pool.token_mint).catch(() => null),
        getKolSignalStrength(pool.token_mint).catch(() => null),
        getLpDistribution(pool.pool_address).catch(() => null),
      ]);

      // Update risk + KOL via standard update
      if (risk || kolSignal) {
        updatePoolData.run({
          pool_address: pool.pool_address,
          current_apr: pool.current_apr,
          current_volume_24h: pool.current_volume_24h,
          current_tvl_usd: pool.current_tvl_usd,
          prev_tvl_usd: pool.prev_tvl_usd ?? pool.current_tvl_usd,
          market_cap_usd: pool.market_cap_usd,
          risk_score: risk?.score ?? pool.risk_score,
          risk_tier: risk?.tier ?? pool.risk_tier,
          kol_count: kolSignal
            ? kolSignal.eliteCount + kolSignal.profitableCount
            : pool.kol_count,
          status: pool.status,
        });
      }

      // Update LP distribution data
      if (lpDist) {
        // Re-score pool risk with updated LP data
        const poolForScoring = {
          ...pool,
          top_lp_pct: lpDist.topLpPct,
          lp_provider_count: lpDist.lpProviderCount,
          lp_locked: lpDist.lpLocked,
          risk_score: risk?.score ?? pool.risk_score,
        };
        const poolRisk = await scorePoolRisk(poolForScoring).catch(() => null);

        updatePoolLpData.run({
          pool_address: pool.pool_address,
          top_lp_pct: lpDist.topLpPct,
          lp_provider_count: lpDist.lpProviderCount,
          lp_locked: lpDist.lpLocked ? 1 : 0,
          risk_flags: poolRisk ? JSON.stringify(poolRisk.flags) : pool.risk_flags,
          risk_score: poolRisk?.score ?? risk?.score ?? pool.risk_score,
          risk_tier: poolRisk?.tier ?? risk?.tier ?? pool.risk_tier,
        });
      }

      // Throttle: 500ms between pools to avoid Helius rate limits
      await sleep(500);
    } catch (err: any) {
      log.warn(
        { err: err.message, pool: pool.pool_address },
        "Failed to rescore pool"
      );
    }
  }
}

// ── REAL-TIME RUG MONITORING (every 30 seconds) ──

async function rugCheckCycle(): Promise<void> {
  const pools = getActivePools.all() as any[];
  if (!pools.length) return;

  // Only check pools with meaningful liquidity
  const poolsToCheck = pools.filter((p: any) => (p.current_tvl_usd ?? 0) > 500);
  if (!poolsToCheck.length) return;

  // Batch fetch fresh data
  const mints = poolsToCheck.map((p: any) => p.token_mint).filter(Boolean);
  const dexData = await batchFetchDexScreener(mints);

  for (const pool of poolsToCheck) {
    try {
      const dexPair = dexData.get(pool.token_mint) ?? dexData.get(pool.pool_address) ?? null;
      if (!dexPair) continue;

      const currentLiquidity = dexPair.liquidity?.usd ?? 0;
      const previousLiquidity = pool.current_tvl_usd ?? 0;

      if (previousLiquidity <= 0) continue;

      const dropPct = ((previousLiquidity - currentLiquidity) / previousLiquidity) * 100;

      // > 50% drop and below $100 = confirmed rug
      if (dropPct > 50 && currentLiquidity < 100) {
        log.warn(
          { pool: pool.pool_address, prevTvl: previousLiquidity, newTvl: currentLiquidity, token: pool.token_symbol },
          "RUG CONFIRMED by real-time monitor"
        );

        // Mark as rugged
        updatePoolData.run({
          pool_address: pool.pool_address,
          current_apr: pool.current_apr,
          current_volume_24h: pool.current_volume_24h,
          current_tvl_usd: currentLiquidity,
          prev_tvl_usd: previousLiquidity,
          market_cap_usd: pool.market_cap_usd,
          risk_score: 100,
          risk_tier: "dangerous",
          kol_count: pool.kol_count,
          status: "rugged",
        });

        recordRug(pool, previousLiquidity, currentLiquidity, "realtime_monitor");
      } else if (dropPct > 30) {
        // Significant drop — flag but don't rug-mark yet
        log.warn(
          { pool: pool.pool_address, dropPct: dropPct.toFixed(1), token: pool.token_symbol },
          "Significant liquidity drop detected"
        );
      }
    } catch (err: any) {
      // Silent — rug check is best-effort
    }
  }
}

// ── WEBSOCKET ──

function connect(): void {
  if (isShuttingDown) return;

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    log.error("HELIUS_API_KEY not set, cannot start PumpSwap monitor");
    return;
  }

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  log.info("Connecting to Helius WebSocket for PumpSwap monitoring...");

  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    log.info("WebSocket connected, subscribing to PumpSwap logs...");

    const subscribeMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMPSWAP_PROGRAM] },
        { commitment: "confirmed" },
      ],
    });

    ws!.send(subscribeMsg);

    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.result !== undefined && msg.id === 1) {
        log.info({ subscriptionId: msg.result }, "Subscribed to PumpSwap logs");
        return;
      }

      if (msg.method === "logsNotification") {
        const result = msg.params?.result;
        const logs: string[] = result?.value?.logs ?? [];
        const signature: string = result?.value?.signature ?? "";

        log.info(
          { signature, logCount: logs.length },
          "PumpSwap event received"
        );

        const isInitialize = logs.some(
          (l) =>
            l.includes("initialize") ||
            l.includes("Initialize") ||
            l.includes("create_pool") ||
            l.includes("CreatePool")
        );

        if (isInitialize) {
          log.info({ signature }, "Pool initialization detected!");
          enqueueSignature(signature);
        }
      }
    } catch (err: any) {
      log.warn({ err: err.message }, "Failed to parse WebSocket message");
    }
  });

  ws.on("error", (err) => {
    log.error({ err: err.message }, "WebSocket error");
  });

  ws.on("close", (code, reason) => {
    log.warn(
      { code, reason: reason.toString() },
      "WebSocket disconnected"
    );
    cleanup();
    scheduleReconnect();
  });

  ws.on("pong", () => {
    log.debug("WebSocket pong received");
  });
}

function cleanup(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  ws = null;
}

function scheduleReconnect(): void {
  if (isShuttingDown) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  const delay = 3000 + Math.random() * 2000;
  log.info({ delayMs: Math.round(delay) }, "Scheduling reconnect...");
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connect();
  }, delay);
}

// ── PUBLIC API ──

export function startPumpswapMonitor(): void {
  log.info("Starting PumpSwap pool monitor");

  // Connect WebSocket
  connect();

  // Light update (DexScreener batch, free) every 2 minutes
  updateInterval = setInterval(() => {
    updateActivePools().catch((err) =>
      log.error({ err: err.message }, "Pool update cycle failed")
    );
  }, 120_000);

  // Heavy rescore (Helius risk + KOL + LP) every 30 minutes (was 10 — conserving credits)
  rescoreInterval = setInterval(() => {
    rescoreActivePools().catch((err) =>
      log.error({ err: err.message }, "Pool rescore cycle failed")
    );
  }, 120 * 60_000); // 2 hours — reduced from 30min to save Helius credits

  // Real-time rug monitoring every 30 seconds
  rugCheckInterval = setInterval(() => {
    rugCheckCycle().catch((err) =>
      log.error({ err: err.message }, "Rug check cycle failed")
    );
  }, 30_000);

  // Run initial light update after 10 seconds
  setTimeout(() => {
    updateActivePools().catch((err) =>
      log.error({ err: err.message }, "Initial pool update failed")
    );
  }, 10_000);

  // Run initial rescore after 30 seconds
  setTimeout(() => {
    rescoreActivePools().catch((err) =>
      log.error({ err: err.message }, "Initial pool rescore failed")
    );
  }, 30_000);
}

export function stopPumpswapMonitor(): void {
  isShuttingDown = true;

  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }

  if (rescoreInterval) {
    clearInterval(rescoreInterval);
    rescoreInterval = null;
  }

  if (rugCheckInterval) {
    clearInterval(rugCheckInterval);
    rugCheckInterval = null;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (ws) {
    ws.close();
    cleanup();
  }

  log.info("PumpSwap monitor stopped");
}

// ── QUERY HELPERS (used by routes) ──

export function getPoolByAddress(address: string): any {
  return db
    .prepare("SELECT * FROM pumpswap_pools WHERE pool_address = ?")
    .get(address);
}

export function queryPools(opts: {
  category?: string;
  minApr?: number;
  maxRisk?: number;
  minKol?: number;
  sort?: string;
  limit?: number;
}): any[] {
  const conditions: string[] = ["status = 'active'"];
  const params: any[] = [];

  if (opts.category === "graduating") {
    conditions.push("market_cap_usd < 100000");
    conditions.push("current_tvl_usd > 100");
    conditions.push("current_volume_24h > 500");
  } else if (opts.category === "momentum") {
    conditions.push("current_volume_24h > 5000");
    conditions.push("current_apr > 100");
    conditions.push("market_cap_usd >= 50000");
  } else if (opts.category === "kol") {
    conditions.push("kol_count > 0");
  }

  if (opts.minApr != null) {
    conditions.push("current_apr >= ?");
    params.push(opts.minApr);
  }
  if (opts.maxRisk != null) {
    conditions.push("risk_score <= ?");
    params.push(opts.maxRisk);
  }
  if (opts.minKol != null) {
    conditions.push("kol_count >= ?");
    params.push(opts.minKol);
  }

  const limit = Math.min(opts.limit ?? 20, 100);
  const where = conditions.join(" AND ");

  const pools = db
    .prepare(`SELECT * FROM pumpswap_pools WHERE ${where} GROUP BY token_mint ORDER BY current_volume_24h DESC LIMIT ?`)
    .all(...params, limit) as any[];

  // Calculate composite scores, add warnings/badges, and sort
  const scored = pools.map((p) => {
    const warnings: string[] = [];
    const badges: string[] = [];

    // LP warnings
    if (p.top_lp_pct != null && p.top_lp_pct >= 80) {
      warnings.push("⚠️ Single LP provider — rug risk");
      badges.push("👤");
    }
    // LP locked badge
    if (p.lp_locked) {
      badges.push("🔒");
    }
    // Creator flagged (check on-chain creator first)
    const creatorCheck = p.onchain_creator ?? p.creator_wallet;
    if (creatorCheck && isRuggedCreator(creatorCheck)) {
      warnings.push("⚠️ Creator previously rugged tokens");
      badges.push("⚠️");
    }
    // Mayhem mode badge
    if (p.is_mayhem_mode) {
      badges.push("⚡");
      warnings.push("⚡ Mayhem mode active");
    }
    // Dangerous tier warning
    const riskTier = p.risk_tier ?? "moderate";
    if (riskTier === "dangerous" || riskTier === "risky") {
      warnings.push(`HIGH RISK — ${riskTier.toUpperCase()}`);
    }

    return {
      ...p,
      composite_score: calculateCompositeScore(p),
      warnings,
      badges,
    };
  });

  const sortField = opts.sort ?? "apr";
  scored.sort((a, b) => {
    switch (sortField) {
      case "risk":
        return (a.risk_score ?? 100) - (b.risk_score ?? 100);
      case "kol":
        return (b.kol_count ?? 0) - (a.kol_count ?? 0);
      case "age":
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      case "score":
        return b.composite_score - a.composite_score;
      case "apr":
      default:
        return (b.current_apr ?? 0) - (a.current_apr ?? 0);
    }
  });

  return scored;
}

export function getTopPools(): any[] {
  // TOP tab: only safe/low risk pools with strict quality filters
  // - composite_score >= 50
  // - risk_score <= 40 (SAFE or LOW only — never DANGEROUS)
  // - pool age > 30 minutes (avoid instant rugs)
  // - LP not fully controlled by single wallet
  const pools = db
    .prepare(
      `SELECT * FROM pumpswap_pools
       WHERE status = 'active'
         AND risk_score <= 40
         AND current_volume_24h > 1000
         AND created_at <= datetime('now', '-30 minutes')
         AND COALESCE(top_lp_pct, 0) < 100
       GROUP BY token_mint
       ORDER BY current_volume_24h DESC`
    )
    .all() as any[];

  return pools
    .map((p) => {
      const badges: string[] = [];
      if (p.lp_locked) badges.push("🔒");
      if ((p.lp_provider_count ?? 0) >= 5) badges.push("👥");

      return {
        ...p,
        composite_score: calculateCompositeScore(p),
        badges,
        warnings: [] as string[],
      };
    })
    .filter((p) => p.composite_score >= 50)
    .sort((a, b) => b.composite_score - a.composite_score)
    .slice(0, 10);
}
