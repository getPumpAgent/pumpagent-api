import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { tokenRoutes } from "./routes/tokens.js";
import { swapRoutes, swapStatusRoutes } from "./routes/swap.js";
import { kolRoutes } from "./routes/kol.js";
import { marketRoutes } from "./routes/market.js";
import { narrativesRoutes } from "./routes/narratives.js";
import { picksRoutes } from "./routes/picks.js";
import { referralRoutes } from "./routes/referral.js";
import { telegramRoutes } from "./routes/telegram.js";
import { signalRoutes } from "./routes/signals.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { startSignalCron } from "./services/telegramService.js";
import { startPumpswapMonitor } from "./services/pumpswapMonitor.js";
import { poolRoutes } from "./routes/pools.js";
import { liquidityRoutes } from "./routes/liquidity.js";
import { triggerOrderRoutes } from "./routes/triggerOrders.js";
import { dcaRoutes } from "./routes/dca.js";
import { lendRoutes } from "./routes/lend.js";
import { jupiterDataRoutes } from "./routes/jupiterData.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { startTelegramBot } from "./services/telegramBot.js";
import { startDatastream } from "./services/datastream.js";
import { twitterAdminRoutes, startTwitterCron } from "./services/twitter-bot.js";
import { startKolCollector } from "./services/kolService.js";
import { gameRoutes } from "./routes/game.js";
import { datastreamSseRoutes } from "./services/datastream-sse.js";
import { positionRoutes } from "./routes/positions.js";
import { startAccumulator } from "./services/tokenAccumulator.js";

const app = Fastify({ logger: true });

await app.register(cors);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await app.register(fastifyStatic, {
  root: path.join(__dirname, "..", "public"),
  prefix: "/",
});

// Clean URL routes → serve static HTML files
app.get("/", async (_req, reply) => reply.sendFile("index.html"));
app.get("/live", async (_req, reply) => reply.sendFile("live.html"));
app.get("/swap", async (_req, reply) => reply.sendFile("swap.html"));
app.get("/pools", async (_req, reply) => reply.sendFile("pools.html"));

await app.register(tokenRoutes);
await app.register(swapRoutes);
await app.register(swapStatusRoutes);
await app.register(kolRoutes);
await app.register(marketRoutes);
await app.register(narrativesRoutes);
await app.register(picksRoutes);
await app.register(referralRoutes);
await app.register(telegramRoutes);
await app.register(signalRoutes);
await app.register(portfolioRoutes);
await app.register(liquidityRoutes);
await app.register(poolRoutes);
await app.register(triggerOrderRoutes);
await app.register(dcaRoutes);
await app.register(lendRoutes);
await app.register(jupiterDataRoutes);
await app.register(datastreamSseRoutes);
await app.register(analyticsRoutes);
await app.register(twitterAdminRoutes);
await app.register(gameRoutes);
await app.register(positionRoutes);

app.get("/health", async () => ({ status: "ok" }));

const port = Number(process.env.PORT) || 3000;
await app.listen({ port, host: "0.0.0.0" });

console.log(`pumpagent-api listening on :${port}`);

startSignalCron();
startPumpswapMonitor();
startTelegramBot();
startAccumulator();
startDatastream();
startTwitterCron();
startKolCollector();
