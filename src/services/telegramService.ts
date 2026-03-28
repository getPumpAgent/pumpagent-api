import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("telegram");

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL_ID;
const loreKey = process.env.LORE_API_KEY;
const loreUrl = process.env.LORE_API_URL;

let bot: TelegramBot | null = null;
if (token) {
  bot = new TelegramBot(token, { polling: false });
}

// ── RATE LIMITING ──

let lastSentAt = 0;
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between alerts

function countAlertsLastHour(): number {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM telegram_sent WHERE sent_at > datetime('now', '-1 hour')"
  ).get() as any;
  return row?.cnt ?? 0;
}

function wasRecentlySent(mint: string): boolean {
  const row = db.prepare(
    "SELECT id FROM telegram_sent WHERE mint = ? AND sent_at > datetime('now', '-3 hours')"
  ).get(mint) as any;
  return !!row;
}

function recordSent(mint: string, score: number, format: string, mcap: number | null): void {
  db.prepare("INSERT INTO telegram_sent (mint, score, format_used, mcap_at_signal) VALUES (?, ?, ?, ?)").run(mint, score, format, mcap ?? null);
  lastSentAt = Date.now();
}

// ── SIGNAL SOURCES ──

interface TokenSignal {
  mint: string;
  name: string;
  symbol: string;
  image?: string | null;
  marketCap?: number | null;
  volume1h?: number | null;
  volume24h?: number | null;
  age?: number | null;
  riskScore?: number | null;
  riskTier?: string | null;
  kolCount?: number | null;
  kolElite?: number | null;
  isBoosted?: boolean;
  isMomentum?: boolean;
  isDegen?: boolean;
  source: string;
}

async function fetchLorePicks(): Promise<TokenSignal[]> {
  if (!loreUrl || !loreKey) return [];
  const signals: TokenSignal[] = [];
  const headers = { Authorization: `Bearer ${loreKey}` };

  try {
    // Feature boxes (momentum + degen)
    const { data: boxes } = await axios.get(`${loreUrl}/api/feature-boxes/current`, { headers, timeout: 6000 });
    if (boxes?.Fastest?.address) {
      const na = boxes.Fastest.narrativeAnalysis?.comprehensive;
      signals.push({
        mint: boxes.Fastest.address,
        name: na?.threeWords?.join(" ") ?? "Momentum Pick",
        symbol: na?.threeWords?.[0] ?? "???",
        isMomentum: true,
        source: "momentum",
      });
    }
    if (boxes?.Gamble?.address) {
      const na = boxes.Gamble.narrativeAnalysis?.comprehensive;
      signals.push({
        mint: boxes.Gamble.address,
        name: na?.threeWords?.join(" ") ?? "Degen Pick",
        symbol: na?.threeWords?.[0] ?? "???",
        isDegen: true,
        source: "degen",
      });
    }

    // KOL scan
    const { data: kols } = await axios.get(`${loreUrl}/api/market/kolscan`, { headers, timeout: 6000 });
    if (Array.isArray(kols)) {
      for (const k of kols.slice(0, 10)) {
        signals.push({
          mint: k.coinMint,
          name: k.name,
          symbol: k.ticker,
          image: k.imageUrl,
          marketCap: k.marketCap,
          kolCount: k.numKolsTraded,
          kolElite: k.numKolsTraded,
          age: k.creationTime ? Math.floor((Date.now() - k.creationTime) / 1000) : null,
          source: "kolscan",
        });
      }
    }
  } catch (err: any) {
    log.warn({ err: err.message }, "Failed to fetch upstream picks");
  }
  return signals;
}

async function fetchDexScreenerBoosts(): Promise<TokenSignal[]> {
  try {
    const { data } = await axios.get("https://api.dexscreener.com/token-boosts/latest/v1", { timeout: 6000 });
    const solTokens = (data ?? []).filter((t: any) => t.chainId === "solana");
    return solTokens.slice(0, 10).map((t: any) => ({
      mint: t.tokenAddress,
      name: t.description?.split(" ").slice(0, 3).join(" ") || "Boosted Token",
      symbol: "???",
      isBoosted: true,
      source: "dexscreener_boost",
    }));
  } catch {
    return [];
  }
}

async function fetchFreshLaunches(): Promise<TokenSignal[]> {
  try {
    const { data } = await axios.get("https://api.pumpapi.markets/v1/tokens/new", { timeout: 6000 });
    return (data.tokens ?? []).map((t: any) => ({
      mint: t.mint,
      name: t.name ?? "Unknown",
      symbol: t.symbol ?? "???",
      image: t.image,
      age: t.age,
      source: "fresh_launch",
    }));
  } catch {
    return [];
  }
}

