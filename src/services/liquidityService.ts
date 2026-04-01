import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  PUMP_AMM_SDK,
  depositLpToken,
  withdraw,
  buyQuoteInput,
  canonicalPumpPoolPda,
} from "@pump-fun/pump-swap-sdk";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import axios from "axios";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("liquidity");

const FEE_BPS = 50; // 0.5%
const FEE_ACCOUNT = new PublicKey(
  process.env.REFERRAL_ACCOUNT || "JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau"
);

// ── DB SCHEMA ──

db.exec(`
  CREATE TABLE IF NOT EXISTS lp_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    lp_tokens TEXT NOT NULL,
    entry_base_amount TEXT,
    entry_quote_amount TEXT,
    entry_sol_value REAL,
    entry_price_usd REAL,
    entry_tx TEXT,
    entry_at TEXT DEFAULT (datetime('now')),
    exit_tx TEXT,
    exit_at TEXT,
    exit_base_amount TEXT,
    exit_quote_amount TEXT,
    exit_sol_value REAL,
    pnl_sol REAL,
    pnl_pct REAL,
    fees_paid_entry REAL,
    fees_paid_exit REAL,
    status TEXT DEFAULT 'active',
    UNIQUE(wallet, pool_address, entry_tx)
  );

  CREATE INDEX IF NOT EXISTS idx_lp_wallet ON lp_positions(wallet);
  CREATE INDEX IF NOT EXISTS idx_lp_pool ON lp_positions(pool_address);
  CREATE INDEX IF NOT EXISTS idx_lp_status ON lp_positions(status);
`);

// ── PREPARED STATEMENTS ──

const insertPosition = db.prepare(`
  INSERT INTO lp_positions (
    wallet, pool_address, token_mint, token_name, token_symbol,
    lp_tokens, entry_base_amount, entry_quote_amount, entry_sol_value,
    entry_price_usd, entry_tx, fees_paid_entry
  ) VALUES (
    @wallet, @pool_address, @token_mint, @token_name, @token_symbol,
    @lp_tokens, @entry_base_amount, @entry_quote_amount, @entry_sol_value,
    @entry_price_usd, @entry_tx, @fees_paid_entry
  )
`);

const updatePositionExit = db.prepare(`
  UPDATE lp_positions SET
    exit_tx = @exit_tx,
    exit_at = datetime('now'),
    exit_base_amount = @exit_base_amount,
    exit_quote_amount = @exit_quote_amount,
    exit_sol_value = @exit_sol_value,
    pnl_sol = @pnl_sol,
    pnl_pct = @pnl_pct,
    fees_paid_exit = @fees_paid_exit,
    status = 'closed'
  WHERE id = @id
`);

const getPositionsByWallet = db.prepare(
  "SELECT * FROM lp_positions WHERE wallet = ? ORDER BY entry_at DESC"
);

const getActivePositionsByWallet = db.prepare(
  "SELECT * FROM lp_positions WHERE wallet = ? AND status = 'active' ORDER BY entry_at DESC"
);

const getPositionById = db.prepare(
  "SELECT * FROM lp_positions WHERE id = ?"
);

// ── CONNECTION ──

function getConnection(): Connection {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) throw new Error("HELIUS_RPC_URL not set");
  return new Connection(rpcUrl, "confirmed");
}

// ── BUILD DEPOSIT TX ──

export async function buildDepositTransaction(params: {
  userWallet: string;
  poolAddress: string;
  amountSol: number;
  slippage?: number;
}): Promise<{
  transaction: string;
  estimatedLpTokens: string;
  estimatedBaseAmount: string;
  estimatedQuoteAmount: string;
  feeSol: number;
  netAmountSol: number;
}> {
  const { userWallet, poolAddress, amountSol, slippage = 1 } = params;
  const connection = getConnection();
  const user = new PublicKey(userWallet);
  const poolKey = new PublicKey(poolAddress);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const offlineSdk = PUMP_AMM_SDK;

  // Fetch pool state
  const pool = await onlineSdk.fetchPool(poolKey);
  const liqState = await onlineSdk.liquiditySolanaState(poolKey, user);

  // Calculate fee (0.5% of SOL input)
  const feeSol = amountSol * (FEE_BPS / 10000);
  const netSol = amountSol - feeSol;
  const quoteAmount = new BN(Math.floor(netSol * LAMPORTS_PER_SOL));

  // Calculate deposit amounts from quote (SOL) input
  const depositCalc = offlineSdk.depositQuoteInput(liqState, quoteAmount, slippage);

  // Build instructions
  const instructions: TransactionInstruction[] = [];

  // 1. Fee transfer to platform
  const feeLamports = Math.floor(feeSol * LAMPORTS_PER_SOL);
  if (feeLamports > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: FEE_ACCOUNT,
        lamports: feeLamports,
      })
    );
  }

  // 2. Deposit instruction
  const depositIxs = await offlineSdk.depositInstructionsInternal(
    liqState,
    depositCalc.lpToken,
    depositCalc.maxBase,
    depositCalc.maxQuote
  );
  instructions.push(...depositIxs);

  // Build transaction
  const tx = new Transaction();
  tx.add(...instructions);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString("base64"),
    estimatedLpTokens: depositCalc.lpToken.toString(),
    estimatedBaseAmount: depositCalc.maxBase.toString(),
    estimatedQuoteAmount: depositCalc.maxQuote.toString(),
    feeSol,
    netAmountSol: netSol,
  };
}

