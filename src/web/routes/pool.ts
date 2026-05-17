import type { FastifyInstance } from "fastify";
import { resolveActivePool } from "../../poolMode";
import { getPool } from "../../data/meteora_api";

export async function registerPoolRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/pool", async (_req, reply) => {
    const address = resolveActivePool();
    if (!address) {
      reply.status(404);
      return { error: "POOL_ADDRESS not set" };
    }
    const row = await getPool(address);
    if (!row) {
      reply.status(404);
      return { error: "pool not found in Meteora API" };
    }
    return row;
  });
}
