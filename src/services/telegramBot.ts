import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import db from "../db.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bot");

// Use separate token for interactive bot (PumpApiBot), falls back to main signal bot token
const token = process.env.TELEGRAM_BOT_TOKEN_INTERACTIVE || process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;

let bot: TelegramBot | null = null;

// ── DB SCHEMA ──

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_users (
    chat_id TEXT PRIMARY KEY,
    chat_type TEXT,
    username TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now')),
    command_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_address TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    target_price REAL NOT NULL,
    current_price_at_set REAL,
    created_at TEXT DEFAULT (datetime('now')),
    triggered INTEGER DEFAULT 0,
    triggered_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pa_chat ON price_alerts(chat_id);
  CREATE INDEX IF NOT EXISTS idx_pa_triggered ON price_alerts(triggered);

  CREATE TABLE IF NOT EXISTS bot_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    chat_type TEXT,
    command TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bu_chat ON bot_usage(chat_id);
  CREATE INDEX IF NOT EXISTS idx_bu_ts ON bot_usage(timestamp);
`);

// ── PREPARED STATEMENTS ──

const upsertUser = db.prepare(`
  INSERT INTO bot_users (chat_id, chat_type, username, first_seen, last_active, command_count)
  VALUES (@chat_id, @chat_type, @username, datetime('now'), datetime('now'), 1)
  ON CONFLICT(chat_id) DO UPDATE SET
    last_active = datetime('now'),
    command_count = command_count + 1,
    username = COALESCE(@username, username)
`);

const logUsage = db.prepare(
  "INSERT INTO bot_usage (chat_id, chat_type, command) VALUES (?, ?, ?)"
);

const countRecentCommands = db.prepare(
  "SELECT COUNT(*) as cnt FROM bot_usage WHERE chat_id = ? AND timestamp > datetime('now', '-1 hour')"
);

const insertAlert = db.prepare(`
  INSERT INTO price_alerts (chat_id, user_id, token_address, token_name, token_symbol, target_price, current_price_at_set)
  VALUES (@chat_id, @user_id, @token_address, @token_name, @token_symbol, @target_price, @current_price_at_set)
`);

const getActiveAlerts = db.prepare(
  "SELECT * FROM price_alerts WHERE triggered = 0"
);

const triggerAlert = db.prepare(
  "UPDATE price_alerts SET triggered = 1, triggered_at = datetime('now') WHERE id = ?"
);

// ── RATE LIMITING ──

const groupLastResponse = new Map<string, number>();
const GROUP_COOLDOWN_MS = 5000;

function isGroupCoolingDown(chatId: string): boolean {
  const last = groupLastResponse.get(chatId);
  if (last && Date.now() - last < GROUP_COOLDOWN_MS) return true;
  groupLastResponse.set(chatId, Date.now());
  return false;
}

function isRateLimited(chatId: string): boolean {
  const row = countRecentCommands.get(chatId) as any;
  return (row?.cnt ?? 0) >= 30;
}

// ── HELPERS ──

function isGroup(msg: TelegramBot.Message): boolean {
  return msg.chat.type === "group" || msg.chat.type === "supergroup";
}

function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null) return "-";
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  return Math.floor(seconds / 86400) + "d";
}

function riskEmoji(tier: string | null | undefined): string {
  switch (tier) {
    case "safe": return "\u2705";
    case "moderate": return "\u{1F7E1}";
    case "risky": return "\u{1F7E0}";
    case "dangerous": return "\u{1F534}";
    default: return "\u26AA";
  }
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  return Math.floor(diff / 3600) + "h ago";
}

async function api(path: string): Promise<any> {
  const { data } = await axios.get(`${API_BASE}${path}`, { timeout: 12000 });
  return data;
}

function trackCommand(msg: TelegramBot.Message, cmd: string): void {
  const chatId = String(msg.chat.id);
  const username = msg.from?.username ?? msg.from?.first_name ?? null;
  upsertUser.run({
    chat_id: chatId,
    chat_type: msg.chat.type,
    username,
  });
  logUsage.run(chatId, msg.chat.type, cmd);
}

async function reply(msg: TelegramBot.Message, text: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    log.warn({ err: err.message, chatId: msg.chat.id }, "Failed to send message");
    // Retry without HTML
    try {
      await bot.sendMessage(msg.chat.id, text.replace(/<[^>]+>/g, ""));
    } catch {}
  }
}

// ── COMMAND HANDLERS ──

async function handleStart(msg: TelegramBot.Message): Promise<void> {
  const text = `\u26A1 <b>Welcome to PumpAgent</b>

Your AI-powered PumpFun trading assistant.

<b>Commands:</b>
/scan ADDRESS \u2014 full token analysis
/new \u2014 fresh token launches
/trending \u2014 momentum + graduating picks
/kol \u2014 smart money wallet activity
/wallet ADDRESS \u2014 analyze any wallet
/alert ADDRESS PRICE \u2014 set price alert
/portfolio ADDRESS \u2014 wallet holdings
/help \u2014 all commands

Terminal: pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

  await reply(msg, text);
}