// ── BUILD APE TX (buy token + deposit LP in one transaction) ──

export async function buildApeTransaction(params: {
  userWallet: string;
  poolAddress: string;
  amountSol: number;
  slippage?: number;
}): Promise<{
  transaction: string;
  estimatedLpTokens: string;
  estimatedBaseAmount: string;
  estimatedQuoteDeposit: string;
  estimatedSolForBuy: number;
  estimatedSolForDeposit: number;
  feeSol: number;
  netAmountSol: number;
}> {
  const { userWallet, poolAddress, amountSol, slippage = 2 } = params;
  const connection = getConnection();
  const user = new PublicKey(userWallet);
  const poolKey = new PublicKey(poolAddress);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const offlineSdk = PUMP_AMM_SDK;

  // Fetch pool state
  const pool = await onlineSdk.fetchPool(poolKey);

  // Get pool reserves
  const baseAccountInfo = await connection.getTokenAccountBalance(pool.poolBaseTokenAccount);
  const quoteAccountInfo = await connection.getTokenAccountBalance(pool.poolQuoteTokenAccount);
  const baseReserve = new BN(baseAccountInfo.value.amount);
  const quoteReserve = new BN(quoteAccountInfo.value.amount);

  // Calculate fee (0.5%) and net SOL
  const feeSol = amountSol * (FEE_BPS / 10000);
  const netSolLamports = Math.floor((amountSol - feeSol) * LAMPORTS_PER_SOL);

  // ── OPTIMAL SPLIT CALCULATION ──
  // Solve for exact buy amount `b` where base tokens from buy = base tokens needed for deposit.
  // Derivation: b*(1-f)*(Q+b) = (T-b)*Q  →  quadratic in b:
  //   b²*(1-f) + b*Q*(2-f) - T*Q = 0
  // where T=total SOL, Q=quoteReserve, f=swap fee rate (0.75%)
  const T = netSolLamports;
  const Q = quoteReserve.toNumber();
  const f = 0.0075; // 0.25% LP fee + 0.5% creator fee
  const a = 1 - f;
  const cb = Q * (2 - f);
  const exactBuy = (-cb + Math.sqrt(cb * cb + 4 * a * T * Q)) / (2 * a);
  // Add 1% margin to buy side so user always has slightly more base than needed
  const solForBuyLamports = Math.floor(exactBuy * 1.01);
  const solForDepositLamports = netSolLamports - solForBuyLamports;

  const solForBuy = new BN(solForBuyLamports);
  const solForDeposit = new BN(solForDepositLamports);

  // Get swap state and build buy instructions
  const swapState = await onlineSdk.swapSolanaState(poolKey, user);
  const buyIxs = await offlineSdk.buyQuoteInput(swapState, solForBuy, slippage);

  // After the buy, pool reserves shift. Estimate post-buy reserves:
  const rawBaseOut = baseReserve.mul(solForBuy).div(quoteReserve.add(solForBuy));
  const swapFees = rawBaseOut.muln(25).divn(10000); // 0.25% LP fee
  const coinCreatorFee = rawBaseOut.muln(50).divn(10000); // 0.5% coin creator fee
  const estimatedBaseOut = rawBaseOut.sub(swapFees).sub(coinCreatorFee);

  const newBaseReserve = baseReserve.sub(rawBaseOut);
  const newQuoteReserve = quoteReserve.add(solForBuy);
  const newLpSupply = pool.lpSupply;

  // Calculate deposit: for solForDeposit quote, how many LP tokens?
  const lpTokensEstimate = solForDeposit.mul(newLpSupply).div(newQuoteReserve);

  // Request 3% fewer LP tokens than estimated to account for reserve drift
  // between our estimate and actual on-chain state after the buy executes.
  const lpTokensOut = lpTokensEstimate.muln(97).divn(100);

  // maxBase: cap to what we actually have (estimatedBaseOut) — can't spend more
  // maxQuote: the SOL we're depositing, with slippage room
  const baseNeeded = solForDeposit.mul(newBaseReserve).div(newQuoteReserve);
  const maxBase = estimatedBaseOut; // can't exceed what we bought
  const maxQuote = solForDeposit.muln(120).divn(100); // 20% headroom

  // Get liquidity state for deposit instructions
  const liqState = await onlineSdk.liquiditySolanaState(poolKey, user);

  // FIX: Prevent duplicate extendAccount instruction.
  // The buy instructions already include extendAccount if the pool needs it.
  // If we let the deposit also add extendAccount, the second one fails with
  // error 3012 "account already initialized". Padding the data to >= 300 bytes
  // makes the SDK skip the extend check for the deposit path.
  if (liqState.poolAccountInfo && liqState.poolAccountInfo.data.length < 300) {
    const padded = Buffer.alloc(300);
    liqState.poolAccountInfo.data.copy(padded);
    liqState.poolAccountInfo = { ...liqState.poolAccountInfo, data: padded };
  }

  const depositIxs = await offlineSdk.depositInstructionsInternal(
    liqState,
    lpTokensOut,
    maxBase,
    maxQuote
  );

  // Build single transaction: fee + buy + deposit
  const instructions: TransactionInstruction[] = [];

  // 1. Platform fee
  const feeLamports = Math.floor(feeSol * LAMPORTS_PER_SOL);
  if (feeLamports > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: FEE_ACCOUNT,
        lamports: feeLamports,
      })
    );
  }

  // 2. Buy token with ~half SOL
  instructions.push(...buyIxs);

  // 3. Deposit token + SOL into pool
  instructions.push(...depositIxs);

  // Build transaction
  const tx = new Transaction();
  tx.add(...instructions);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString("base64"),
    estimatedLpTokens: lpTokensOut.toString(),
    estimatedBaseAmount: baseNeeded.toString(),
    estimatedQuoteDeposit: solForDeposit.toString(),
    estimatedSolForBuy: solForBuyLamports / LAMPORTS_PER_SOL,
    estimatedSolForDeposit: solForDepositLamports / LAMPORTS_PER_SOL,
    feeSol,
    netAmountSol: amountSol - feeSol,
  };
}

