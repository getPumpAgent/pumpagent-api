import { TwitterApi } from "twitter-api-v2";
import { createCanvas, loadImage, type Canvas, type CanvasRenderingContext2D } from "canvas";
import cron from "node-cron";
import { createLogger } from "../utils/logger.js";
import db from "../db.js";
import axios from "axios";

const log = createLogger("twitter-bot");

// ══════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════

const ENABLED = process.env.TWITTER_BOT_ENABLED === "true";
const API = "https://api.pumpapi.markets";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const LOGO_PATH = "/var/www/pumpapi/img/logo-dark.png";
const CARD_W = 1200;
const CARD_H = 675;

const GREEN = "#00ff9d";
const RED = "#ff4444";
const BG = "#0a0a0a";
const SURFACE = "#111113";
const BORDER = "#222";
const DIM = "#555";
const WHITE = "#fafafa";
const YELLOW = "#f0b90b";
const BLUE = "#60A5FA";

// Rotation types A-H
const ROTATION_TYPES = ["pick", "pools", "graduate", "stats", "kol-trade", "kol-activity", "trenches", "highlight"] as const;
type TweetType = typeof ROTATION_TYPES[number];

// ══════════════════════════════════════════════
// TWITTER CLIENT
// ══════════════════════════════════════════════

function getTwitterClient(): TwitterApi | null {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
}

// ══════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS twitter_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT,
    type TEXT NOT NULL,
    template_index INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    image_path TEXT,
    token_address TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    success INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS twitter_template_state (
    type TEXT PRIMARY KEY,
    last_index INTEGER NOT NULL DEFAULT -1
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS twitter_rotation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_index INTEGER NOT NULL DEFAULT 0
  )
`);
db.exec(`INSERT OR IGNORE INTO twitter_rotation (id, current_index) VALUES (1, 0)`);

const insertPostStmt = db.prepare(
  `INSERT INTO twitter_posts (tweet_id, type, template_index, text, token_address, success, error)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const getLastPostStmt = db.prepare(
  `SELECT timestamp FROM twitter_posts WHERE success = 1 ORDER BY id DESC LIMIT 1`
);
const countRecentStmt = db.prepare(
  `SELECT COUNT(*) as cnt FROM twitter_posts WHERE success = 1 AND timestamp > datetime('now', '-24 hours')`
);
const getTemplateIdx = db.prepare(`SELECT last_index FROM twitter_template_state WHERE type = ?`);
const setTemplateIdx = db.prepare(`INSERT OR REPLACE INTO twitter_template_state (type, last_index) VALUES (?, ?)`);
const getRotationIdx = db.prepare(`SELECT current_index FROM twitter_rotation WHERE id = 1`);
const setRotationIdx = db.prepare(`UPDATE twitter_rotation SET current_index = ? WHERE id = 1`);

function nextTemplateIndex(type: string, count: number): number {
  const row = getTemplateIdx.get(type) as any;
  const next = ((row ? row.last_index : -1) + 1) % count;
  setTemplateIdx.run(type, next);
  return next;
}

function getAndAdvanceRotation(): number {
  const row = getRotationIdx.get() as any;
  const idx = row ? row.current_index : 0;
  setRotationIdx.run((idx + 1) % 8);
  return idx;
}

function advanceRotationOnly(): number {
  const row = getRotationIdx.get() as any;
  const idx = row ? row.current_index : 0;
  setRotationIdx.run((idx + 1) % 8);
  return idx;
}

// ══════════════════════════════════════════════
// SAFETY
// ══════════════════════════════════════════════

function canPost(): { ok: boolean; reason?: string } {
  const last = getLastPostStmt.get() as any;
  if (last) {
    const elapsed = Date.now() - new Date(last.timestamp + "Z").getTime();
    // Throttle disabled during testing
    // if (elapsed < 2 * 3600_000) return { ok: false, reason: `Last tweet ${Math.round(elapsed / 60000)}m ago (min 2h)` };
  }
  const count = (countRecentStmt.get() as any)?.cnt || 0;
  if (count >= 4) return { ok: false, reason: `${count} tweets in 24h (max 4)` };
  return { ok: true };
}

// ══════════════════════════════════════════════
// CHART DATA
// ══════════════════════════════════════════════

const pairCache = new Map<string, { pair: string; ts: number }>();
const ohlcvCache = new Map<string, { data: number[]; ts: number }>();

async function getPairAddress(addr: string): Promise<string | null> {
  const c = pairCache.get(addr);
  if (c && Date.now() - c.ts < 86400_000) return c.pair;
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { timeout: 10000 });
    const pair = res.data?.pairs?.[0]?.pairAddress;
    if (pair) pairCache.set(addr, { pair, ts: Date.now() });
    return pair || null;
  } catch { return null; }
}

async function getOhlcvPrices(addr: string): Promise<number[]> {
  const c = ohlcvCache.get(addr);
  if (c && Date.now() - c.ts < 1800_000) return c.data;
  const pair = await getPairAddress(addr);
  if (!pair) return [];
  try {
    const res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}/ohlcv/minute?limit=100`, { timeout: 10000 });
    const list = res.data?.data?.attributes?.ohlcv_list || [];
    const prices = list.map((c: number[]) => c[4]).reverse();
    if (prices.length) ohlcvCache.set(addr, { data: prices, ts: Date.now() });
    return prices;
  } catch { return []; }
}

// ══════════════════════════════════════════════
// CANVAS HELPERS
// ══════════════════════════════════════════════

let logoImg: any = null;
async function getLogo() {
  if (!logoImg) try { logoImg = await loadImage(LOGO_PATH); } catch {}
  return logoImg;
}

function drawTokenCircle(ctx: CanvasRenderingContext2D, img: any, symbol: string, x: number, y: number, size: number, borderColor?: string) {
  ctx.save();
  if (borderColor) {
    ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 + 2, 0, Math.PI * 2);
    ctx.fillStyle = borderColor; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
  if (img) { ctx.drawImage(img, x, y, size, size); }
  else {
    ctx.fillStyle = "#1a1a2e"; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = GREEN; ctx.font = `bold ${Math.round(size * 0.45)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((symbol || "?")[0].toUpperCase(), x + size / 2, y + size / 2);
  }
  ctx.restore();
}

async function loadTokenImg(url: string | null, symbol: string): Promise<any> {
  if (url) try { return await loadImage(url); } catch {}
  return null;
}

function drawSparklineOn(ctx: CanvasRenderingContext2D, prices: number[], x: number, y: number, w: number, h: number, color?: string) {
  if (prices.length < 2) return;
  const up = prices[prices.length - 1] >= prices[0];
  const c = color || (up ? GREEN : RED);
  const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
  const step = w / (prices.length - 1);
  const pts: [number, number][] = prices.map((p, i) => [x + i * step, y + h - ((p - min) / range) * h * 0.85 - h * 0.075]);

  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, c + "44"); grad.addColorStop(1, c + "00");
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) { const mx = (pts[i - 1][0] + pts[i][0]) / 2; ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, (pts[i - 1][1] + pts[i][1]) / 2); }
  ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) { const mx = (pts[i - 1][0] + pts[i][0]) / 2; ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, (pts[i - 1][1] + pts[i][1]) / 2); }
  ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
}

