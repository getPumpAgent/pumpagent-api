import type { FastifyInstance } from "fastify";
import { datastreamEvents, datastreamStats, solPrice } from "./datastream.js";
import { getAccumulatorStats } from "./tokenAccumulator.js";
import { createLogger } from "../utils/logger.js";
import axios from "axios";

const log = createLogger("datastream-sse");

function sseRoute(
  app: FastifyInstance,
  path: string,
  events: string[],  // listen to multiple event types on one SSE connection
) {
  app.get(path, (req, reply) => {
    reply.hijack();

    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    raw.write(`data: ${JSON.stringify({ type: "connected", events })}\n\n`);

    const handlers: Array<{ event: string; fn: (data: unknown) => void }> = [];
    for (const event of events) {
      const fn = (data: unknown) => {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      datastreamEvents.on(event, fn);
      handlers.push({ event, fn });
    }

    const heartbeat = setInterval(() => {
      raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, 30_000);

    req.raw.on("close", () => {
      for (const h of handlers) datastreamEvents.removeListener(h.event, h.fn);
      clearInterval(heartbeat);
      log.debug({ events }, "SSE client disconnected");
    });
  });
}

export async function datastreamSseRoutes(app: FastifyInstance) {
  // Individual streams
  sseRoute(app, "/v1/stream/latest", ["latest"]);
  sseRoute(app, "/v1/stream/graduating", ["graduating"]);
  sseRoute(app, "/v1/stream/graduated", ["graduated"]);

  // Combined trenches stream: graduating + graduated + live pool/holder updates + risk enrichment
  sseRoute(app, "/v1/stream/trenches", ["graduating", "graduated", "pool-update", "holder-update", "risk-update"]);

  // SOL price stream for game
  sseRoute(app, "/v1/stream/price/sol", ["sol-price"]);

  // SOL OHLCV history from GeckoTerminal (cached 5 min)
  let ohlcvCache: { data: any; expiry: number } = { data: null, expiry: 0 };
  app.get("/v1/game/sol-history", async (_req, reply) => {
    if (ohlcvCache.data && Date.now() < ohlcvCache.expiry) return ohlcvCache.data;
    try {
      // Raydium SOL/USDC pool
      const poolAddr = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
      const { data } = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddr}/ohlcv/minute?limit=200`,
        { timeout: 10000, headers: { Accept: "application/json" } }
      );
      const list = data?.data?.attributes?.ohlcv_list || [];
      // Format: [[timestamp, open, high, low, close, volume], ...]
      const result = {
        prices: list.map((c: any) => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] })).reverse(),
        currentPrice: solPrice,
      };
      ohlcvCache = { data: result, expiry: Date.now() + 300_000 };
      return result;
    } catch (err: any) {
      // Fallback: return current price only
      return reply.status(502).send({ error: "Failed to fetch OHLCV", currentPrice: solPrice });
    }
  });

  // Stats endpoint
  app.get("/v1/stream/stats", async () => ({
    ...datastreamStats,
    accumulator: getAccumulatorStats(),
  }));

  log.info("SSE routes registered: /v1/stream/{latest,graduating,graduated,trenches,price/sol,stats}");
}
