import type { FastifyInstance } from "fastify";
import { buildPnlReport } from "../../pnlReport";
import { getPositionHistorical } from "../../data/meteora_pnl";

interface HistoryQuery {
  positionAddress?: string;
}

export async function registerPnlRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/pnl", async () => {
    return await buildPnlReport();
  });

  app.get<{ Querystring: HistoryQuery }>(
    "/api/pnl/history",
    async (req, reply) => {
      const addr = req.query.positionAddress;
      if (!addr) {
        reply.status(400);
        return { error: "positionAddress query param required" };
      }
      const events = await getPositionHistorical(addr, { orderDirection: "desc" });
      return { events };
    },
  );
}
