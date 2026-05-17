import type { FastifyInstance } from "fastify";
import { decisionRepo } from "../../state/repos";

/**
 * Return the indicator pack from the most recent decision's input. Avoids a
 * fresh Birdeye fetch — the analyzer already cached this when it last ran.
 * If no decision has been recorded yet, return an empty object so the
 * frontend can render an empty state.
 */
export async function registerIndicatorsRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/indicators", async () => {
    const [latest] = decisionRepo.recent(1);
    if (!latest) {
      return { "1H": null, "4H": null, "1D": null, decidedAt: null };
    }
    return {
      ...latest.input.indicators,
      decidedAt: latest.decidedAt,
      cycle: latest.cycle,
    };
  });
}
