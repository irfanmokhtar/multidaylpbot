/**
 * Meteora data API — PnL / portfolio / fee-claim endpoints.
 *
 *   Base URL: https://dlmm.datapi.meteora.ag
 *   Auth:     none (same host as src/data/meteora_api.ts)
 *
 * Used by `src/report/pnlReport.ts` to assemble the dashboard / Telegram /
 * CLI PnL view. All monetary fields come back as decimal strings — parse at
 * the consumer boundary, never store as `number` raw here.
 *
 * Throttled to ≥1.1s between calls (Meteora doesn't publish a rate limit but
 * we play nice). Retries once on 429 honoring `Retry-After`.
 */

import { logger } from "../logger";

const BASE = "https://dlmm.datapi.meteora.ag";
const FETCH_TIMEOUT_MS = 12_000;
const MIN_REQUEST_SPACING_MS = 1_100;
const MAX_429_RETRIES = 1;
const DEFAULT_429_BACKOFF_MS = 2_000;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  const wait = MIN_REQUEST_SPACING_MS - elapsed;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function get<T>(pathAndQuery: string): Promise<T> {
  const url = `${BASE}${pathAndQuery}`;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : DEFAULT_429_BACKOFF_MS * (attempt + 1);
        logger.warn({ attempt: attempt + 1, waitMs, url }, "Meteora PnL 429 — backing off");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Meteora PnL ${res.status} ${res.statusText} on ${url}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Types (mirror Meteora's OpenAPI shapes) ─────────────────────────────────

export interface TokenAmount {
  amount: string;
  amountSol?: string | null;
  usd: string;
}

export interface TotalUsd {
  sol?: string | null;
  usd: string;
}

export interface TokenPairWithTotal {
  tokenX: TokenAmount;
  tokenY: TokenAmount;
  total: TotalUsd;
}

export interface UnrealizedPnL {
  balances: number;
  balancesSol?: string | null;
  balanceTokenX: TokenAmount;
  balanceTokenY: TokenAmount;
  unclaimedFeeTokenX: TokenAmount;
  unclaimedFeeTokenY: TokenAmount;
  unclaimedRewardTokenX: TokenAmount;
  unclaimedRewardTokenY: TokenAmount;
}

export interface PositionPnLData {
  positionAddress: string;
  minPrice: string;
  maxPrice: string;
  lowerBinId: number;
  upperBinId: number;
  isClosed: boolean;
  isOutOfRange?: boolean | null;
  feePerTvl24h: string;
  pnlUsd: string;
  pnlPctChange: string;
  pnlSol?: number | null;
  pnlSolPctChange?: number | null;
  allTimeDeposits: TokenPairWithTotal;
  allTimeWithdrawals: TokenPairWithTotal;
  allTimeFees: TokenPairWithTotal;
  createdAt?: number | null;
  closedAt?: number | null;
  poolActiveBinId?: number | null;
  poolActivePrice?: string | null;
  unrealizedPnl?: UnrealizedPnL | null;
}

export interface PoolPositionPnLResponse {
  positions: PositionPnLData[];
  tokenX?: string | null;
  tokenY?: string | null;
  tokenXPrice: string;
  tokenYPrice: string;
  rewardTokenX?: string | null;
  rewardTokenY?: string | null;
  rewardTokenXPrice: string;
  rewardTokenYPrice: string;
  solPrice?: string | null;
  totalCount: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

export interface PortfolioTotal {
  totalPnlUsd: string;
  totalPnlSol: string;
  totalPnlPctChange: string;
  totalPnlSolPctChange: string;
}

export interface PoolPortfolioItem {
  poolAddress: string;
  binStep: string;
  baseFee: string;
  collectFeeMode: number;
  tokenXMint: string;
  tokenYMint: string;
  tokenX: string;
  tokenY: string;
  tokenXIcon: string;
  tokenYIcon: string;
  totalDeposit: string;
  totalDepositSol: string;
  totalWithdrawal: string;
  totalWithdrawalSol: string;
  totalFee: string;
  totalFeeSol: string;
  pnlUsd: string;
  pnlSol: string;
  pnlPctChange: string;
  pnlSolPctChange: string;
  totalDepositTokenX: string;
  totalDepositTokenXUsd: string;
  totalDepositTokenXSol: string;
  totalWithdrawalTokenX: string;
  totalWithdrawalTokenXUsd: string;
  totalWithdrawalTokenXSol: string;
  totalFeeTokenX: string;
  totalFeeTokenXUsd: string;
  totalFeeTokenXSol: string;
  totalDepositTokenY: string;
  totalDepositTokenYUsd: string;
  totalDepositTokenYSol: string;
  totalWithdrawalTokenY: string;
  totalWithdrawalTokenYUsd: string;
  totalWithdrawalTokenYSol: string;
  totalFeeTokenY: string;
  totalFeeTokenYUsd: string;
  totalFeeTokenYSol: string;
  lastClosedAt?: number | null;
}

export interface PortfolioResponse {
  pools: PoolPortfolioItem[];
  totalCount: number;
  totalPositions: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

export interface PositionEvent {
  signature: string;
  ixIndex: number;
  eventType: string;
  positionAddress: string;
  poolAddress: string;
  userAddress: string;
  blockTime: number;
  slot: number;
  tokenX: string;
  tokenY: string;
  amountX: string;
  amountY: string;
  amountXUsd: string;
  amountYUsd: string;
  totalUsd: string;
  createdAt: string;
}

export interface PositionHistoricalResponse {
  events: PositionEvent[];
}

export interface TotalClaims {
  pool_address: string;
  user_address: string;
  total_fee_x: string;
  total_fee_y: string;
  total_fee_x_usd: string;
  total_fee_y_usd: string;
  total_fee_x_sol: string;
  total_fee_y_sol: string;
  fee_claim_count: number;
  total_reward_x: string;
  total_reward_y: string;
  total_reward_x_usd: string;
  total_reward_y_usd: string;
  total_reward_x_sol: string;
  total_reward_y_sol: string;
  reward_claim_count: number;
  total_claims_usd: string;
  total_claims_sol: string;
  last_fee_claim_time?: string | null;
  last_reward_claim_time?: string | null;
}

// ─── Fetchers ────────────────────────────────────────────────────────────────

export async function getPortfolio(
  wallet: string,
  opts: { page?: number; pageSize?: number; daysBack?: number } = {},
): Promise<PortfolioResponse> {
  const params = new URLSearchParams({ user: wallet });
  if (opts.page != null) params.set("page", String(opts.page));
  if (opts.pageSize != null) params.set("page_size", String(opts.pageSize));
  if (opts.daysBack != null) params.set("days_back", String(opts.daysBack));
  return get<PortfolioResponse>(`/portfolio?${params}`);
}

export async function getPortfolioTotal(wallet: string): Promise<PortfolioTotal> {
  const params = new URLSearchParams({ user: wallet });
  return get<PortfolioTotal>(`/portfolio/total?${params}`);
}

export async function getPoolPositionPnL(
  poolAddress: string,
  wallet: string,
  opts: { status?: "open" | "closed"; page?: number; pageSize?: number } = {},
): Promise<PoolPositionPnLResponse> {
  const params = new URLSearchParams({ user: wallet });
  if (opts.status) params.set("status", opts.status);
  if (opts.page != null) params.set("page", String(opts.page));
  if (opts.pageSize != null) params.set("page_size", String(opts.pageSize));
  return get<PoolPositionPnLResponse>(
    `/positions/${encodeURIComponent(poolAddress)}/pnl?${params}`,
  );
}

export async function getPositionHistorical(
  positionAddress: string,
  opts: { eventType?: string; orderDirection?: "asc" | "desc" } = {},
): Promise<PositionEvent[]> {
  const params = new URLSearchParams();
  if (opts.eventType) params.set("event_type", opts.eventType);
  if (opts.orderDirection) params.set("order_direction", opts.orderDirection);
  const qs = params.toString();
  const r = await get<PositionHistoricalResponse>(
    `/positions/${encodeURIComponent(positionAddress)}/historical${qs ? `?${qs}` : ""}`,
  );
  return r.events;
}

export async function getTotalClaims(
  wallet: string,
  poolAddress: string,
): Promise<TotalClaims> {
  return get<TotalClaims>(
    `/wallets/${encodeURIComponent(wallet)}/pools/${encodeURIComponent(poolAddress)}/total_claims`,
  );
}