function drawPill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg: string, fs: number = 14): number {
  ctx.font = `bold ${fs}px sans-serif`;
  const tw = ctx.measureText(text).width; const pw = tw + 20; const ph = fs + 12;
  ctx.fillStyle = bg; ctx.beginPath(); roundRect(ctx, x, y, pw, ph, ph / 2); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 10, y + ph / 2);
  return pw;
}

async function createBaseCard(): Promise<{ canvas: Canvas; ctx: CanvasRenderingContext2D }> {
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BG; ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.beginPath(); roundRect(ctx, 20, 20, CARD_W - 40, CARD_H - 40, 12); ctx.stroke();
  const logo = await getLogo();
  if (logo) { ctx.save(); ctx.beginPath(); ctx.arc(50, 50, 20, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(logo, 30, 30, 40, 40); ctx.restore(); }
  ctx.fillStyle = WHITE; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText("PumpAgent", 78, 50);
  ctx.fillStyle = DIM; ctx.font = "14px sans-serif"; ctx.textAlign = "right"; ctx.fillText("pumpapi.markets", CARD_W - 35, CARD_H - 35);
  return { canvas, ctx };
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}

function fmtPct(n: number): string { return (n > 0 ? "+" : "") + n.toFixed(1) + "%"; }

function truncName(ctx: CanvasRenderingContext2D, name: string, maxW: number): string {
  let t = name;
  while (ctx.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -1);
  return t !== name ? t + "\u2026" : t;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number) {
  const words = text.split(" "); let line = ""; let ly = y;
  for (const w of words) {
    const test = line + (line ? " " : "") + w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, ly); line = w; ly += lineH; }
    else line = test;
  }
  if (line) ctx.fillText(line, x, ly);
}

// ══════════════════════════════════════════════
// TWEET POSTING
// ══════════════════════════════════════════════

async function postTweet(text: string, image: Buffer, type: string, tmplIdx: number, tokenAddr?: string): Promise<{ success: boolean; tweetId?: string; error?: string }> {
  const client = getTwitterClient();
  if (!client) { insertPostStmt.run(null, type, tmplIdx, text, tokenAddr || null, 0, "No client"); return { success: false, error: "No client" }; }
  try {
    const mediaId = await client.v1.uploadMedia(image, { mimeType: "image/png" });
    const tweet = await client.v2.tweet({ text, media: { media_ids: [mediaId] } });
    const id = tweet.data?.id || null;
    insertPostStmt.run(id, type, tmplIdx, text, tokenAddr || null, 1, null);
    log.info({ type, tweetId: id }, "Tweet posted");
    return { success: true, tweetId: id || undefined };
  } catch (err: any) {
    const msg = err.message || String(err);
    insertPostStmt.run(null, type, tmplIdx, text, tokenAddr || null, 0, msg);
    log.error({ type, err: msg }, "Tweet failed");
    return { success: false, error: msg };
  }
}

// ══════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════

const T_PICK = [
  "\uD83C\uDFA9 AI Pick: $${symbol}\n\nMCap: ${mcap} | 24h: ${change}\nVolume: ${volume}\nVirality: ${virality}/10\n\n\"${narrativeSnippet}...\"\n\nTrade \u2192 pumpapi.markets/swap?token=${address}",
  "$${symbol} \u2014 ${change} today, ${mcap} mcap \uD83D\uDC40\nVolume: ${volume}\n\n\"${narrativeSnippet}...\"\n\n\u2192 pumpapi.markets/swap?token=${address}",
  "While you were sleeping \uD83C\uDFA9\n\n$${symbol}\n${mcap} MCap | ${change}\nVirality: ${virality}/10\n\n\"${narrativeSnippet}...\"\n\npumpapi.markets/swap?token=${address}",
  "The AI doesn\u2019t sleep \uD83C\uDFA9\n\n$${symbol}\n${mcap} MCap | ${change} 24h\n\n\"${narrativeSnippet}...\"\n\n\u2192 pumpapi.markets/swap?token=${address}",
  "Momentum alert \uD83C\uDFA9\n\n$${symbol} \u2014 ${change} in 24h\nMCap: ${mcap} | Vol: ${volume}\nVirality: ${virality}/10\n\n\"${narrativeSnippet}...\"\n\npumpapi.markets/swap?token=${address}",
];

const T_POOLS = [
  "Top 5 PumpSwap pools right now \uD83D\uDC40\n\n1. $${s1} \u2014 ${apr1} APR | ${mcap1}\n2. $${s2} \u2014 ${apr2} APR | ${mcap2}\n3. $${s3} \u2014 ${apr3} APR | ${mcap3}\n4. $${s4} \u2014 ${apr4} APR | ${mcap4}\n5. $${s5} \u2014 ${apr5} APR | ${mcap5}\n\nAll pools \u2192 pumpapi.markets/pools",
  "Where the liquidity\u2019s at \uD83D\uDCA7\n\n1. $${s1} \u2014 ${apr1} APR | \uD83D\uDC0B ${kol1}\n2. $${s2} \u2014 ${apr2} APR | \uD83D\uDC0B ${kol2}\n3. $${s3} \u2014 ${apr3} APR | \uD83D\uDC0B ${kol3}\n4. $${s4} \u2014 ${apr4} APR | \uD83D\uDC0B ${kol4}\n5. $${s5} \u2014 ${apr5} APR | \uD83D\uDC0B ${kol5}\n\n\u2192 pumpapi.markets/pools",
  "PumpSwap pool alpha \uD83C\uDFA9\n\n${s1}: ${mcap1} mcap, ${apr1} APR\n${s2}: ${mcap2} mcap, ${apr2} APR\n${s3}: ${mcap3} mcap, ${apr3} APR\n${s4}: ${mcap4} mcap, ${apr4} APR\n${s5}: ${mcap5} mcap, ${apr5} APR\n\npumpapi.markets/pools",
  "These pools are printing\n\n1. $${s1} \u2014 ${apr1} APR\n2. $${s2} \u2014 ${apr2} APR\n3. $${s3} \u2014 ${apr3} APR\n4. $${s4} \u2014 ${apr4} APR\n5. $${s5} \u2014 ${apr5} APR\n\n\u2192 pumpapi.markets/pools",
  "ser the APRs right now \uD83D\uDC40\n\n$${s1}: ${apr1}\n$${s2}: ${apr2}\n$${s3}: ${apr3}\n$${s4}: ${apr4}\n$${s5}: ${apr5}\n\npumpapi.markets/pools",
];