// ── BUILD WITHDRAW TX ──

export async function buildWithdrawTransaction(params: {
  userWallet: string;
  poolAddress: string;
  lpTokenAmount: string;
  slippage?: number;
}): Promise<{
  transaction: string;
  estimatedBaseOut: string;
  estimatedQuoteOut: string;
  estimatedSolValue: number;
  feeSol: number;
}> {
  const { userWallet, poolAddress, lpTokenAmount, slippage = 1 } = params;
  const connection = getConnection();
  const user = new PublicKey(userWallet);
  const poolKey = new PublicKey(poolAddress);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const offlineSdk = PUMP_AMM_SDK;

  const liqState = await onlineSdk.liquiditySolanaState(poolKey, user);

  const lpAmount = new BN(lpTokenAmount);
  const withdrawCalc = offlineSdk.withdrawInputs(liqState, lpAmount, slippage);

  // Build instructions
  const instructions: TransactionInstruction[] = [];

  // 1. Withdraw instruction
  const withdrawIxs = await offlineSdk.withdrawInstructionsInternal(
    liqState,
    lpAmount,
    withdrawCalc.minBase,
    withdrawCalc.minQuote
  );
  instructions.push(...withdrawIxs);

  // 2. Fee transfer (0.5% of quote/SOL output)
  const estimatedQuoteLamports = withdrawCalc.quote.toNumber();
  const feeLamports = Math.floor(estimatedQuoteLamports * (FEE_BPS / 10000));
  const estimatedSolValue = estimatedQuoteLamports / LAMPORTS_PER_SOL;
  const feeSol = feeLamports / LAMPORTS_PER_SOL;

  if (feeLamports > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: FEE_ACCOUNT,
        lamports: feeLamports,
      })
    );
  }

  const tx = new Transaction();
  tx.add(...instructions);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString("base64"),
    estimatedBaseOut: withdrawCalc.base.toString(),
    estimatedQuoteOut: withdrawCalc.quote.toString(),
    estimatedSolValue,
    feeSol,
  };
}

// ── GET POOL QUOTE (preview, no TX) ──