async function handleHelp(msg: TelegramBot.Message): Promise<void> {
  const text = `\u26A1 <b>PumpAgent Commands</b>

/scan ADDRESS \u2014 full token analysis
/new \u2014 fresh launches
/trending \u2014 momentum picks
/kol \u2014 smart money activity
/wallet ADDRESS \u2014 wallet analysis
/alert ADDRESS PRICE \u2014 price alerts
/portfolio ADDRESS \u2014 holdings

Terminal: pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

  await reply(msg, text);
}

async function handleScan(msg: TelegramBot.Message, address: string): Promise<void> {
  if (!address || !isValidSolanaAddress(address)) {
    await reply(msg, "\u274C Invalid address. Please provide a valid Solana token mint address.");
    return;
  }

  try {
    const [tokenData, riskData, signalData, stData] = await Promise.all([
      api(`/v1/tokens/${address}`).catch(() => null),
      api(`/v1/tokens/${address}/risk`).catch(() => null),
      api(`/v1/tokens/${address}/signals`).catch(() => null),
      api(`/v1/tokens/${address}/insiders`).catch(() => null),
    ]);

    // Also try Solana Tracker enrichment directly
    let stInsights: any = null;
    try {
      const { getTokenInsights } = await import("./solanaTrackerService.js");
      stInsights = await getTokenInsights(address);
    } catch {}

    if (!tokenData) {
      await reply(msg, "\u274C Token not found. May be too new or invalid.");
      return;
    }

    const risk = riskData?.risk ?? tokenData.risk ?? {};
    const signals = signalData?.signals ?? {};
    const interp = signalData?.interpretation ?? {};
    const kolSignal = tokenData.kolSignal ?? {};

    const flags = (risk.flags ?? []).map((f: string) => `\u26A0\uFE0F ${f}`).join("\n");

    let verdict = "No clear signal.";
    if (risk.tier === "safe" && interp.overall === "strong") verdict = "Looking solid. Low risk + strong momentum.";
    else if (risk.tier === "safe") verdict = "Low risk token. Watch for momentum.";
    else if (risk.tier === "dangerous") verdict = "HIGH RISK. Proceed with extreme caution.";
    else if (risk.tier === "risky") verdict = "Elevated risk. DYOR before entering.";
    else if (interp.overall === "strong") verdict = "Strong signals but check the risk flags.";

    const ageSeconds = tokenData.createdAt
      ? Math.floor((Date.now() - new Date(tokenData.createdAt).getTime()) / 1000)
      : null;

    const buyPressure = signals.buyPressure != null
      ? Math.round(signals.buyPressure * 100) + "%"
      : "-";

    // Solana Tracker enrichment
    const st = stInsights || {};
    const insiders = st.insiders ?? 0;
    const snipers = st.snipers ?? 0;
    const bundlers = st.bundlers ?? { count: 0, percentage: 0 };
    const dev = st.dev ?? 0;
    const top10 = st.top10 ?? 0;
    const lpBurn = st.lpBurn ?? 0;
    const mintAuth = st.mintAuthority;
    const freezeAuth = st.freezeAuthority;
    const isCashback = st.isCashbackCoin ?? false;

    let text = `\u{1F50D} <b>${tokenData.name ?? "Unknown"}</b> (${tokenData.symbol ?? "???"})

\u{1F4B0} Price: ${tokenData.price != null ? "$" + tokenData.price : "-"}
\u{1F4CA} MCap: ${fmt(tokenData.fdv)}
\u{1F4A7} Liquidity: ${fmt(tokenData.liquidity)}
\u{1F4C8} 24h Volume: ${fmt(tokenData.volume24h)}
\u23F1 Age: ${fmtAge(ageSeconds)}

\u{1F6E1} Risk: ${risk.score ?? "-"}/100 \u2014 ${risk.tier ?? "-"} ${riskEmoji(risk.tier)}`;

    if (flags) text += `\n${flags}`;

    // Add Solana Tracker data if available
    if (stInsights) {
      text += `

\u{1F4CA} Holders: ${st.holders ?? "-"}
\u{1F40B} Top 10: ${top10}%
\u{1F468}\u200D\u{1F4BB} Dev: ${dev}%
\u{1F575}\uFE0F Insiders: ${insiders}
\u{1F3AF} Snipers: ${snipers}
\u{1F4E6} Bundlers: ${bundlers.count} (${bundlers.percentage.toFixed(0)}%)
\u{1F525} LP Burned: ${lpBurn}%
\u{1F512} Mint Auth: ${mintAuth ? "\u26A0\uFE0F ACTIVE" : "\u2705 NONE"}
\u2744\uFE0F Freeze Auth: ${freezeAuth ? "\u26A0\uFE0F ACTIVE" : "\u2705 NONE"}
\u{1F4B0} Cashback: ${isCashback ? "\u2705 YES" : "\u274C NO"}`;
    }

    // Suspicious buyer patterns
    if (stData?.suspiciousPattern) {
      text += `\n\n\u{1F6A8} <b>Suspicious pattern:</b> ${stData.reason}`;
    }

    text += `

\u{1F40B} KOL Activity: ${kolSignal.eliteCount ?? 0} elite wallets
\u{1F4CA} Buy Pressure: ${buyPressure}

<b>Verdict:</b> ${verdict}

Trade \u2192 pumpapi.markets/swap?token=${address}
Powered by PumpAgent \u26A1`;

    await reply(msg, isGroup(msg) ? text.split("\n\n").slice(0, 4).join("\n\n") + `\n\nFull analysis \u2192 @PumpApiBot` : text);
  } catch (err: any) {
    log.warn({ err: err.message, address }, "Scan failed");
    await reply(msg, "\u26A0\uFE0F Couldn't fetch data right now. Try again in a moment.");
  }
}

async function handleNew(msg: TelegramBot.Message): Promise<void> {
  try {
    const data = await api("/v1/tokens/new");
    const tokens = (data.tokens ?? []).slice(0, 5);

    if (!tokens.length) {
      await reply(msg, "\u{1F6AB} No fresh launches found right now.");
      return;
    }

    let text = `\u{1F195} <b>FRESH LAUNCHES</b>\n`;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      text += `
${i + 1}. <b>${t.name ?? "Unknown"}</b> (${t.symbol ?? "???"}) \u2014 ${fmtAge(t.age)}
   pumpapi.markets/swap?token=${t.mint}`;
    }

    text += `

Full terminal \u2192 pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't fetch data right now. Try again in a moment.");
  }
}