// ── ENRICHMENT ──

async function enrichToken(signal: TokenSignal): Promise<TokenSignal> {
  try {
    const { data } = await axios.get(`https://api.pumpapi.markets/v1/tokens/${signal.mint}`, { timeout: 6000 });
    signal.marketCap = signal.marketCap ?? data.fdv ?? null;
    signal.volume24h = data.volume24h ?? null;
    signal.riskScore = data.risk?.score ?? null;
    signal.riskTier = data.risk?.tier ?? null;
    signal.kolElite = signal.kolElite ?? data.kolSignal?.eliteCount ?? null;
    if (!signal.name || signal.name === "Unknown") signal.name = data.name ?? signal.name;
    if (signal.symbol === "???") signal.symbol = data.symbol ?? signal.symbol;
  } catch {}
  return signal;
}

// ── SCORING ──

function scoreSignal(s: TokenSignal): number {
  let score = 0;
  if (s.isMomentum || s.isDegen) score += 30;
  if ((s.kolElite ?? 0) > 3) score += 20;
  if (s.isBoosted) score += 15;
  if ((s.riskScore ?? 100) < 30) score += 10;
  if (s.age != null && s.age < 300) score += 10;
  if ((s.volume24h ?? 0) > 50000) score += 10;
  if ((s.riskScore ?? 0) > 60) score -= 20;
  if (s.age != null && s.age > 1800) score -= 30;
  return score;
}