export async function getDepositQuote(params: {
  poolAddress: string;
  amountSol: number;
  slippage?: number;
}): Promise<{
  feeSol: number;
  netAmountSol: number;
  estimatedLpTokens: string;
  estimatedBaseAmount: string;
  estimatedQuoteAmount: string;
  poolReserveBase: string;
  poolReserveQuote: string;
  lpSupply: string;
}> {
  const { poolAddress, amountSol, slippage = 1 } = params;
  const connection = getConnection();
  const poolKey = new PublicKey(poolAddress);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const offlineSdk = PUMP_AMM_SDK;
  const pool = await onlineSdk.fetchPool(poolKey);

  // Use a dummy user for quote calculation — we only need pool state
  const dummyUser = new PublicKey("11111111111111111111111111111111");

  const feeSol = amountSol * (FEE_BPS / 10000);
  const netSol = amountSol - feeSol;
  const quoteAmount = new BN(Math.floor(netSol * LAMPORTS_PER_SOL));

  // Get pool reserves from on-chain accounts
  const baseAccount = await connection.getTokenAccountBalance(pool.poolBaseTokenAccount);
  const quoteAccount = await connection.getTokenAccountBalance(pool.poolQuoteTokenAccount);

  const baseReserve = new BN(baseAccount.value.amount);
  const quoteReserve = new BN(quoteAccount.value.amount);

  // Calculate deposit from quote input
  const depositCalc = depositLpToken(
    quoteAmount,
    slippage,
    baseReserve,
    quoteReserve,
    pool.lpSupply
  );

  return {
    feeSol,
    netAmountSol: netSol,
    estimatedLpTokens: quoteAmount.toString(), // Approximation
    estimatedBaseAmount: depositCalc.maxBase.toString(),
    estimatedQuoteAmount: depositCalc.maxQuote.toString(),
    poolReserveBase: baseReserve.toString(),
    poolReserveQuote: quoteReserve.toString(),
    lpSupply: pool.lpSupply.toString(),
  };
}

// ── GET USER LP POSITIONS ──

export async function getUserPositions(wallet: string): Promise<any[]> {
  const rows = db.prepare(
    "SELECT * FROM lp_positions WHERE wallet = ? AND status = 'active' ORDER BY entry_at DESC"
  ).all(wallet) as any[];
  log.info({ wallet: wallet.slice(0, 8), found: rows.length }, "getUserPositions called");
  return rows;
}

export async function getAllUserPositions(wallet: string): Promise<any[]> {
  return db.prepare(
    "SELECT * FROM lp_positions WHERE wallet = ? ORDER BY entry_at DESC"
  ).all(wallet) as any[];
}

// ── RECORD POSITION ──

export function recordDeposit(params: {
  wallet: string;
  poolAddress: string;
  tokenMint: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  lpTokens: string;
  baseAmount: string;
  quoteAmount: string;
  solValue: number;
  priceUsd: number | null;
  txSignature: string;
  feeSol: number;
}): void {
  insertPosition.run({
    wallet: params.wallet,
    pool_address: params.poolAddress,
    token_mint: params.tokenMint,
    token_name: params.tokenName,
    token_symbol: params.tokenSymbol,
    lp_tokens: params.lpTokens,
    entry_base_amount: params.baseAmount,
    entry_quote_amount: params.quoteAmount,
    entry_sol_value: params.solValue,
    entry_price_usd: params.priceUsd,
    entry_tx: params.txSignature,
    fees_paid_entry: params.feeSol,
  });
}

export function recordWithdrawal(params: {
  positionId: number;
  txSignature: string;
  baseAmount: string;
  quoteAmount: string;
  solValue: number;
  feeSol: number;
}): void {
  const position = getPositionById.get(params.positionId) as any;
  if (!position) return;

  const pnlSol = params.solValue - (position.entry_sol_value ?? 0) - params.feeSol - (position.fees_paid_entry ?? 0);
  const pnlPct = position.entry_sol_value > 0
    ? (pnlSol / position.entry_sol_value) * 100
    : 0;

  updatePositionExit.run({
    id: params.positionId,
    exit_tx: params.txSignature,
    exit_base_amount: params.baseAmount,
    exit_quote_amount: params.quoteAmount,
    exit_sol_value: params.solValue,
    pnl_sol: pnlSol,
    pnl_pct: pnlPct,
    fees_paid_exit: params.feeSol,
  });
}

// ── GET LIVE PNL ──

/** Format SOL with up to 8 decimals, trimming trailing zeros but keeping at least 2 */
function formatSolPrecise(sol: number): string {
  if (sol === 0) return "0.00";
  // Use 8 decimals so tiny fees like 0.00000034 are visible
  const s = sol.toFixed(8);
  // Trim trailing zeros but keep at least 2 decimal places
  const [int, dec] = s.split(".");
  const trimmed = dec.replace(/0+$/, "").padEnd(2, "0");
  return `${int}.${trimmed}`;
}