async function handleTrending(msg: TelegramBot.Message): Promise<void> {
  try {
    const [momentum, graduating] = await Promise.all([
      api("/v1/picks?type=momentum").catch(() => ({ tokens: [] })),
      api("/v1/tokens/graduating").catch(() => ({ tokens: [] })),
    ]);

    let text = `\u{1F525} <b>TRENDING NOW</b>\n`;

    const momTokens = (momentum.tokens ?? []).slice(0, 3);
    if (momTokens.length) {
      text += `\n\u26A1 <b>MOMENTUM:</b>`;
      for (let i = 0; i < momTokens.length; i++) {
        const t = momTokens[i];
        text += `\n${i + 1}. <b>${t.name ?? "Unknown"}</b> \u2014 MCap: ${fmt(t.marketCap)}`;
        text += `\n   pumpapi.markets/swap?token=${t.mint}`;
      }
    }

    const gradTokens = (graduating.tokens ?? []).slice(0, 3);
    if (gradTokens.length) {
      text += `\n\n\u{1F393} <b>GRADUATING SOON:</b>`;
      for (let i = 0; i < gradTokens.length; i++) {
        const t = gradTokens[i];
        text += `\n${i + 1}. <b>${t.name ?? "Unknown"}</b> (${t.symbol ?? "???"})`;
        text += `\n   pumpapi.markets/swap?token=${t.mint}`;
      }
    }

    text += `

Full terminal \u2192 pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't fetch data right now. Try again in a moment.");
  }
}

async function handleKol(msg: TelegramBot.Message): Promise<void> {
  try {
    const data = await api("/v1/kol/activity");
    const activity = (data.activity ?? []).slice(0, 5);

    if (!activity.length) {
      await reply(msg, "\u{1F40B} No recent KOL activity detected.");
      return;
    }

    let text = `\u{1F40B} <b>SMART MONEY \u2014 recent activity</b>\n`;

    for (let i = 0; i < activity.length; i++) {
      const a = activity[i];
      const label = a.tier === "elite" ? "Elite Wallet" : "Profitable Wallet";
      const desc = a.description ?? a.type ?? "transaction";
      text += `
${i + 1}. ${label} \u2014 ${desc}
   ${a.label} | ${a.timestamp ? timeAgo(a.timestamp) : "-"}`;
    }

    text += `

Terminal \u2192 pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't fetch data right now. Try again in a moment.");
  }
}