const T_GRAD = [
  "\uD83C\uDF93 $${symbol} just graduated and it\u2019s looking clean\n\nMCap: ${mcap} | ${change}\nRisk: ${score}/100 \u2014 ${tier}\n\u2705 ${bundlers} bundlers | LP ${lpBurn}% | Mint ${mintStatus}\n\n\u2192 pumpapi.markets/swap?token=${address}",
  "Fresh grad \uD83C\uDF93\n\n$${symbol}\n${mcap} MCap | ${change}\n\n0 bundlers \u2705\nLP burned \uD83D\uDD25\nMint revoked \u2705\n\uD83D\uDC0B ${kolCount} KOLs in\n\n\u2192 pumpapi.markets/swap?token=${address}",
  "This one made it out \uD83C\uDF93\n\n$${symbol} \u2014 ${mcap}\nRisk: ${score}/100 \u2014 ${tier}\nBundlers: ${bundlers} | Insiders: ${insiders}%\n\nClean \uD83C\uDFA9\n\npumpapi.markets/swap?token=${address}",
  "$${symbol} GRADUATED \uD83C\uDF93\n\n${mcap} MCap | ${change}\nLP burned \uD83D\uDD25 | Mint revoked \u2705\nRisk: ${score}/100\n\n\uD83D\uDC0B ${kolCount} KOLs already in\n\npumpapi.markets/swap?token=${address}",
  "Graduation day for $${symbol} \uD83C\uDF93\n\nMCap: ${mcap}\nAPR: ${apr}\nKOLs: ${kolCount} \uD83D\uDC0B\nBundlers: ${bundlers}\n\nLooks clean ser\n\n\u2192 pumpapi.markets/swap?token=${address}",
];

const T_STATS = [
  "PumpAgent scanned ${scanned} tokens in the last 24 hours \uD83C\uDFA9\n\n${pools} active pools\n${signals} signals fired\nAvg risk score: ${avgRisk}/100\n\npumpapi.markets",
  "24 hour report \uD83C\uDFA9\n\n${scanned} tokens scanned\n${pools} pools tracked\n${signals} signals sent\n\nThe agent never sleeps\n\npumpapi.markets",
  "Your daily alpha report \uD83C\uDFA9\n\n${pools} pools | ${signals} signals | ${scanned} tokens scanned\n\nAll free. No signup.\n\npumpapi.markets",
  "The numbers don\u2019t lie\n\n${scanned} tokens analyzed\n${pools} active pools\n${signals} signals fired today\n\n\uD83C\uDFA9 pumpapi.markets",
  "Another day in the trenches \uD83C\uDFA9\n\n${scanned} tokens scanned\n${pools} pools monitored\n${signals} alerts sent\n\nFree intelligence \u2192 pumpapi.markets",
];

const T_KOL_TRADE = [
  "Smart money move \uD83D\uDC0B\n\nA tracked wallet bought $${symbol} at ${entryMcap} mcap\n\nNow: ${currentMcap} mcap\nPnL: ${pnlPercent} (${pnlUsd})\n\nTrack KOL wallets free \u2192 pumpapi.markets/pools",
  "KOL wallet ${walletShort} is up ${pnlPercent} on $${symbol} \uD83D\uDC0B\n\nEntry: ${entryMcap} mcap\nCurrent: ${currentMcap}\nGain: ${pnlUsd}\n\nSee what smart money is buying \u2192 pumpapi.markets/pools",
  "This wallet knows something \uD83D\uDC40\n\n${walletShort} bought $${symbol} at ${entryMcap}\nNow at ${currentMcap}\n${pnlPercent} gain\n\n\uD83D\uDC0B Track KOLs \u2192 pumpapi.markets/pools",
  "Follow the smart money \uD83D\uDC0B\n\n$${symbol}\nEntry: ${entryMcap} mcap\nCurrent: ${currentMcap}\nPnL: ${pnlPercent}\n\nWallet: ${walletShort}\n\npumpapi.markets/pools",
  "One of our tracked wallets just printed \uD83C\uDFA9\n\n$${symbol}: ${pnlPercent} gain\nEntry: ${entryMcap} \u2192 Now: ${currentMcap}\n\nKOL tracking is free on PumpAgent\n\n\u2192 pumpapi.markets/pools",
];

const T_KOL_ACT = [
  "Where smart money is right now \uD83D\uDC0B\n\n1. $${s1} \u2014 \uD83D\uDC0B ${kol1} KOLs | ${mcap1}\n2. $${s2} \u2014 \uD83D\uDC0B ${kol2} KOLs | ${mcap2}\n3. $${s3} \u2014 \uD83D\uDC0B ${kol3} KOLs | ${mcap3}\n4. $${s4} \u2014 \uD83D\uDC0B ${kol4} KOLs | ${mcap4}\n5. $${s5} \u2014 \uD83D\uDC0B ${kol5} KOLs | ${mcap5}\n\n\u2192 pumpapi.markets/pools",
  "Follow the whales \uD83D\uDC0B\n\n$${s1}: ${kol1} KOLs tracking\n$${s2}: ${kol2} KOLs\n$${s3}: ${kol3} KOLs\n$${s4}: ${kol4} KOLs\n$${s5}: ${kol5} KOLs\n\nAll free \u2192 pumpapi.markets/pools",
  "KOL wallets are stacking these \uD83D\uDC0B\n\n1. $${s1} (${kol1} wallets)\n2. $${s2} (${kol2} wallets)\n3. $${s3} (${kol3} wallets)\n4. $${s4} (${kol4} wallets)\n5. $${s5} (${kol5} wallets)\n\npumpapi.markets/pools",
  "The whales are moving \uD83D\uDC40\n\nTop KOL-tracked pools:\n\n$${s1}: \uD83D\uDC0B ${kol1}\n$${s2}: \uD83D\uDC0B ${kol2}\n$${s3}: \uD83D\uDC0B ${kol3}\n$${s4}: \uD83D\uDC0B ${kol4}\n$${s5}: \uD83D\uDC0B ${kol5}\n\n\u2192 pumpapi.markets/pools",
  "Smart money radar \uD83C\uDFA9\n\n${kol1} KOLs in $${s1}\n${kol2} KOLs in $${s2}\n${kol3} KOLs in $${s3}\n${kol4} KOLs in $${s4}\n${kol5} KOLs in $${s5}\n\npumpapi.markets/pools",
];

const T_TRENCHES = [
  "Trenches report \u2014 last 24 hours \uD83C\uDFA9\n\n${total} tokens graduated\n${clean} passed safety filters \u2705\n${survived} still alive and trading\n\nTop survivors:\n$${s1} \u2014 ${mcap1}\n$${s2} \u2014 ${mcap2}\n$${s3} \u2014 ${mcap3}\n\n\u2192 pumpapi.markets/live",
  "24h in the trenches \uD83C\uDFA9\n\n${total} graduated\n${clean} were clean\n${survived} survived\n\nThe ones that made it:\n$${s1} ${mcap1}\n$${s2} ${mcap2}\n$${s3} ${mcap3}\n\nWatch live \u2192 pumpapi.markets/live",
  "${total} tokens graduated yesterday.\n\nOnly ${survived} are still alive.\n\n$${s1} \u2014 ${mcap1} \u2705\n$${s2} \u2014 ${mcap2} \u2705\n$${s3} \u2014 ${mcap3} \u2705\n\nLive feed \u2192 pumpapi.markets/live",
  "The trenches don\u2019t lie\n\n${total} graduated | ${clean} clean | ${survived} survived\n\nWinners:\n$${s1}: ${mcap1}\n$${s2}: ${mcap2}\n$${s3}: ${mcap3}\n\n\uD83C\uDFA9 pumpapi.markets/live",
  "Survival rate: ${survivalRate}%\n\n${total} tokens graduated in 24h\n${survived} still standing\n\nTop 3:\n$${s1} \u2014 ${mcap1}\n$${s2} \u2014 ${mcap2}\n$${s3} \u2014 ${mcap3}\n\n\u2192 pumpapi.markets/live",
];

