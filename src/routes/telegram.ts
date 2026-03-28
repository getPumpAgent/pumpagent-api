import { FastifyInstance } from "fastify";
import { sendTestAlert, runSignalCycle, sendTestFollowup } from "../services/telegramService.js";

export async function telegramRoutes(app: FastifyInstance) {
  // Send test alert (admin only)
  app.post("/v1/telegram/test", async (req, reply) => {
    const key = (req.headers as any)["x-admin-key"];
    if (key !== process.env.ADMIN_KEY) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const success = await sendTestAlert();
    return { success, message: success ? "Test alert sent" : "Failed to send" };
  });

  // Manually trigger one signal cycle (admin only)
  app.post("/v1/telegram/cycle", async (req, reply) => {
    const key = (req.headers as any)["x-admin-key"];
    if (key !== process.env.ADMIN_KEY) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const result = await runSignalCycle();
    return result;
  });

  // Test followup message (admin only)
  app.post("/v1/telegram/test-followup", async (req, reply) => {
    const key = (req.headers as any)["x-admin-key"];
    if (key !== process.env.ADMIN_KEY) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const success = await sendTestFollowup();
    return { success, message: success ? "Test followup sent" : "Failed to send" };
  });
}
