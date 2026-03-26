import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { tokenRoutes } from "./routes/tokens.js";
import { swapRoutes } from "./routes/swap.js";

const app = Fastify({ logger: true });

await app.register(cors);
await app.register(tokenRoutes);
await app.register(swapRoutes);

app.get("/health", async () => ({ status: "ok" }));

const port = Number(process.env.PORT) || 3000;
await app.listen({ port, host: "0.0.0.0" });

console.log(`pumpagent-api listening on :${port}`);
