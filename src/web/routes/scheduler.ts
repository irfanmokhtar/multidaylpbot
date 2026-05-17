import type { FastifyInstance } from "fastify";
import { getSchedulerStatus } from "../../scheduler";

export async function registerSchedulerRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/scheduler", async () => {
    return getSchedulerStatus();
  });
}