// ── ALERT FORMATTING ──

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtAge(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

type FormatName = "kol" | "momentum" | "fresh" | "boost";

function formatKol(s: TokenSignal, score: number): string {
  return `🐋 *SMART MONEY ALERT*

*${esc(s.name)}* (${esc(s.symbol)})
━━━━━━━━━━━━━━━
👥 Elite wallets: ${s.kolElite ?? s.kolCount ?? "—"}
📊 MCap: ${fmt(s.marketCap)}
⏱ Age: ${fmtAge(s.age)}
🛡 Risk: ${esc(s.riskTier?.toUpperCase() ?? "—")}

[Open Trade →](https://pumpapi.markets/swap?token=${s.mint})`;
}

function formatMomentum(s: TokenSignal, score: number): string {
  return `⚡ *MOMENTUM SIGNAL*

*${esc(s.name)}* (${esc(s.symbol)})
━━━━━━━━━━━━━━━
📈 Score: ${score}/100
💰 Volume: ${fmt(s.volume24h)}
📊 MCap: ${fmt(s.marketCap)}
🔥 Confidence: ${score >= 60 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW"}

[Open Trade →](https://pumpapi.markets/swap?token=${s.mint})`;
}

function formatFresh(s: TokenSignal, score: number): string {
  return `🚀 *FRESH LAUNCH DETECTED*

*${esc(s.name)}* (${esc(s.symbol)})
━━━━━━━━━━━━━━━
⏱ Age: ${fmtAge(s.age)}
📊 MCap: ${fmt(s.marketCap)}
🛡 Risk Score: ${s.riskScore ?? "—"}/100
👥 KOL Interest: ${s.kolElite ?? 0} wallets

[Open Trade →](https://pumpapi.markets/swap?token=${s.mint})`;
}

function formatBoost(s: TokenSignal, score: number): string {
  return `💥 *BOOST DETECTED*

*${esc(s.name)}* (${esc(s.symbol)})
━━━━━━━━━━━━━━━
🚀 DexScreener boost active
📊 MCap: ${fmt(s.marketCap)}
⏱ Age: ${fmtAge(s.age)}
📈 Score: ${score}/100

[Open Trade →](https://pumpapi.markets/swap?token=${s.mint})`;
}

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function pickFormat(s: TokenSignal): { text: string; name: FormatName } {
  // Pick best format based on signal source, with randomization
  const rand = Math.random();

  if (s.isBoosted && rand < 0.6) return { text: formatBoost(s, scoreSignal(s)), name: "boost" };
  if ((s.kolElite ?? 0) > 3 && rand < 0.5) return { text: formatKol(s, scoreSignal(s)), name: "kol" };
  if (s.age != null && s.age < 300 && rand < 0.5) return { text: formatFresh(s, scoreSignal(s)), name: "fresh" };
  if (s.isMomentum || s.isDegen) return { text: formatMomentum(s, scoreSignal(s)), name: "momentum" };

  // Fallback: rotate randomly
  const formats: [typeof formatKol, FormatName][] = [
    [formatKol, "kol"], [formatMomentum, "momentum"], [formatFresh, "fresh"], [formatBoost, "boost"],
  ];
  const pick = formats[Math.floor(Math.random() * formats.length)];
  return { text: pick[0](s, scoreSignal(s)), name: pick[1] };
}

// ── SEND ──

async function sendAlert(text: string): Promise<boolean> {
  if (!bot || !channelId) return false;
  try {
    await bot.sendMessage(channelId, text, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    });
    return true;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to send Telegram alert");
    // Retry with plain text if markdown fails
    try {
      const plain = text.replace(/[*_`\[\]()\\]/g, "");
      await bot.sendMessage(channelId, plain);
      return true;
    } catch {
      return false;
    }
  }
}

// ── MAIN SIGNAL CYCLE ──

export async function runSignalCycle(): Promise<{ checked: number; sent: boolean; topMint?: string; topScore?: number }> {
  if (!bot || !channelId) {
    return { checked: 0, sent: false };
  }

  // Rate limit: 5 min between alerts, 8 per hour
  if (Date.now() - lastSentAt < MIN_INTERVAL_MS) {
    return { checked: 0, sent: false };
  }
  if (countAlertsLastHour() >= 8) {
    return { checked: 0, sent: false };
  }

  // Gather signals from all sources in parallel
  const [lorePicks, boosts, freshLaunches] = await Promise.all([
    fetchLorePicks(),
    fetchDexScreenerBoosts(),
    fetchFreshLaunches(),
  ]);

  // Deduplicate by mint
  const allSignals = new Map<string, TokenSignal>();
  for (const s of [...lorePicks, ...boosts, ...freshLaunches]) {
    if (!s.mint) continue;
    const existing = allSignals.get(s.mint);
    if (existing) {
      // Merge: keep higher-value fields
      if (s.isMomentum) existing.isMomentum = true;
      if (s.isDegen) existing.isDegen = true;
      if (s.isBoosted) existing.isBoosted = true;
      if (s.kolCount && (!existing.kolCount || s.kolCount > existing.kolCount)) {
        existing.kolCount = s.kolCount;
        existing.kolElite = s.kolElite;
      }
      if (s.marketCap && !existing.marketCap) existing.marketCap = s.marketCap;
      if (s.age != null && existing.age == null) existing.age = s.age;
    } else {
      allSignals.set(s.mint, { ...s });
    }
  }

  // Filter already sent
  const candidates = [...allSignals.values()].filter((s) => !wasRecentlySent(s.mint));

  if (!candidates.length) {
    return { checked: allSignals.size, sent: false };
  }

  // Enrich top candidates with token detail data
  const toEnrich = candidates.slice(0, 8);
  await Promise.all(toEnrich.map(enrichToken));

  // Score and sort
  const scored = toEnrich.map((s) => ({ signal: s, score: scoreSignal(s) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { checked: allSignals.size, sent: false };
  }

  const best = scored[0];
  const { text, name: formatName } = pickFormat(best.signal);

  // Random delay 2-8 minutes
  const delayMs = (2 + Math.random() * 6) * 60 * 1000;

  setTimeout(async () => {
    // Re-check rate limits after delay
    if (Date.now() - lastSentAt < MIN_INTERVAL_MS) return;
    if (countAlertsLastHour() >= 8) return;
    if (wasRecentlySent(best.signal.mint)) return;

    const success = await sendAlert(text);
    if (success) {
      recordSent(best.signal.mint, best.score, formatName, best.signal.marketCap ?? null);
      log.info({ mint: best.signal.mint, score: best.score, format: formatName }, "Alert sent");
      // Schedule 30-min followup check
      scheduleFollowup(best.signal.mint);
    }
  }, delayMs);

  return {
    checked: allSignals.size,
    sent: true,
    topMint: best.signal.mint,
    topScore: best.score,
  };
}

// ── FOLLOWUP SYSTEM (30-min price check) ──

const CONGRATS_MESSAGES = [
  "This one's cooking\\. PumpAgent called it first\\.",
  "Early bird gets the gains\\. PumpAgent signals hit different\\.",
  "Up over 50%\\. The signal was right there\\.",
  "Another one\\. PumpAgent doesn't miss\\.",
  "Called it 30 minutes ago\\. You're welcome\\.",
  "Momentum confirmed\\. The feed stays undefeated\\.",
  "Pumping exactly like the signal said\\.",
  "50%\\+ and climbing\\. This is what the terminal is for\\.",
  "The signal fired\\. The chart followed\\. Simple as\\.",
  "Green candles printing\\. PumpAgent Intelligence strikes again\\.",
];

function pickCongrats(): string {
  return CONGRATS_MESSAGES[Math.floor(Math.random() * CONGRATS_MESSAGES.length)];
}

function formatFollowup(mint: string, name: string, symbol: string, pctGain: number, mcapNow: number | null): string {
  const pct = `\\+${pctGain.toFixed(0)}%`;
  return `🎯 *SIGNAL UPDATE*

*${esc(name)}* \\(${esc(symbol)}\\) is up *${pct}* since we called it\\.

${pickCongrats()}

📊 MCap now: ${fmt(mcapNow)}

[More Signals →](https://pumpapi.markets/swap)`;
}

function scheduleFollowup(mint: string): void {
  // Check at 30 minutes
  setTimeout(async () => {
    await checkFollowup(mint);
  }, 30 * 60 * 1000);
}

async function checkFollowup(mint: string): Promise<void> {
  if (!bot || !channelId) return;

  // Get the original signal record
  const record = db.prepare(
    "SELECT * FROM telegram_sent WHERE mint = ? AND followup_sent = 0 ORDER BY sent_at DESC LIMIT 1"
  ).get(mint) as any;

  if (!record || !record.mcap_at_signal) return;

  // Fetch current price
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { timeout: 6000 });
    const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
    if (!pairs.length) return;

    const currentMcap = pairs[0].marketCap ?? pairs[0].fdv ?? null;
    if (!currentMcap) return;

    const pctGain = ((currentMcap - record.mcap_at_signal) / record.mcap_at_signal) * 100;

    if (pctGain >= 50) {
      const name = pairs[0].baseToken?.name ?? "Token";
      const symbol = pairs[0].baseToken?.symbol ?? "???";
      const text = formatFollowup(mint, name, symbol, pctGain, currentMcap);
      const success = await sendAlert(text);
      if (success) {
        db.prepare("UPDATE telegram_sent SET followup_sent = 1 WHERE id = ?").run(record.id);
        log.info({ mint, pctGain: pctGain.toFixed(0) }, "Followup alert sent");
      }
    } else {
      log.info({ mint, pctGain: pctGain.toFixed(0) }, "Followup check: below 50% threshold");
    }
  } catch (err: any) {
    log.warn({ err: err.message, mint }, "Followup check failed");
  }
}

// Also check any pending followups on startup (signals sent before last restart)
async function checkPendingFollowups(): Promise<void> {
  const pending = db.prepare(
    "SELECT * FROM telegram_sent WHERE followup_sent = 0 AND mcap_at_signal IS NOT NULL AND sent_at > datetime('now', '-1 hour') AND sent_at < datetime('now', '-25 minutes')"
  ).all() as any[];

  for (const record of pending) {
    await checkFollowup(record.mint);
  }
}

// ── TEST FUNCTION ──

export async function sendTestAlert(): Promise<boolean> {
  const text = `🧪 *PumpAgent Signal Bot*

Test alert \\- bot is connected\\!
━━━━━━━━━━━━━━━
✅ Bot active
✅ Channel connected
✅ Signals ready

[Open Terminal → pumpapi\\.markets/swap](https://pumpapi.markets/swap)`;

  return sendAlert(text);
}

export async function sendTestFollowup(): Promise<boolean> {
  const text = `🎯 *SIGNAL UPDATE*

*Test Token* \\(TEST\\) is up *\\+85%* since we called it\\.

${pickCongrats()}

📊 MCap now: $420\\.0K

[More Signals →](https://pumpapi.markets/swap)`;

  return sendAlert(text);
}

// ── CRON: run every 3 minutes ──

let cronInterval: ReturnType<typeof setInterval> | null = null;

export function startSignalCron(): void {
  if (!token || !channelId) {
    log.warn("Telegram not configured, skipping signal cron");
    return;
  }

  log.info("Starting Telegram signal cron (every 3 minutes)");

  // Check any pending followups from before restart
  setTimeout(() => checkPendingFollowups().catch((e) => log.error({ err: e.message }, "Pending followup error")), 5_000);

  // Run immediately on start
  setTimeout(() => runSignalCycle().catch((e) => log.error({ err: e.message }, "Signal cycle error")), 10_000);

  // Then every 3 minutes
  cronInterval = setInterval(() => {
    runSignalCycle().catch((e) => log.error({ err: e.message }, "Signal cycle error"));
  }, 3 * 60 * 1000);
}

export function stopSignalCron(): void {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
  }
}