/** Format a tiny USD amount with enough precision to be meaningful */
function formatUsdPrecise(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  // For very tiny amounts show up to 6 decimals
  return `$${usd.toFixed(6)}`;
}

export async function getLivePositionPnl(position: any): Promise<{
  currentBaseAmount: string;
  currentQuoteAmount: string;
  currentSolValue: number;
  onChainLpBalance: string;
  unrealizedPnlSol: number;
  unrealizedPnlPct: number;
  feesEarned: number;
  feesEarnedFormatted: string;
  feesEarnedUsd: string;
  estimatedDailyFeesSol: number;
  estimatedDailyFeesFormatted: string;
  apr: number;
  smallPositionWarning: string | null;
} | null> {
  try {
    const connection = getConnection();
    const poolKey = new PublicKey(position.pool_address);
    const userKey = new PublicKey(position.wallet);

    const onlineSdk = new OnlinePumpAmmSdk(connection);

    // Use liquiditySolanaState for accurate on-chain position data
    const liqState = await onlineSdk.liquiditySolanaState(poolKey, userKey);
    const pool = liqState.pool;
    const lpSupply = pool.lpSupply;
    if (lpSupply.isZero()) return null;

    // Read actual reserves from liquiditySolanaState accounts
    const baseReserve = new BN(liqState.poolBaseTokenAccount.amount.toString());
    const quoteReserve = new BN(liqState.poolQuoteTokenAccount.amount.toString());

    // Read actual on-chain LP balance (handles partial withdrawals, transfers)
    // Parse raw SPL token account data: amount is bytes 64-72 (little-endian u64)
    let onChainLpBalance = new BN(0);
    if (liqState.userPoolAccountInfo && liqState.userPoolAccountInfo.data.length >= 72) {
      const buf = liqState.userPoolAccountInfo.data;
      const lo = buf.readUInt32LE(64);
      const hi = buf.readUInt32LE(68);
      onChainLpBalance = new BN(hi).shln(32).add(new BN(lo));
    }

    // Use on-chain LP balance if available, fall back to recorded amount
    const userLp = onChainLpBalance.isZero()
      ? new BN(position.lp_tokens)
      : onChainLpBalance;

    // Calculate user's share of pool via SDK state
    const currentBase = userLp.mul(baseReserve).div(lpSupply);
    const currentQuote = userLp.mul(quoteReserve).div(lpSupply);

    // Current value: both sides converted to SOL
    const currentQuoteSol = currentQuote.toNumber() / LAMPORTS_PER_SOL;
    const basePrice = quoteReserve.toNumber() / baseReserve.toNumber();
    const currentBaseSol = (currentBase.toNumber() * basePrice) / LAMPORTS_PER_SOL;
    const currentSolValue = currentQuoteSol + currentBaseSol;

    const entrySolValue = position.entry_sol_value ?? 0;
    const totalPlatformFees = position.fees_paid_entry ?? 0;
    const unrealizedPnlSol = currentSolValue - entrySolValue - totalPlatformFees;
    const unrealizedPnlPct = entrySolValue > 0
      ? (unrealizedPnlSol / entrySolValue) * 100
      : 0;

    // ── FEE CALCULATION: value-based with IL decomposition ──
    // In a constant-product AMM, LP fees accumulate in reserves.
    // fees_earned = current_value - entry_value_after_IL
    // IL factor = 2 * sqrt(r) / (1 + r) where r = current_price / entry_price
    const entryBase = parseFloat(position.entry_base_amount || "0");
    const entryQuote = parseFloat(position.entry_quote_amount || "0");

    let feesEarned = 0;
    if (entryBase > 0 && entryQuote > 0 && entrySolValue > 0) {
      const entryPrice = entryQuote / entryBase;
      const currentPrice = quoteReserve.toNumber() / baseReserve.toNumber();
      const priceRatio = currentPrice / entryPrice;

      // IL factor: what fraction of held-value would an LP have without fees
      const ilFactor = 2 * Math.sqrt(priceRatio) / (1 + priceRatio);
      // Value if held outside pool at current prices (no IL, no fees)
      const heldValue = (entryBase * currentPrice + entryQuote) / LAMPORTS_PER_SOL;
      // Value position would have with IL but without fees
      const valueWithIlNoFees = heldValue * ilFactor;
      // Fees = actual current value minus what it would be without fees
      feesEarned = Math.max(0, currentSolValue - valueWithIlNoFees);
    }

    // Fallback: if value-based calc gives 0 (e.g. missing entry data), use volume estimate
    if (feesEarned === 0) {
      try {
        const userShare = userLp.toNumber() / lpSupply.toNumber();
        const entryTime = position.entry_at ? new Date(position.entry_at + "Z").getTime() : Date.now();
        const hoursActive = Math.max(1, (Date.now() - entryTime) / (1000 * 60 * 60));
        const poolRow = db.prepare(
          "SELECT current_volume_24h FROM pumpswap_pools WHERE pool_address = ?"
        ).get(position.pool_address) as any;
        const vol24h = poolRow?.current_volume_24h ?? 0;
        const volumeInPeriod = vol24h * (hoursActive / 24);
        feesEarned = (volumeInPeriod * 0.002 * userShare) / 1_000_000_000;
      } catch {}
    }

    // Get APR from DB
    let apr = 0;
    try {
      const poolRow = db.prepare(
        "SELECT current_apr, current_tvl_usd FROM pumpswap_pools WHERE pool_address = ?"
      ).get(position.pool_address) as any;
      apr = poolRow?.current_apr ?? 0;
    } catch {}

    // Fee projection based on APR
    const dailyFeeRate = apr > 0 ? apr / 365 / 100 : 0;
    const estimatedDailyFeesSol = currentSolValue * dailyFeeRate;

    // SOL price for USD display
    let solPriceUsd = 0;
    try {
      const priceRow = db.prepare(
        "SELECT current_tvl_usd FROM pumpswap_pools WHERE pool_address = ? AND current_tvl_usd > 0"
      ).get(position.pool_address) as any;
      if (priceRow) {
        const totalPoolSol = quoteReserve.toNumber() / LAMPORTS_PER_SOL * 2;
        if (totalPoolSol > 0) solPriceUsd = priceRow.current_tvl_usd / totalPoolSol;
      }
    } catch {}
    if (solPriceUsd <= 0) solPriceUsd = 150;

    // Small position warning
    let smallPositionWarning: string | null = null;
    if (currentSolValue < 0.1) {
      smallPositionWarning = "Small position — fees will be minimal. Recommended minimum: 0.5 SOL";
    }

    return {
      currentBaseAmount: currentBase.toString(),
      currentQuoteAmount: currentQuote.toString(),
      currentSolValue,
      onChainLpBalance: onChainLpBalance.toString(),
      unrealizedPnlSol,
      unrealizedPnlPct,
      feesEarned,
      feesEarnedFormatted: `${formatSolPrecise(feesEarned)} SOL`,
      feesEarnedUsd: formatUsdPrecise(feesEarned * solPriceUsd),
      estimatedDailyFeesSol,
      estimatedDailyFeesFormatted: `At current APR: ~${formatSolPrecise(estimatedDailyFeesSol)} SOL/day`,
      apr,
      smallPositionWarning,
    };
  } catch (err: any) {
    log.warn({ err: err.message, pool: position.pool_address }, "Failed to get live PnL");
    return null;
  }
}