async function handleWallet(msg: TelegramBot.Message, address: string): Promise<void> {
  if (!address || !isValidSolanaAddress(address)) {
    await reply(msg, "\u274C Invalid address. Please provide a valid Solana wallet address.");
    return;
  }

  try {
    const data = await api(`/v1/portfolio/${address}`);
    const tokens = (data.tokens ?? []).slice(0, 3);
    const pumpCount = (data.tokens ?? []).filter((t: any) => t.isPumpFun).length;

    let text = `\u{1F45B} <b>WALLET ANALYSIS</b>

Holdings: ${data.tokenCount ?? 0} tokens
Total Value: ${fmt(data.totalValueUsd)}
SOL Balance: ${data.solBalance ?? 0} SOL

<b>Top Holdings:</b>`;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const change = t.priceChange24h != null ? ` (${t.priceChange24h > 0 ? "+" : ""}${t.priceChange24h.toFixed(1)}%)` : "";
      text += `\n${i + 1}. ${t.name ?? t.symbol ?? t.mint.slice(0, 8)} \u2014 ${fmt(t.valueUsd)}${change}`;
    }

    text += `

PumpFun tokens: ${pumpCount}

Full portfolio \u2192 pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't fetch data right now. Try again in a moment.");
  }
}

async function handleAlert(msg: TelegramBot.Message, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const address = parts[0];
  const targetPrice = parseFloat(parts[1]);

  if (!address || !isValidSolanaAddress(address)) {
    await reply(msg, "\u274C Usage: /alert ADDRESS PRICE\nExample: /alert So11...abc 1.50");
    return;
  }

  if (isNaN(targetPrice) || targetPrice <= 0) {
    await reply(msg, "\u274C Invalid price. Use: /alert ADDRESS PRICE");
    return;
  }

  try {
    const tokenData = await api(`/v1/tokens/${address}`).catch(() => null);
    const name = tokenData?.name ?? "Unknown";
    const symbol = tokenData?.symbol ?? "???";
    const currentPrice = tokenData?.price ?? null;

    insertAlert.run({
      chat_id: String(msg.chat.id),
      user_id: String(msg.from?.id ?? ""),
      token_address: address,
      token_name: name,
      token_symbol: symbol,
      target_price: targetPrice,
      current_price_at_set: currentPrice,
    });

    const text = `\u{1F514} <b>Alert Set!</b>

Token: ${name} (${symbol})
Target: $${targetPrice}
Current: ${currentPrice != null ? "$" + currentPrice : "-"}

I'll notify you when price hits your target.

Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't set alert right now. Try again in a moment.");
  }
}

