import type { FastifyInstance } from "fastify";
import { decisionRepo } from "../../state/repos";

interface ListQuery {
  limit?: string;
  before?: string;
}

interface IdParams {
  id: string;
}

export async function registerDecisionsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListQuery }>("/api/decisions", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const before = req.query.before ? Number(req.query.before) : undefined;
    return decisionRepo.range({ limit, beforeMs: before });
  });

  app.get<{ Params: IdParams }>("/api/decisions/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      reply.status(400);
      return { error: "invalid id" };
    }
    const row = decisionRepo.byId(id);
    if (!row) {
      reply.status(404);
      return { error: "not found" };
    }
    return row;
  });
}
