import WebSocket from "ws";
// @ts-expect-error — polyfill global WebSocket for Node.js (SDK expects browser API)
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

import { Datastream } from "@solana-tracker/data-api";
import { EventEmitter } from "events";
import { createLogger } from "../utils/logger.js";
import { updateTokenFromPool, updateTokenHolders } from "./tokenAccumulator.js";
import { getTokenInsights } from "./solanaTrackerService.js";

const log = createLogger("datastream");

// ── Shared event bus ──
export const datastreamEvents = new EventEmitter();
datastreamEvents.setMaxListeners(100);

// ── SOL price state (for game) ──
export let solPrice = 0;
export let solPriceTs = 0;

// ── Stats ──
export const datastreamStats = {
  connected: false,
  tokensSeenTotal: 0,
  graduatingTotal: 0,
  graduatedTotal: 0,
  lastLatest: null as string | null,
  lastGraduating: null as string | null,
  lastGraduated: null as string | null,
  connectedAt: null as string | null,
  reconnects: 0,
  tokenSubs: 0,
};

let ds: Datastream | null = null;

// ── Per-token subscriptions for live price/holder updates ──
const tokenSubs = new Map<string, { pool: { unsubscribe: () => void }; holders: { unsubscribe: () => void } }>();
const MAX_TOKEN_SUBS = 80;

function subscribeToToken(mint: string) {
  if (!ds || tokenSubs.has(mint)) return;

  try {
    // Subscribe to primary pool updates (price, mcap, liquidity)
    const poolSub = ds.subscribe.token(mint).primary().on((data) => {
      updateTokenFromPool(mint, data);
      datastreamEvents.emit("pool-update", { mint, ...data });
    });

    // Subscribe to holder count changes
    const holderSub = ds.subscribe.holders(mint).on((data) => {
      updateTokenHolders(mint, data.total);
      datastreamEvents.emit("holder-update", { mint, total: data.total });
    });

    tokenSubs.set(mint, { pool: poolSub, holders: holderSub });
    datastreamStats.tokenSubs = tokenSubs.size;
  } catch (e) {
    // Silently fail — some tokens may not have pools yet
  }
}

function unsubscribeToken(mint: string) {
  const sub = tokenSubs.get(mint);
  if (!sub) return;
  try { sub.pool.unsubscribe(); } catch {}
  try { sub.holders.unsubscribe(); } catch {}
  tokenSubs.delete(mint);
  datastreamStats.tokenSubs = tokenSubs.size;
}

function trimTokenSubs() {
  if (tokenSubs.size <= MAX_TOKEN_SUBS) return;
  // Remove oldest subs (first inserted)
  const keys = [...tokenSubs.keys()];
  const toRemove = keys.slice(0, keys.length - MAX_TOKEN_SUBS);
  for (const mint of toRemove) {
    unsubscribeToken(mint);
  }
}

// ── ST enrichment queue (1 call/sec rate limit) ──
const enrichQueue: string[] = [];
const enrichSeen = new Set<string>();

function queueEnrichment(mint: string) {
  if (!mint || enrichSeen.has(mint)) return;
  enrichSeen.add(mint);
  enrichQueue.push(mint);
}

function startEnrichmentWorker() {
  setInterval(async () => {
    const mint = enrichQueue.shift();
    if (!mint) return;
    try {
      const insights = await getTokenInsights(mint);
      // Only emit if we got real data (not empty/error)
      if (insights && insights.holders > 0) {
        datastreamEvents.emit("risk-update", { mint, risk: insights });
        log.debug({ mint: mint.slice(0, 8) }, "Enrichment complete");
      }
    } catch (e: any) {
      log.warn({ mint: mint.slice(0, 8), err: e.message }, "Enrichment failed");
    }
  }, 1000);
}

export function startDatastream(): void {
  const wsUrl = process.env.SOLANA_TRACKER_WS_URL;
  if (!wsUrl || wsUrl.includes("YOUR_DATASTREAM_KEY")) {
    log.warn("SOLANA_TRACKER_WS_URL not configured — datastream disabled");
    return;
  }

  log.info("Connecting to Solana Tracker datastream...");

  ds = new Datastream({
    wsUrl,
    autoReconnect: true,
    reconnectDelay: 2500,
    reconnectDelayMax: 10000,
    randomizationFactor: 0.5,
  });

  // ── Latest tokens ──
  ds.subscribe.latest().on((data) => {
    datastreamStats.tokensSeenTotal++;
    datastreamStats.lastLatest = new Date().toISOString();
    datastreamEvents.emit("latest", data);
  });

  // ── Graduating tokens ──
  ds.subscribe.graduating().on((data) => {
    datastreamStats.graduatingTotal++;
    datastreamStats.lastGraduating = new Date().toISOString();
    datastreamEvents.emit("graduating", data);
    // Auto-subscribe to per-token updates
    const mint = data.token?.mint;
    if (mint) {
      if (!tokenSubs.has(mint)) { subscribeToToken(mint); trimTokenSubs(); }
      queueEnrichment(mint);
    }
  });

  // ── Graduated tokens ──
  ds.subscribe.graduated().on((data) => {
    datastreamStats.graduatedTotal++;
    datastreamStats.lastGraduated = new Date().toISOString();
    datastreamEvents.emit("graduated", data);
    // Auto-subscribe to per-token updates
    const mint = data.token?.mint;
    if (mint) {
      if (!tokenSubs.has(mint)) { subscribeToToken(mint); trimTokenSubs(); }
      queueEnrichment(mint);
    }
  });

  // ── Connection lifecycle events ──
  ds.on("connected", () => {
    datastreamStats.connected = true;
    datastreamStats.connectedAt = new Date().toISOString();
    log.info("Datastream connected");
  });

  ds.on("disconnected", () => {
    datastreamStats.connected = false;
    datastreamStats.reconnects++;
    // Clear per-token subs on disconnect (they'll re-subscribe on reconnect)
    tokenSubs.clear();
    datastreamStats.tokenSubs = 0;
    log.warn("Datastream disconnected — will auto-reconnect");
  });

  ds.on("reconnecting", (attempt: number) => {
    log.info({ attempt }, "Datastream reconnecting...");
  });

  ds.on("error", (err: unknown) => {
    log.error({ err }, "Datastream error");
  });

  // ── SOL price subscription (for game) ──
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  ds.subscribe.token(SOL_MINT).primary().on((data) => {
    const p = data.price?.usd;
    if (p && p > 0) {
      solPrice = p;
      solPriceTs = Date.now();
      datastreamEvents.emit("sol-price", { price: p, timestamp: solPriceTs });
    }
  });

  ds.connect().catch((err) => {
    log.error({ err }, "Failed to connect to datastream");
  });

  // Start enrichment queue worker
  startEnrichmentWorker();
  log.info("ST enrichment queue started (1 call/sec)");
}

export function getDatastream(): Datastream | null {
  return ds;
}