// ── UPGRADE 2: APE QUOTE WITH PRICE IMPACT ──

export async function getApeQuote(params: {
  poolAddress: string;
  userWallet: string;
  amountSol: number;
  slippage?: number;
}): Promise<{
  tokensReceived: string;
  tokensReceivedUi: number;
  priceImpactPct: number;
  feeSol: number;
  netSol: number;
  spotPrice: number;
  executionPrice: number;
  highImpactWarning: string | null;
  poolCreator: string;
  isMayhemMode: boolean;
}> {
  const { poolAddress, userWallet, amountSol, slippage = 2 } = params;
  const connection = getConnection();
  const user = new PublicKey(userWallet);
  const poolKey = new PublicKey(poolAddress);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const swapState = await onlineSdk.swapSolanaState(poolKey, user);

  const feeSol = amountSol * (FEE_BPS / 10000);
  const netSol = amountSol - feeSol;
  const quoteAmount = new BN(Math.floor(netSol * LAMPORTS_PER_SOL));

  // Spot price before swap (SOL per token in lamports)
  const baseReserve = swapState.poolBaseAmount;
  const quoteReserve = swapState.poolQuoteAmount;
  const spotPrice = quoteReserve.toNumber() / baseReserve.toNumber();

  // Use SDK's buyQuoteInput for exact calculation with fee tiers
  const result = buyQuoteInput({
    quote: quoteAmount,
    slippage,
    baseReserve,
    quoteReserve,
    globalConfig: swapState.globalConfig,
    baseMintAccount: swapState.baseMintAccount,
    baseMint: swapState.baseMint,
    coinCreator: swapState.pool.coinCreator,
    creator: swapState.pool.creator,
    feeConfig: swapState.feeConfig,
  });

  const tokensReceived = result.base;
  const tokensReceivedNum = tokensReceived.toNumber();

  // Execution price = quote spent / base received
  const executionPrice = tokensReceivedNum > 0
    ? quoteAmount.toNumber() / tokensReceivedNum
    : spotPrice;

  // Price impact = (executionPrice - spotPrice) / spotPrice * 100
  const priceImpactPct = spotPrice > 0
    ? ((executionPrice - spotPrice) / spotPrice) * 100
    : 0;

  // Token decimals from mint account
  const decimals = swapState.baseMintAccount.decimals;
  const tokensReceivedUi = tokensReceivedNum / Math.pow(10, decimals);

  let highImpactWarning: string | null = null;
  if (priceImpactPct > 10) {
    highImpactWarning = `Extreme price impact (${priceImpactPct.toFixed(1)}%) — you will lose significant value`;
  } else if (priceImpactPct > 3) {
    highImpactWarning = `High price impact (${priceImpactPct.toFixed(1)}%) — consider a smaller amount`;
  }

  return {
    tokensReceived: tokensReceived.toString(),
    tokensReceivedUi,
    priceImpactPct: parseFloat(priceImpactPct.toFixed(2)),
    feeSol,
    netSol,
    spotPrice,
    executionPrice,
    highImpactWarning,
    poolCreator: swapState.pool.creator.toBase58(),
    isMayhemMode: swapState.pool.isMayhemMode,
  };
}

