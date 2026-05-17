import type { FastifyInstance } from "fastify";
import { buildStatusReport } from "../../report";

export async function registerStatusRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/status", async () => {
    return await buildStatusReport();
  });
}
