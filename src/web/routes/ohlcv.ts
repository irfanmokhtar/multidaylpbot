import type { FastifyInstance } from "fastify";
import { ohlcvRepo } from "../../state/repos";

interface OhlcvQuery {
  symbol?: string;
  interval?: string;
}

const ALLOWED_INTERVALS = new Set(["1H", "4H", "1D"]);

export async function registerOhlcvRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: OhlcvQuery }>("/api/ohlcv", async (req, reply) => {
    const symbol = req.query.symbol ?? "SOL";
    const interval = req.query.interval ?? "1H";
    if (!ALLOWED_INTERVALS.has(interval)) {
      reply.status(400);
      return { error: `interval must be one of ${[...ALLOWED_INTERVALS].join(", ")}` };
    }
    const snap = ohlcvRepo.latest(symbol, interval);
    if (!snap) {
      reply.status(404);
      return { error: "no snapshot for symbol+interval" };
    }
    return {
      symbol: snap.symbol,
      interval: snap.interval,
      fetchedAt: snap.fetchedAt,
      candles: snap.candles,
    };
  });
}