// ── UPGRADE 3: SMART DEPOSIT CALCULATOR ──

export async function getSmartDepositQuote(params: {
  poolAddress: string;
  userWallet: string;
  amountSol: number;
  slippage?: number;
}): Promise<{
  solNeeded: number;
  tokenNeeded: string;
  tokenNeededUi: number;
  tokenSymbol: string | null;
  lpTokensReceived: string;
  poolSharePct: number;
  userTokenBalance: number;
  tokenShortfall: number;
  needsMoreToken: boolean;
  feeSol: number;
  poolCreator: string;
  isMayhemMode: boolean;
}> {
  const { poolAddress, userWallet, amountSol, slippage = 1 } = params;
  const connection = getConnection();
  const user = new PublicKey(userWallet);
  const poolKey = new PublicKey(poolAddress);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const offlineSdk = PUMP_AMM_SDK;
  const liqState = await onlineSdk.liquiditySolanaState(poolKey, user);

  const feeSol = amountSol * (FEE_BPS / 10000);
  const netSol = amountSol - feeSol;
  const quoteAmount = new BN(Math.floor(netSol * LAMPORTS_PER_SOL));

  // Use SDK autocomplete: given SOL (quote), calculate base needed + LP tokens
  const calc = offlineSdk.depositAutocompleteBaseAndLpTokenFromQuote(
    liqState,
    quoteAmount,
    slippage,
  );

  const baseNeeded = calc.base;
  const lpTokens = calc.lpToken;

  // Pool share after deposit
  const currentLpSupply = liqState.pool.lpSupply;
  const newLpSupply = currentLpSupply.add(lpTokens);
  const poolSharePct = newLpSupply.isZero()
    ? 0
    : (lpTokens.toNumber() / newLpSupply.toNumber()) * 100;

  // Check user's current token balance (parse raw SPL account: amount at bytes 64-72)
  let userTokenBalance = 0;
  if (liqState.userBaseAccountInfo && liqState.userBaseAccountInfo.data.length >= 72) {
    try {
      const buf = liqState.userBaseAccountInfo.data;
      const lo = buf.readUInt32LE(64);
      const hi = buf.readUInt32LE(68);
      userTokenBalance = new BN(hi).shln(32).add(new BN(lo)).toNumber();
    } catch {}
  }

  const baseNeededNum = baseNeeded.toNumber();
  const tokenShortfall = Math.max(0, baseNeededNum - userTokenBalance);

  // Get token symbol from DB
  const poolRow = db.prepare(
    "SELECT token_symbol FROM pumpswap_pools WHERE pool_address = ?"
  ).get(poolAddress) as any;

  return {
    solNeeded: netSol,
    tokenNeeded: baseNeeded.toString(),
    tokenNeededUi: baseNeededNum / LAMPORTS_PER_SOL, // approximate, depends on decimals
    tokenSymbol: poolRow?.token_symbol ?? null,
    lpTokensReceived: lpTokens.toString(),
    poolSharePct: parseFloat(poolSharePct.toFixed(4)),
    userTokenBalance,
    tokenShortfall,
    needsMoreToken: tokenShortfall > 0,
    feeSol,
    poolCreator: liqState.pool.creator.toBase58(),
    isMayhemMode: liqState.pool.isMayhemMode,
  };
}