async function handlePool(msg: TelegramBot.Message, address: string): Promise<void> {
  if (!address || !isValidSolanaAddress(address)) {
    await reply(msg, "\u274C Invalid address. Please provide a valid pool address.");
    return;
  }

  try {
    const data = await api(`/v1/pools/${address}`);

    if (!data || data.error) {
      await reply(msg, "\u274C Pool not found.");
      return;
    }

    const apr = data.current_apr != null ? data.current_apr.toFixed(1) : "-";
    const volume = data.current_volume_24h ?? data.live?.volume24h ?? null;
    const tvl = data.current_tvl_usd ?? data.live?.liquidity ?? null;
    const mcap = data.market_cap_usd ?? data.live?.fdv ?? null;
    const feeTier = data.fee_tier ?? 0.25;
    const dailyFees = volume != null ? volume * (feeTier / 100) : null;
    const score = data.composite_score ?? "-";

    const createdAt = data.created_at ? new Date(data.created_at).getTime() : null;
    const poolAge = createdAt ? fmtAge(Math.floor((Date.now() - createdAt) / 1000)) : "-";

    const text = `\u{1F3CA} <b>POOL: ${data.token_name ?? "Unknown"}</b>

\u{1F4A7} TVL: ${fmt(tvl)}
\u{1F4C8} APR: ${apr}%
\u{1F4B0} 24h Fees: ${fmt(dailyFees)}
\u{1F4CA} Volume: ${fmt(volume)}
\u{1F4CA} MCap: ${fmt(mcap)}
\u23F1 Pool Age: ${poolAge}
\u{1F6E1} Risk: ${data.risk_score ?? "-"}/100 ${data.risk_tier ?? "-"} ${riskEmoji(data.risk_tier)}
\u{1F40B} KOL Activity: ${data.kol_count ?? 0} wallets

Score: ${score}/100

Provide liquidity \u2192
pumpapi.markets/pools/${address}
Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't fetch pool data right now. Try again in a moment.");
  }
}

async function handlePortfolio(msg: TelegramBot.Message, address: string): Promise<void> {
  if (!address || !isValidSolanaAddress(address)) {
    await reply(msg, "\u274C Invalid address. Please provide a valid Solana wallet address.");
    return;
  }

  try {
    const data = await api(`/v1/portfolio/${address}`);
    const tokens = data.tokens ?? [];
    const pumpTokens = tokens.filter((t: any) => t.isPumpFun);
    const otherTokens = tokens.filter((t: any) => !t.isPumpFun);

    const solUsd = data.solValueUsd != null ? fmt(data.solValueUsd) : "-";
    const tokenValue = data.totalValueUsd != null && data.solValueUsd != null
      ? fmt(data.totalValueUsd - (data.solValueUsd ?? 0))
      : "-";

    let text = `\u{1F4BC} <b>PORTFOLIO</b>

Total: ${fmt(data.totalValueUsd)}
SOL: ${data.solBalance ?? 0} (${solUsd})
Tokens: ${tokenValue}`;

    if (pumpTokens.length) {
      text += `\n\n<b>PumpFun Positions:</b>`;
      for (const t of pumpTokens.slice(0, 5)) {
        text += `\n\u2022 ${t.name ?? t.symbol ?? t.mint.slice(0, 8)} \u2014 ${fmt(t.valueUsd)}`;
      }
    }

    if (otherTokens.length) {
      text += `\n\n<b>Other Tokens:</b>`;
      for (const t of otherTokens.slice(0, 5)) {
        text += `\n\u2022 ${t.name ?? t.symbol ?? t.mint.slice(0, 8)} \u2014 ${fmt(t.valueUsd)}`;
      }
    }

    text += `

pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

    await reply(msg, text);
  } catch {
    await reply(msg, "\u26A0\uFE0F Couldn't fetch data right now. Try again in a moment.");
  }
}

// ── ALERT CHECKER ──

let alertInterval: ReturnType<typeof setInterval> | null = null;