const T_HIGHLIGHT = [
  // Feature 0 — Pool Explorer
  ["AI-ranked PumpSwap pools with rug detection built in \uD83C\uDFA9\n\nScores. APR. KOL tracking. Risk data.\n\nFree. No signup.\n\n\u2192 pumpapi.markets/pools",
   "Our pool explorer ranks every PumpSwap pool by safety + yield\n\nAPR, TVL, KOL count, risk score \u2014 all in one view\n\n\u2192 pumpapi.markets/pools"],
  // Feature 1 — Trenches
  ["The Trenches \u2014 real-time token feed \uD83C\uDFA9\n\nGraduating and graduated tokens streaming live\nRisk scores. Safety flags. No delay.\n\n\u2192 pumpapi.markets/trenches",
   "Watch tokens graduate in real-time\n\nBundler flags. Insider detection. LP burn status.\n\nAll live. All free.\n\n\u2192 pumpapi.markets/trenches"],
  // Feature 2 — Terminal
  ["Full PumpFun trading terminal \uD83C\uDFA9\n\nCharts. Swap. Risk data. 0.5% fees.\n\nHalf the cost of Photon and GMGN.\n\n\u2192 pumpapi.markets/swap",
   "Trade meme coins with an edge\n\nAI picks. Live charts. Risk scoring.\n0.5% fees \u2014 half the competition\n\n\u2192 pumpapi.markets/swap"],
  // Feature 3 — API
  ["npm install getpumpagent \uD83C\uDFA9\n\n20+ endpoints. Free. Build your own trading bot in minutes.\n\nDocs \u2192 pumpapi.markets/quickstart",
   "Free API for Solana meme coins\n\n20+ endpoints. Risk scores. Pool data. Token analytics.\n\nnpm install getpumpagent\n\n\u2192 pumpapi.markets/quickstart"],
  // Feature 4 — Telegram
  ["Free Telegram signals \uD83C\uDFA9\n\nFiltered picks with full risk data\nBundlers. Insiders. Snipers. LP burn.\n\nJoin \u2192 t.me/PumpAgentSignals",
   "Our Telegram bot scans every token so you don\u2019t have to\n\nRisk scores. Safety flags. KOL activity.\n\nFree \u2192 t.me/PumpAgentSignals"],
];

// ══════════════════════════════════════════════
// TYPE A — AI PICK
// ══════════════════════════════════════════════

async function buildPickCard(pick: any, prices: number[]): Promise<Buffer> {
  const { canvas, ctx } = await createBaseCard();
  drawPill(ctx, "AI PICK \uD83C\uDFA9", CARD_W - 200, 30, GREEN, "#000", 14);
  const img = await loadTokenImg(pick.image, pick.symbol); drawTokenCircle(ctx, img, pick.symbol || "?", 50, 90, 80, GREEN);
  ctx.fillStyle = WHITE; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(pick.name || "???", 150, 95);
  ctx.fillStyle = "#888"; ctx.font = "18px sans-serif"; ctx.fillText(`$${pick.symbol || "???"}`, 150, 128);
  const sy = 170; let sx = 50;
  for (const [l, v, c] of [["Price", pick.price ? "$" + Number(pick.price).toPrecision(4) : "\u2014", WHITE], ["MCap", fmt(pick.marketCap || 0), WHITE], ["24h", pick.priceChange24h != null ? fmtPct(pick.priceChange24h) : "\u2014", pick.priceChange24h > 0 ? GREEN : pick.priceChange24h < 0 ? RED : WHITE], ["Volume", fmt(pick.volume24h || 0), WHITE]] as [string, string, string][]) {
    ctx.fillStyle = "#888"; ctx.font = "11px sans-serif"; ctx.textAlign = "left"; ctx.fillText(l, sx, sy);
    ctx.fillStyle = c; ctx.font = "bold 16px sans-serif"; ctx.fillText(v, sx, sy + 16); sx += 150;
  }
  if (prices.length > 2) drawSparklineOn(ctx, prices, 50, 220, CARD_W - 100, 200);
  const vir = pick.virality || 0; ctx.fillStyle = "#888"; ctx.font = "12px sans-serif"; ctx.textAlign = "left"; ctx.fillText(`Virality: ${vir}/10`, 50, 445);
  ctx.fillStyle = BORDER; ctx.beginPath(); roundRect(ctx, 50, 463, 300, 8, 4); ctx.fill();
  ctx.fillStyle = GREEN; ctx.beginPath(); roundRect(ctx, 50, 463, 300 * Math.min(1, vir / 10), 8, 4); ctx.fill();
  if (pick.summary) { ctx.fillStyle = GREEN; ctx.fillRect(50, 490, 3, 50); ctx.fillStyle = "#888"; ctx.font = "italic 13px sans-serif"; wrapText(ctx, pick.summary.slice(0, 120), 62, 500, CARD_W - 140, 18); }
  return canvas.toBuffer("image/png");
}