// ── LOOKUP POOL BY TOKEN MINT (derives PDA, fetches on-chain) ──

export async function lookupPoolByMint(tokenMint: string): Promise<{
  poolAddress: string;
  tokenMint: string;
  creator: string;
  coinCreator: string;
  isMayhemMode: boolean;
  lpSupply: string;
  baseReserve: string;
  quoteReserve: string;
  tvlSol: number;
  estimatedApr: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  createdAt: string | null;
} | null> {
  try {
    const connection = getConnection();
    const mintKey = new PublicKey(tokenMint);
    const poolPda = canonicalPumpPoolPda(mintKey);
    const poolAddress = poolPda.toBase58();

    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const pool = await onlineSdk.fetchPool(poolPda);

    const [baseAccount, quoteAccount] = await Promise.all([
      connection.getTokenAccountBalance(pool.poolBaseTokenAccount),
      connection.getTokenAccountBalance(pool.poolQuoteTokenAccount),
    ]);

    const quoteSol = parseInt(quoteAccount.value.amount) / 1e9;
    const tvlSol = quoteSol * 2;

    // Get pool creation time from earliest transaction signature
    let createdAt: string | null = null;
    try {
      // Walk backwards to find the earliest signature
      let allSigs = await connection.getSignaturesForAddress(poolPda, { limit: 1000 }, "confirmed");
      if (allSigs.length > 0) {
        const earliest = allSigs[allSigs.length - 1];
        if (earliest.blockTime) {
          createdAt = new Date(earliest.blockTime * 1000).toISOString().replace("T", " ").replace(/\.\d+Z/, "");
        }
      }
    } catch {}

    // Calculate APR from DexScreener volume/liquidity (same formula as pumpswapMonitor)
    let estimatedApr: number | null = null;
    let volume24h: number | null = null;
    let liquidityUsd: number | null = null;
    let marketCapUsd: number | null = null;
    try {
      const { data: dexData } = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${tokenMint}`,
        { timeout: 8000 }
      );
      const pairs = Array.isArray(dexData) ? dexData : dexData?.pairs ?? [];
      if (pairs.length) {
        const top = pairs[0];
        volume24h = top.volume?.h24 ?? null;
        liquidityUsd = top.liquidity?.usd ?? null;
        marketCapUsd = top.marketCap ?? top.fdv ?? null;
        if (volume24h && liquidityUsd && liquidityUsd > 0) {
          const feeTier = 0.0025; // 0.25%
          const dailyFees = volume24h * feeTier;
          estimatedApr = (dailyFees / liquidityUsd) * 365 * 100;
        }
      }
    } catch {}

    return {
      poolAddress,
      tokenMint,
      creator: pool.creator.toBase58(),
      coinCreator: pool.coinCreator.toBase58(),
      isMayhemMode: pool.isMayhemMode,
      lpSupply: pool.lpSupply.toString(),
      baseReserve: baseAccount.value.amount,
      quoteReserve: quoteAccount.value.amount,
      tvlSol,
      estimatedApr,
      volume24h,
      liquidityUsd,
      marketCapUsd,
      createdAt,
    };
  } catch (err: any) {
    log.warn({ err: err.message, mint: tokenMint }, "Pool not found for token mint");
    return null;
  }
}

// ── UPGRADE 4 & 5: READ ON-CHAIN POOL STATE (creator, mayhem mode) ──

export async function getOnChainPoolState(poolAddress: string): Promise<{
  creator: string;
  coinCreator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  lpSupply: string;
  baseReserve: string;
  quoteReserve: string;
} | null> {
  try {
    const connection = getConnection();
    const poolKey = new PublicKey(poolAddress);
    const onlineSdk = new OnlinePumpAmmSdk(connection);
    const pool = await onlineSdk.fetchPool(poolKey);

    const baseAccount = await connection.getTokenAccountBalance(pool.poolBaseTokenAccount);
    const quoteAccount = await connection.getTokenAccountBalance(pool.poolQuoteTokenAccount);

    return {
      creator: pool.creator.toBase58(),
      coinCreator: pool.coinCreator.toBase58(),
      isMayhemMode: pool.isMayhemMode,
      isCashbackCoin: pool.isCashbackCoin,
      lpSupply: pool.lpSupply.toString(),
      baseReserve: baseAccount.value.amount,
      quoteReserve: quoteAccount.value.amount,
    };
  } catch (err: any) {
    log.warn({ err: err.message, pool: poolAddress }, "Failed to fetch on-chain pool state");
    return null;
  }
}