async function checkAlerts(): Promise<void> {
  if (!bot) return;

  const alerts = getActiveAlerts.all() as any[];
  if (!alerts.length) return;

  // Group by token to batch DexScreener calls
  const byToken = new Map<string, any[]>();
  for (const a of alerts) {
    const list = byToken.get(a.token_address) ?? [];
    list.push(a);
    byToken.set(a.token_address, list);
  }

  for (const [tokenAddr, tokenAlerts] of byToken) {
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${tokenAddr}`,
        { timeout: 8000 }
      );
      const pairs = Array.isArray(data) ? data : data?.pairs ?? [];
      if (!pairs.length) continue;

      const currentPrice = pairs[0].priceUsd ? parseFloat(pairs[0].priceUsd) : null;
      if (currentPrice == null) continue;

      for (const alert of tokenAlerts) {
        if (currentPrice >= alert.target_price) {
          triggerAlert.run(alert.id);

          const text = `\u{1F6A8} <b>PRICE ALERT TRIGGERED</b>

${alert.token_name ?? "Token"} (${alert.token_symbol ?? "???"})
Target: $${alert.target_price} \u2705
Current: $${currentPrice}

Trade now \u2192
pumpapi.markets/swap?token=${alert.token_address}
Powered by PumpAgent \u26A1`;

          try {
            await bot.sendMessage(alert.chat_id, text, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
            });
          } catch (err: any) {
            log.warn({ err: err.message, chatId: alert.chat_id }, "Failed to send alert notification");
          }
        }
      }
    } catch {
      // Skip token on error
    }
  }
}

// ── MESSAGE ROUTER ──

function extractCommand(text: string): { cmd: string; args: string } | null {
  // Match /command or /command@BotName
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)/s);
  if (!match) return null;
  return { cmd: match[1].toLowerCase(), args: match[2].trim() };
}

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!msg.text) return;

  const chatId = String(msg.chat.id);
  const inGroup = isGroup(msg);

  // Group behavior: only respond to /commands or @PumpApiBot mentions
  if (inGroup) {
    const isCommand = msg.text.startsWith("/");
    const isMentioned = msg.text.includes("@PumpApiBot");
    if (!isCommand && !isMentioned) return;
    if (isGroupCoolingDown(chatId)) return;
  }

  // Rate limit check
  if (isRateLimited(chatId)) {
    await reply(msg, "\u23F1 Slow down! Max 30 commands per hour.");
    return;
  }

  const parsed = extractCommand(msg.text);
  if (!parsed) {
    // If mentioned but no command, give hint
    if (msg.text.includes("@PumpApiBot")) {
      await reply(msg, "Use /help to see available commands.");
    }
    return;
  }

  const { cmd, args } = parsed;
  trackCommand(msg, cmd);

  switch (cmd) {
    case "start":
      await handleStart(msg);
      break;
    case "help":
      await handleHelp(msg);
      break;
    case "scan":
      await handleScan(msg, args.split(/\s+/)[0]);
      break;
    case "new":
      await handleNew(msg);
      break;
    case "trending":
      await handleTrending(msg);
      break;
    case "kol":
      await handleKol(msg);
      break;
    case "wallet":
      await handleWallet(msg, args.split(/\s+/)[0]);
      break;
    case "alert":
      await handleAlert(msg, args);
      break;
    case "portfolio":
      await handlePortfolio(msg, args.split(/\s+/)[0]);
      break;
    default:
      if (!inGroup) {
        await reply(msg, "Unknown command. Use /help to see available commands.");
      }
  }
}

// ── GROUP JOIN HANDLER ──

async function handleNewChatMembers(msg: TelegramBot.Message): Promise<void> {
  if (!bot) return;
  const members = msg.new_chat_members ?? [];
  const botInfo = await bot.getMe();

  const botJoined = members.some((m) => m.id === botInfo.id);
  if (!botJoined) return;

  const text = `\u{1F44B} PumpAgent is now active!

<b>Commands:</b>
/scan ADDRESS \u2014 analyze any token
/new \u2014 fresh launches
/trending \u2014 what's hot
/kol \u2014 smart money activity
/wallet ADDRESS \u2014 wallet analysis

Full terminal: pumpapi.markets/swap
Powered by PumpAgent \u26A1`;

  await reply(msg, text);
}

// ── EXPORTED BOT INSTANCE (for signal service) ──

export function getBotInstance(): TelegramBot | null {
  return bot;
}

// ── START ──

export function startTelegramBot(): void {
  if (!token) {
    log.warn("TELEGRAM_BOT_TOKEN not set, skipping bot startup");
    return;
  }

  log.info("Starting Telegram bot with polling...");

  bot = new TelegramBot(token, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: {
        timeout: 30,
      },
    },
  });

  bot.on("message", (msg) => {
    handleMessage(msg).catch((err) =>
      log.error({ err: err.message }, "Message handler error")
    );
  });

  bot.on("new_chat_members", (msg) => {
    handleNewChatMembers(msg).catch((err) =>
      log.error({ err: err.message }, "New chat members handler error")
    );
  });

  bot.on("polling_error", (err) => {
    log.error({ err: err.message }, "Bot polling error");
  });

  // Start alert checker every 60 seconds
  alertInterval = setInterval(() => {
    checkAlerts().catch((err) =>
      log.error({ err: err.message }, "Alert checker error")
    );
  }, 60_000);

  // Initial alert check after 15 seconds
  setTimeout(() => {
    checkAlerts().catch((err) =>
      log.error({ err: err.message }, "Initial alert check error")
    );
  }, 15_000);

  log.info("Telegram bot started");
}

export function stopTelegramBot(): void {
  if (alertInterval) {
    clearInterval(alertInterval);
    alertInterval = null;
  }
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
  log.info("Telegram bot stopped");
}
