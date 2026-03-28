import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
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

const app = Fastify({ logger: true });

await app.register(cors);
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

app.get("/health", async () => ({ status: "ok" }));

const port = Number(process.env.PORT) || 3000;
await app.listen({ port, host: "0.0.0.0" });

console.log(`pumpagent-api listening on :${port}`);

startSignalCron();