export async function tweetPick(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    // Try momentum first, then degen, then hot
    let pick: any = null;
    for (const t of ["momentum", "degen", "hot"]) {
      try {
        const res = await axios.get(`${API}/v1/picks?type=${t}`, { timeout: 15000 });
        const tokens = res.data?.tokens;
        if (Array.isArray(tokens) && tokens.length && tokens[0].price) { pick = tokens[0]; break; }
        if (Array.isArray(tokens) && tokens.length && !pick) pick = tokens[0]; // fallback even without price
      } catch {}
    }
    if (!pick) return { success: false, error: "No picks available" };
    const prices = await getOhlcvPrices(pick.mint);
    const image = await buildPickCard(pick, prices);
    const idx = nextTemplateIndex("pick", T_PICK.length);
    const snippet = (pick.summary || "Momentum detected").slice(0, 120);
    let text = T_PICK[idx].replace(/\$\{symbol\}/g, pick.symbol || "???").replace(/\$\{mcap\}/g, fmt(pick.marketCap || 0)).replace(/\$\{change\}/g, pick.priceChange24h != null ? fmtPct(pick.priceChange24h) : "\u2014").replace(/\$\{volume\}/g, fmt(pick.volume24h || 0)).replace(/\$\{virality\}/g, String(pick.virality || 0)).replace(/\$\{narrativeSnippet\}/g, snippet).replace(/\$\{address\}/g, pick.mint || "");
    return await postTweet(text, image, "pick", idx, pick.mint);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE B — TOP POOLS
// ══════════════════════════════════════════════

async function buildPoolsCard(pools: any[]): Promise<Buffer> {
  const { canvas, ctx } = await createBaseCard();
  ctx.fillStyle = GREEN; ctx.font = "bold 32px sans-serif"; ctx.textAlign = "left"; ctx.fillText("Top PumpSwap Pools", 40, 100);
  ctx.fillStyle = "#888"; ctx.font = "16px sans-serif"; ctx.fillText("Ranked by composite score", 40, 128);
  const ry = 160, rh = 88;
  for (let i = 0; i < Math.min(5, pools.length); i++) {
    const p = pools[i]; const y = ry + i * rh;
    if (i > 0) { ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(CARD_W - 40, y); ctx.stroke(); }
    ctx.fillStyle = GREEN; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(`${i + 1}`, 50, y + 18);
    const ti = await loadTokenImg(p.token_image, p.token_symbol); drawTokenCircle(ctx, ti, p.token_symbol || "?", 90, y + 16, 30);
    ctx.font = "bold 18px sans-serif"; const name = truncName(ctx, p.token_name || "???", 380);
    ctx.fillStyle = WHITE; ctx.textAlign = "left"; ctx.fillText(name, 130, y + 18);
    ctx.fillStyle = "#888"; ctx.font = "14px sans-serif"; ctx.fillText(`$${p.token_symbol || "???"}`, 130, y + 42);
    ctx.fillStyle = GREEN; ctx.font = "bold 16px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(fmt(p.market_cap_usd || 0), 880, y + 18);
    ctx.fillText((p.current_apr || 0).toFixed(0) + "% APR", 880, y + 42);
    if ((p.kol_count || 0) > 0) { ctx.fillStyle = BLUE; ctx.font = "14px sans-serif"; ctx.fillText(`\uD83D\uDC0B ${p.kol_count} KOLs`, 880, y + 60); }
    try { const pr = await getOhlcvPrices(p.token_mint); if (pr.length > 2) drawSparklineOn(ctx, pr, CARD_W - 160, y + 10, 100, 55); } catch {}
  }
  ctx.fillStyle = DIM; ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText("Updated live \u2014 pumpapi.markets/pools", CARD_W / 2, CARD_H - 30);
  return canvas.toBuffer("image/png");
}

export async function tweetPools(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    const res = await axios.get(`${API}/v1/pools/top`, { timeout: 15000 });
    const pools = Array.isArray(res.data) ? res.data : res.data?.pools || [];
    if (pools.length < 5) return { success: false, error: "Not enough pools" };
    const image = await buildPoolsCard(pools);
    const idx = nextTemplateIndex("pools", T_POOLS.length);
    let text = T_POOLS[idx];
    for (let i = 0; i < 5; i++) { const p = pools[i] || {}; const n = i + 1; text = text.replace(`\${s${n}}`, p.token_symbol || "???").replace(`\${apr${n}}`, (p.current_apr || 0).toFixed(0) + "%").replace(`\${mcap${n}}`, fmt(p.market_cap_usd || 0)).replace(`\${kol${n}}`, String(p.kol_count || 0)); }
    return await postTweet(text, image, "pools", idx);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE C — GRADUATE SPOTLIGHT
// ══════════════════════════════════════════════

export async function tweetGraduate(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    const res = await axios.get(`${API}/v1/pools/top`, { timeout: 15000 });
    const rawPools = Array.isArray(res.data) ? res.data : res.data?.pools || [];
    let best: any = null, bestScan: any = null;
    for (const pool of rawPools.filter((p: any) => p.status === "active").slice(0, 20)) {
      if (!pool.token_mint) continue;
      try { const s = await axios.get(`${API}/v1/tokens/${pool.token_mint}/scan`, { timeout: 10000 }); if (s.data.riskScore <= 60 && (!best || s.data.riskScore < bestScan.riskScore)) { best = pool; bestScan = s.data; } } catch {}
    }
    if (!best || !bestScan) return { success: false, error: "No clean graduates" };
    const prices = await getOhlcvPrices(best.token_mint);
    const { canvas, ctx } = await createBaseCard();
    drawPill(ctx, "JUST GRADUATED \uD83C\uDF93", CARD_W - 280, 30, GREEN, "#000", 14);
    const ti = await loadTokenImg(best.token_image, best.token_symbol); const bc = bestScan.riskScore <= 30 ? GREEN : YELLOW;
    drawTokenCircle(ctx, ti, best.token_symbol || "?", 50, 90, 80, bc);
    ctx.fillStyle = WHITE; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(best.token_name || "???", 150, 95);
    ctx.fillStyle = "#888"; ctx.font = "18px sans-serif"; ctx.fillText(`$${best.token_symbol || "???"}`, 150, 128);
    let sx2 = 50; for (const [l, v] of [["Price", bestScan.priceUsd ? "$" + Number(bestScan.priceUsd).toPrecision(4) : "\u2014"], ["MCap", fmt(bestScan.marketCapUsd || best.market_cap_usd || 0)], ["Holders", String(bestScan.holders || 0)]] as [string, string][]) { ctx.fillStyle = "#888"; ctx.font = "11px sans-serif"; ctx.textAlign = "left"; ctx.fillText(l, sx2, 170); ctx.fillStyle = WHITE; ctx.font = "bold 16px sans-serif"; ctx.fillText(v, sx2, 186); sx2 += 180; }
    if (prices.length > 2) drawSparklineOn(ctx, prices, 50, 220, CARD_W - 100, 200);
    const score = bestScan.riskScore ?? 0; const tier = score <= 30 ? "SAFE" : "MODERATE"; const tc = score <= 30 ? GREEN : YELLOW;
    drawPill(ctx, `${tier} ${score}/100`, 50, 440, tc + "22", tc, 13);
    let fx = 50; const fy = 480;
    if ((bestScan.bundlers?.count || 0) === 0) fx += drawPill(ctx, `${bestScan.bundlers?.count || 0} bundlers \u2705`, fx, fy, GREEN + "22", GREEN, 11) + 8;
    if ((bestScan.lpBurn || 0) >= 100) fx += drawPill(ctx, "LP burned \uD83D\uDD25", fx, fy, GREEN + "22", GREEN, 11) + 8;
    if (!bestScan.mintAuthority) fx += drawPill(ctx, "Mint revoked \u2705", fx, fy, GREEN + "22", GREEN, 11) + 8;
    if ((bestScan.insiders || 0) === 0) fx += drawPill(ctx, "0 insiders \u2705", fx, fy, GREEN + "22", GREEN, 11) + 8;
    if ((best.kol_count || 0) > 0) drawPill(ctx, `\uD83D\uDC0B ${best.kol_count} KOLs tracking`, fx, fy, BLUE + "22", BLUE, 11);
    const image = canvas.toBuffer("image/png");
    const idx = nextTemplateIndex("graduate", T_GRAD.length);
    let text = T_GRAD[idx].replace(/\$\{symbol\}/g, best.token_symbol || "???").replace(/\$\{mcap\}/g, fmt(bestScan.marketCapUsd || best.market_cap_usd || 0)).replace(/\$\{change\}/g, "\u2014").replace(/\$\{score\}/g, String(score)).replace(/\$\{tier\}/g, tier).replace(/\$\{bundlers\}/g, String(bestScan.bundlers?.count || 0)).replace(/\$\{lpBurn\}/g, String((bestScan.lpBurn || 0).toFixed(0))).replace(/\$\{mintStatus\}/g, bestScan.mintAuthority ? "active \u26A0\uFE0F" : "revoked \u2705").replace(/\$\{insiders\}/g, String((bestScan.insidersPercentage || 0).toFixed(1))).replace(/\$\{kolCount\}/g, String(best.kol_count || 0)).replace(/\$\{apr\}/g, (best.current_apr || 0).toFixed(0) + "%").replace(/\$\{address\}/g, best.token_mint || "");
    return await postTweet(text, image, "graduate", idx, best.token_mint);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE D — DAILY STATS
// ══════════════════════════════════════════════

export async function tweetStats(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    const [streamRes, poolsRes] = await Promise.all([
      axios.get(`${API}/v1/stream/stats`, { timeout: 10000 }),
      axios.get(`${API}/v1/pools/top`, { timeout: 10000 }),
    ]);
    const st = streamRes.data; const rawPools = Array.isArray(poolsRes.data) ? poolsRes.data : poolsRes.data?.pools || [];
    const scanned = st.tokensSeenTotal || 0; const pools = rawPools.length;
    const signals = (db.prepare(`SELECT COUNT(*) as cnt FROM telegram_sent WHERE sent_at > datetime('now', '-24 hours')`).get() as any)?.cnt || 0;
    const avgRisk = (db.prepare(`SELECT AVG(risk_score) as avg FROM pumpswap_pools WHERE status = 'active'`).get() as any)?.avg || 50;
    const { canvas, ctx } = await createBaseCard();
    ctx.fillStyle = GREEN; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "center"; ctx.fillText("PumpAgent Daily Report", CARD_W / 2, 100);
    ctx.fillStyle = GREEN; ctx.font = "bold 72px sans-serif"; ctx.fillText(String(scanned), CARD_W / 2, 250);
    ctx.fillStyle = WHITE; ctx.font = "20px sans-serif"; ctx.fillText("tokens scanned in the last 24 hours", CARD_W / 2, 300);
    const boxW = 280, boxH = 100, boxY = 380, gap = 40; const startX = (CARD_W - 3 * boxW - 2 * gap) / 2;
    for (const [i, [label, value]] of ([["Active Pools", String(pools)], ["Signals Fired", String(signals)], ["Avg Risk Score", `${Math.round(avgRisk)}/100`]] as [string, string][]).entries()) {
      const bx = startX + i * (boxW + gap);
      ctx.fillStyle = SURFACE; ctx.beginPath(); roundRect(ctx, bx, boxY, boxW, boxH, 8); ctx.fill();
      ctx.strokeStyle = BORDER; ctx.beginPath(); roundRect(ctx, bx, boxY, boxW, boxH, 8); ctx.stroke();
      ctx.fillStyle = DIM; ctx.font = "12px sans-serif"; ctx.textAlign = "center"; ctx.fillText(label, bx + boxW / 2, boxY + 30);
      ctx.fillStyle = GREEN; ctx.font = "bold 32px sans-serif"; ctx.fillText(value, bx + boxW / 2, boxY + 68);
    }
    const image = canvas.toBuffer("image/png");
    const idx = nextTemplateIndex("stats", T_STATS.length);
    let text = T_STATS[idx].replace(/\$\{scanned\}/g, String(scanned)).replace(/\$\{pools\}/g, String(pools)).replace(/\$\{signals\}/g, String(signals)).replace(/\$\{avgRisk\}/g, String(Math.round(avgRisk)));
    return await postTweet(text, image, "stats", idx);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE E — KOL BEST TRADE
// ══════════════════════════════════════════════

export async function tweetKolTrade(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    // Get top KOL by profit
    const kol = db.prepare(`SELECT * FROM kol_wallets WHERE profit_sol > 0 ORDER BY profit_sol DESC LIMIT 1`).get() as any;
    if (!kol) return { success: false, error: "No KOL trades with positive PnL" };
    // Get a token they hold
    const sighting = db.prepare(`SELECT * FROM kol_token_sightings WHERE address = ? ORDER BY seen_at DESC LIMIT 1`).get(kol.address) as any;
    const mint = sighting?.token_mint;
    let symbol = "???", name = "???", mcap = 0, tokenImg: any = null;
    if (mint) {
      try { const t = await axios.get(`${API}/v1/tokens/${mint}`, { timeout: 10000 }); symbol = t.data?.symbol || "???"; name = t.data?.name || "???"; mcap = t.data?.fdv || 0; tokenImg = await loadTokenImg(t.data?.image, symbol); } catch {}
    }
    const prices = mint ? await getOhlcvPrices(mint) : [];
    const pnlSol = kol.profit_sol || 0; const pnlUsd = fmt(pnlSol * 130); // rough SOL price
    const walletShort = kol.address.slice(0, 4) + "..." + kol.address.slice(-3);
    const { canvas, ctx } = await createBaseCard();
    drawTokenCircle(ctx, tokenImg, symbol, 50, 90, 80, GREEN);
    ctx.fillStyle = WHITE; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(name, 150, 95);
    ctx.fillStyle = "#888"; ctx.font = "18px sans-serif"; ctx.fillText(`$${symbol}`, 150, 128);
    if (prices.length > 2) drawSparklineOn(ctx, prices, 50, 200, CARD_W - 100, 200);
    ctx.fillStyle = GREEN; ctx.font = "bold 48px sans-serif"; ctx.textAlign = "left"; ctx.fillText(`+${pnlSol.toFixed(1)} SOL`, 50, 420);
    drawPill(ctx, `$${pnlUsd}`, 450, 420, GREEN + "22", GREEN, 18);
    ctx.fillStyle = DIM; ctx.font = "14px sans-serif"; ctx.textAlign = "left"; ctx.fillText(`Wallet: ${walletShort}${kol.label ? " (" + kol.label + ")" : ""}`, 50, 490);
    ctx.fillStyle = "#888"; ctx.font = "12px sans-serif"; ctx.fillText(`W: ${kol.wins || 0} | L: ${kol.losses || 0} | MCap: ${fmt(mcap)}`, 50, 515);
    drawPill(ctx, "Tracked by PumpAgent \uD83C\uDFA9", 50, 550, SURFACE, GREEN, 12);
    const image = canvas.toBuffer("image/png");
    const idx = nextTemplateIndex("kol-trade", T_KOL_TRADE.length);
    let text = T_KOL_TRADE[idx].replace(/\$\{symbol\}/g, symbol).replace(/\$\{entryMcap\}/g, "\u2014").replace(/\$\{currentMcap\}/g, fmt(mcap)).replace(/\$\{pnlPercent\}/g, `+${pnlSol.toFixed(1)} SOL`).replace(/\$\{pnlUsd\}/g, `$${pnlUsd}`).replace(/\$\{walletShort\}/g, walletShort);
    return await postTweet(text, image, "kol-trade", idx, mint);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE F — KOL ACTIVITY OVERVIEW
// ══════════════════════════════════════════════

export async function tweetKolActivity(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    const res = await axios.get(`${API}/v1/pools/top`, { timeout: 15000 });
    const rawPools = (Array.isArray(res.data) ? res.data : res.data?.pools || []).filter((p: any) => (p.kol_count || 0) > 0).sort((a: any, b: any) => (b.kol_count || 0) - (a.kol_count || 0)).slice(0, 5);
    if (rawPools.length < 3) return { success: false, error: "Not enough KOL-tracked pools" };
    const { canvas, ctx } = await createBaseCard();
    ctx.fillStyle = GREEN; ctx.font = "bold 32px sans-serif"; ctx.textAlign = "left"; ctx.fillText("Where Smart Money Is", 40, 100);
    ctx.fillStyle = "#888"; ctx.font = "16px sans-serif"; ctx.fillText("Top pools by KOL wallet activity", 40, 128);
    for (let i = 0; i < Math.min(5, rawPools.length); i++) {
      const p = rawPools[i]; const y = 160 + i * 88;
      if (i > 0) { ctx.strokeStyle = BORDER; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(CARD_W - 40, y); ctx.stroke(); }
      ctx.fillStyle = GREEN; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(`${i + 1}`, 50, y + 18);
      const ti = await loadTokenImg(p.token_image, p.token_symbol); drawTokenCircle(ctx, ti, p.token_symbol || "?", 90, y + 16, 30);
      ctx.font = "bold 18px sans-serif"; ctx.fillStyle = WHITE; ctx.textAlign = "left"; ctx.fillText(truncName(ctx, p.token_name || "???", 300), 130, y + 18);
      ctx.fillStyle = "#888"; ctx.font = "14px sans-serif"; ctx.fillText(fmt(p.market_cap_usd || 0), 130, y + 42);
      ctx.fillStyle = GREEN; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "right"; ctx.fillText(`\uD83D\uDC0B ${p.kol_count}`, 880, y + 25);
      try { const pr = await getOhlcvPrices(p.token_mint); if (pr.length > 2) drawSparklineOn(ctx, pr, CARD_W - 160, y + 10, 100, 55); } catch {}
    }
    ctx.fillStyle = DIM; ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText("Track all KOL activity \u2014 pumpapi.markets/pools", CARD_W / 2, CARD_H - 30);
    const image = canvas.toBuffer("image/png");
    const idx = nextTemplateIndex("kol-activity", T_KOL_ACT.length);
    let text = T_KOL_ACT[idx];
    for (let i = 0; i < 5; i++) { const p = rawPools[i] || {}; const n = i + 1; text = text.replace(`\${s${n}}`, p.token_symbol || "???").replace(`\${kol${n}}`, String(p.kol_count || 0)).replace(`\${mcap${n}}`, fmt(p.market_cap_usd || 0)); }
    return await postTweet(text, image, "kol-activity", idx);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE G — TRENCHES RECAP
// ══════════════════════════════════════════════

export async function tweetTrenches(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    const allPools = db.prepare(`SELECT * FROM pumpswap_pools WHERE created_at > datetime('now', '-24 hours') ORDER BY risk_score ASC`).all() as any[];
    const total = allPools.length;
    const clean = allPools.filter((p: any) => (p.risk_score || 100) < 30).length;
    const survived = allPools.filter((p: any) => p.status === "active" && (p.current_tvl_usd || 0) > 100).length;
    const top3 = allPools.filter((p: any) => p.status === "active").slice(0, 3);
    if (total < 3) return { success: false, error: "Not enough graduated tokens" };
    const { canvas, ctx } = await createBaseCard();
    ctx.fillStyle = GREEN; ctx.font = "bold 28px sans-serif"; ctx.textAlign = "left"; ctx.fillText("Trenches Report \u2014 Last 24h", 40, 100);
    const heroY = 160; const heroW = 280;
    for (const [i, [label, val, col]] of ([["Graduated", String(total), WHITE], ["Clean", String(clean), GREEN], ["Survived", String(survived), GREEN]] as [string, string, string][]).entries()) {
      const hx = 60 + i * (heroW + 30);
      ctx.fillStyle = col; ctx.font = "bold 48px sans-serif"; ctx.textAlign = "center"; ctx.fillText(val, hx + heroW / 2, heroY + 40);
      ctx.fillStyle = DIM; ctx.font = "14px sans-serif"; ctx.fillText(label, hx + heroW / 2, heroY + 70);
    }
    // Top 3 survivor cards
    const cardY = 300; const cardW = 340; const cardH = 200;
    for (let i = 0; i < Math.min(3, top3.length); i++) {
      const p = top3[i]; const cx = 60 + i * (cardW + 30);
      ctx.fillStyle = SURFACE; ctx.beginPath(); roundRect(ctx, cx, cardY, cardW, cardH, 8); ctx.fill();
      ctx.strokeStyle = BORDER; ctx.beginPath(); roundRect(ctx, cx, cardY, cardW, cardH, 8); ctx.stroke();
      const ti = await loadTokenImg(p.token_image, p.token_symbol); drawTokenCircle(ctx, ti, p.token_symbol || "?", cx + 15, cardY + 15, 40);
      ctx.fillStyle = WHITE; ctx.font = "bold 16px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(truncName(ctx, p.token_name || "???", 200), cx + 65, cardY + 18);
      ctx.fillStyle = "#888"; ctx.font = "13px sans-serif"; ctx.fillText(fmt(p.market_cap_usd || 0), cx + 65, cardY + 38);
      const sc = p.risk_score || 50; const scCol = sc <= 30 ? GREEN : sc <= 60 ? YELLOW : RED;
      drawPill(ctx, `${sc}/100`, cx + 15, cardY + 65, scCol + "22", scCol, 11);
      try { const pr = await getOhlcvPrices(p.token_mint); if (pr.length > 2) drawSparklineOn(ctx, pr, cx + 15, cardY + 100, cardW - 30, 80); } catch {}
    }
    const image = canvas.toBuffer("image/png");
    const idx = nextTemplateIndex("trenches", T_TRENCHES.length);
    const survivalRate = total > 0 ? Math.round((survived / total) * 100) : 0;
    let text = T_TRENCHES[idx].replace(/\$\{total\}/g, String(total)).replace(/\$\{clean\}/g, String(clean)).replace(/\$\{survived\}/g, String(survived)).replace(/\$\{survivalRate\}/g, String(survivalRate));
    for (let i = 0; i < 3; i++) { const p = top3[i] || {}; const n = i + 1; text = text.replace(`\${s${n}}`, p.token_symbol || "???").replace(`\${mcap${n}}`, fmt(p.market_cap_usd || 0)); }
    return await postTweet(text, image, "trenches", idx);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TYPE H — PLATFORM HIGHLIGHT
// ══════════════════════════════════════════════

db.exec(`CREATE TABLE IF NOT EXISTS twitter_feature_state (id INTEGER PRIMARY KEY CHECK (id = 1), feature_index INTEGER NOT NULL DEFAULT 0)`);
db.exec(`INSERT OR IGNORE INTO twitter_feature_state (id, feature_index) VALUES (1, 0)`);

export async function tweetHighlight(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const check = canPost(); if (!check.ok) return { success: false, error: check.reason };
  try {
    const row = db.prepare(`SELECT feature_index FROM twitter_feature_state WHERE id = 1`).get() as any;
    const fi = row ? row.feature_index : 0;
    db.prepare(`UPDATE twitter_feature_state SET feature_index = ? WHERE id = 1`).run((fi + 1) % 5);
    const titles = ["Pool Explorer", "The Trenches", "Trading Terminal", "Free API", "Telegram Signals"];
    const subtitles = ["AI-ranked PumpSwap pools", "Real-time token feed", "Charts + Swap + Risk", "npm install getpumpagent", "Filtered picks with risk data"];
    const urls = ["pumpapi.markets/pools", "pumpapi.markets/trenches", "pumpapi.markets/swap", "pumpapi.markets/quickstart", "t.me/PumpAgentSignals"];

    const { canvas, ctx } = await createBaseCard();
    ctx.fillStyle = GREEN; ctx.font = "bold 36px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(titles[fi], CARD_W / 2, CARD_H / 2 - 60);
    ctx.fillStyle = WHITE; ctx.font = "22px sans-serif"; ctx.fillText(subtitles[fi], CARD_W / 2, CARD_H / 2);
    ctx.fillStyle = GREEN; ctx.font = "bold 18px sans-serif"; ctx.fillText(`\u2192 ${urls[fi]}`, CARD_W / 2, CARD_H / 2 + 50);
    drawPill(ctx, "FREE \uD83C\uDFA9", CARD_W / 2 - 40, CARD_H / 2 + 90, GREEN, "#000", 16);
    const image = canvas.toBuffer("image/png");

    const templates = T_HIGHLIGHT[fi]; const tmplIdx = nextTemplateIndex("highlight", templates.length);
    return await postTweet(templates[tmplIdx], image, "highlight", tmplIdx);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// ══════════════════════════════════════════════
// TEST TWEET
// ══════════════════════════════════════════════

export async function tweetTest(): Promise<{ success: boolean; error?: string; tweetId?: string }> {
  const { canvas, ctx } = await createBaseCard();
  ctx.fillStyle = GREEN; ctx.font = "bold 36px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("PumpAgent is live.", CARD_W / 2, CARD_H / 2 - 20);
  ctx.fillStyle = "#888"; ctx.font = "18px sans-serif"; ctx.fillText("AI-powered meme coin intelligence.", CARD_W / 2, CARD_H / 2 + 25);
  return await postTweet("\uD83C\uDFA9 PumpAgent is live.\n\nAI-powered meme coin intelligence.\n\npumpapi.markets", canvas.toBuffer("image/png"), "test", 0);
}

// ══════════════════════════════════════════════
// ROTATION DISPATCHER
// ══════════════════════════════════════════════

const DISPATCH: Record<TweetType, () => Promise<{ success: boolean; error?: string; tweetId?: string }>> = {
  "pick": tweetPick,
  "pools": tweetPools,
  "graduate": tweetGraduate,
  "stats": tweetStats,
  "kol-trade": tweetKolTrade,
  "kol-activity": tweetKolActivity,
  "trenches": tweetTrenches,
  "highlight": tweetHighlight,
};

async function fireRotation() {
  const idx = getAndAdvanceRotation();
  const type = ROTATION_TYPES[idx];
  log.info({ idx, type }, "Rotation firing");
  const fn = DISPATCH[type];
  const result = await fn();
  if (!result.success) log.warn({ type, error: result.error }, "Rotation slot skipped");
  return { type, ...result };
}

// ══════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════

export async function twitterAdminRoutes(app: any) {
  app.post("/v1/admin/tweet", async (req: any, reply: any) => {
    const key = req.headers["x-admin-key"] || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) { reply.code(401); return { error: "Unauthorized" }; }
    const { type } = req.body || {};
    const fn = DISPATCH[type as TweetType];
    if (!fn) { reply.code(400); return { error: `Invalid type. Use: ${ROTATION_TYPES.join(", ")}` }; }
    return await fn();
  });

  app.post("/v1/admin/tweet/test", async (req: any, reply: any) => {
    const key = req.headers["x-admin-key"] || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) { reply.code(401); return { error: "Unauthorized" }; }
    return await tweetTest();
  });

  app.get("/v1/admin/tweets", async (req: any, reply: any) => {
    const key = req.headers["x-admin-key"] || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) { reply.code(401); return { error: "Unauthorized" }; }
    const rows = db.prepare("SELECT id, tweet_id, type, template_index, text, token_address, timestamp, success, error FROM twitter_posts ORDER BY id DESC LIMIT 20").all();
    const rot = (getRotationIdx.get() as any)?.current_index || 0;
    return { tweets: rows, nextRotation: { index: rot, type: ROTATION_TYPES[rot] } };
  });

  app.post("/v1/admin/tweet/skip", async (req: any, reply: any) => {
    const key = req.headers["x-admin-key"] || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) { reply.code(401); return { error: "Unauthorized" }; }
    const skipped = advanceRotationOnly();
    const next = (getRotationIdx.get() as any)?.current_index || 0;
    return { skipped: ROTATION_TYPES[skipped], next: ROTATION_TYPES[next], nextIndex: next };
  });
}

// ══════════════════════════════════════════════
// CRON
// ══════════════════════════════════════════════

export function startTwitterCron() {
  if (!ENABLED) { log.info("Twitter bot disabled (TWITTER_BOT_ENABLED != true)"); return; }
  log.info("Twitter bot cron starting — 8-type rotation every 6h");
  // Optimized for crypto peak hours:
  // 6:30 AM PST (13:30 UTC) — US market open
  // 12:00 PM PST (20:00 UTC) — lunch peak
  // 5:00 PM PST (01:00 UTC) — market close
  // 11:30 PM PST (07:30 UTC) — late night degens + Asia
  cron.schedule("30 13 * * *", async () => { log.info("Cron: 6:30AM PST"); await fireRotation(); });
  cron.schedule("0 20 * * *", async () => { log.info("Cron: 12PM PST"); await fireRotation(); });
  cron.schedule("0 1 * * *", async () => { log.info("Cron: 5PM PST"); await fireRotation(); });
  cron.schedule("30 7 * * *", async () => { log.info("Cron: 11:30PM PST"); await fireRotation(); });

  const rot = (getRotationIdx.get() as any)?.current_index || 0;
  log.info({ nextType: ROTATION_TYPES[rot], nextIndex: rot }, "Next rotation slot");
}
