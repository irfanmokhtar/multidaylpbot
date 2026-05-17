/**
 * Thin fetch wrappers against the Fastify routes in src/web/routes/*.
 * Components use the react-query hooks in `queries.ts`, not these directly.
 */

import type {
  StatusReport,
  HealthReport,
  SchedulerStatus,
  PoolRow,
  DecisionRow,
  DecisionsPage,
  IndicatorsResponse,
  OhlcvSnapshot,
  PnlReport,
  PositionHistoryResponse,
} from "./schemas";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  status: () => getJson<StatusReport>("/api/status"),
  health: () => getJson<HealthReport>("/api/health"),
  scheduler: () => getJson<SchedulerStatus>("/api/scheduler"),
  pool: () => getJson<PoolRow>("/api/pool"),
  decisions: (limit = 50, before?: number) =>
    getJson<DecisionsPage>(
      `/api/decisions?limit=${limit}${before ? `&before=${before}` : ""}`,
    ),
  decision: (id: number) => getJson<DecisionRow>(`/api/decisions/${id}`),
  indicators: () => getJson<IndicatorsResponse>("/api/indicators"),
  ohlcv: (interval: "1H" | "4H" | "1D" = "1H") =>
    getJson<OhlcvSnapshot>(`/api/ohlcv?interval=${interval}`),
  pnl: () => getJson<PnlReport>("/api/pnl"),
  pnlHistory: (positionAddress: string) =>
    getJson<PositionHistoryResponse>(
      `/api/pnl/history?positionAddress=${encodeURIComponent(positionAddress)}`,
    ),
};
