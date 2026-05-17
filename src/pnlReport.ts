/**
 * PnL report builder + renderers.
 *
 * Pulls Meteora's pre-computed PnL numbers (deposits, withdrawals, fees,
 * unrealized) and stitches them into one `PnlReport` consumed by:
 *   - `GET /api/pnl` (web/src/pages/Pnl.tsx)
 *   - Telegram `/pnl`
 *   - CLI `npm run pnl`
 *
 * No on-chain math here — Meteora's indexer is authoritative. We just
 * aggregate the active pool's slice of the wallet's portfolio.
 *
 * 60s in-memory cache keyed by (wallet+pool) to be polite to Meteora's API
 * and bound dashboard polling cost.
 */

import { loadConfig } from "./config";
import { loadWallet } from "./wallet";
import { logger } from "./logger";
import { resolveActivePool } from "./poolMode";
import {
  getPoolPositionPnL,
  getPortfolio,
  getTotalClaims,
  type PositionPnLData,
  type PoolPortfolioItem,
} from "./data/meteora_pnl";

export interface PnlReportTotal {
  pnlUsd: number;
  pnlSol: number;
  pnlPctChange: number;
  pnlSolPctChange: number;
  feesUsd: number;
  feeClaimCount: number;
  depositsUsd: number;
  withdrawalsUsd: number;
  currentBalancesUsd: number;
  unclaimedFeesUsd: number;
  /** Last fee-claim timestamp (unix ms). null when nothing claimed yet. */
  lastFeeClaimAt: number | null;
}

export interface PnlReportPosition {
  positionAddress: string;
  isClosed: boolean;
  isOutOfRange: boolean | null;
  minPrice: number;
  maxPrice: number;
  lowerBinId: number;
  upperBinId: number;
  createdAt: number | null; // unix ms
  closedAt: number | null; // unix ms
  pnlUsd: number;
  pnlPctChange: number;
  pnlSol: number | null;
  pnlSolPctChange: number | null;
  feesUsd: number;
  depositsUsd: number;
  withdrawalsUsd: number;
  currentBalancesUsd: number | null;
  unclaimedFeesUsd: number | null;
}

export interface PnlReport {
  generatedAt: number; // unix ms
  cached: boolean;
  wallet: string;
  pool: {
    address: string;
    tokenX: string;
    tokenY: string;
    tokenXPrice: number;
    tokenYPrice: number;
  } | null;
  /**
   * Meteora hasn't yet seen any LP activity for this wallet on this pool.
   * Dashboard / CLI / Telegram should show a "no activity yet" state.
   */
  notIndexed: boolean;
  total: PnlReportTotal;
  positions: PnlReportPosition[];
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; report: PnlReport }>();

function num(s: string | null | undefined): number {
  if (s == null) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function secToMs(t: number | null | undefined): number | null {
  if (t == null) return null;
  // Some Meteora fields are unix seconds, some unix ms — distinguish by size.
  return t > 10 ** 12 ? t : t * 1000;
}

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function mapPosition(p: PositionPnLData): PnlReportPosition {
  return {
    positionAddress: p.positionAddress,
    isClosed: p.isClosed,
    isOutOfRange: p.isOutOfRange ?? null,
    minPrice: num(p.minPrice),
    maxPrice: num(p.maxPrice),
    lowerBinId: p.lowerBinId,
    upperBinId: p.upperBinId,
    createdAt: secToMs(p.createdAt ?? null),
    closedAt: secToMs(p.closedAt ?? null),
    pnlUsd: num(p.pnlUsd),
    pnlPctChange: num(p.pnlPctChange),
    pnlSol: p.pnlSol ?? null,
    pnlSolPctChange: p.pnlSolPctChange ?? null,
    feesUsd: num(p.allTimeFees?.total?.usd),
    depositsUsd: num(p.allTimeDeposits?.total?.usd),
    withdrawalsUsd: num(p.allTimeWithdrawals?.total?.usd),
    currentBalancesUsd: p.unrealizedPnl ? p.unrealizedPnl.balances : null,
    unclaimedFeesUsd: p.unrealizedPnl
      ? num(p.unrealizedPnl.unclaimedFeeTokenX?.usd) +
        num(p.unrealizedPnl.unclaimedFeeTokenY?.usd)
      : null,
  };
}

export async function buildPnlReport(options: { force?: boolean } = {}): Promise<PnlReport> {
  const cfg = loadConfig();
  void cfg;
  const wallet = loadWallet().publicKey.toBase58();
  const pool = resolveActivePool();

  const key = `${wallet}::${pool ?? "none"}`;
  if (!options.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.report, cached: true };
    }
  }

  if (!pool) {
    const empty: PnlReport = {
      generatedAt: Date.now(),
      cached: false,
      wallet,
      pool: null,
      notIndexed: true,
      total: zeroTotal(),
      positions: [],
    };
    cache.set(key, { at: Date.now(), report: empty });
    return empty;
  }

  // Fire all three Meteora calls in parallel — throttle inside the module
  // serializes them, so this is just a latency win on the cached path miss.
  let positionsResp;
  let portfolio;
  let claims;
  try {
    [positionsResp, portfolio, claims] = await Promise.all([
      getPoolPositionPnL(pool, wallet, { pageSize: 100 }),
      getPortfolio(wallet, { pageSize: 20 }),
      getTotalClaims(wallet, pool).catch((err) => {
        // 400 here just means the wallet has never claimed on this pool.
        logger.debug({ err: err instanceof Error ? err.message : err }, "total_claims empty");
        return null;
      }),
    ]);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "buildPnlReport: Meteora fetch failed");
    throw err;
  }

  const poolItem: PoolPortfolioItem | undefined = portfolio.pools.find(
    (p) => p.poolAddress.toLowerCase() === pool.toLowerCase(),
  );

  const positions = (positionsResp.positions ?? []).map(mapPosition);

  // Open-position balances + unclaimed fees.
  let currentBalancesUsd = 0;
  let unclaimedFeesUsd = 0;
  for (const p of positions) {
    if (p.currentBalancesUsd != null) currentBalancesUsd += p.currentBalancesUsd;
    if (p.unclaimedFeesUsd != null) unclaimedFeesUsd += p.unclaimedFeesUsd;
  }

  // Prefer portfolio.pool-level aggregate when present (covers historical
  // events even after positions are closed). Fall back to per-position sums.
  const totalPnlUsd = poolItem ? num(poolItem.pnlUsd) : positions.reduce((a, p) => a + p.pnlUsd, 0);
  const totalPnlSol = poolItem ? num(poolItem.pnlSol) : 0;
  const totalPnlPctChange = poolItem ? num(poolItem.pnlPctChange) : 0;
  const totalPnlSolPctChange = poolItem ? num(poolItem.pnlSolPctChange) : 0;
  const totalDeposits = poolItem
    ? num(poolItem.totalDeposit)
    : positions.reduce((a, p) => a + p.depositsUsd, 0);
  const totalWithdrawals = poolItem
    ? num(poolItem.totalWithdrawal)
    : positions.reduce((a, p) => a + p.withdrawalsUsd, 0);
  const feesUsd = poolItem
    ? num(poolItem.totalFee)
    : claims
    ? num(claims.total_fee_x_usd) + num(claims.total_fee_y_usd)
    : positions.reduce((a, p) => a + p.feesUsd, 0);

  const report: PnlReport = {
    generatedAt: Date.now(),
    cached: false,
    wallet,
    pool: {
      address: pool,
      tokenX: positionsResp.tokenX ?? poolItem?.tokenX ?? "X",
      tokenY: positionsResp.tokenY ?? poolItem?.tokenY ?? "Y",
      tokenXPrice: num(positionsResp.tokenXPrice),
      tokenYPrice: num(positionsResp.tokenYPrice),
    },
    notIndexed: !poolItem && positions.length === 0,
    total: {
      pnlUsd: totalPnlUsd,
      pnlSol: totalPnlSol,
      pnlPctChange: totalPnlPctChange,
      pnlSolPctChange: totalPnlSolPctChange,
      feesUsd,
      feeClaimCount: claims?.fee_claim_count ?? 0,
      depositsUsd: totalDeposits,
      withdrawalsUsd: totalWithdrawals,
      currentBalancesUsd,
      unclaimedFeesUsd,
      lastFeeClaimAt: claims ? isoToMs(claims.last_fee_claim_time ?? null) : null,
    },
    positions,
  };

  cache.set(key, { at: Date.now(), report });
  return report;
}

function zeroTotal(): PnlReportTotal {
  return {
    pnlUsd: 0,
    pnlSol: 0,
    pnlPctChange: 0,
    pnlSolPctChange: 0,
    feesUsd: 0,
    feeClaimCount: 0,
    depositsUsd: 0,
    withdrawalsUsd: 0,
    currentBalancesUsd: 0,
    unclaimedFeesUsd: 0,
    lastFeeClaimAt: null,
  };
}

// ─── Renderers (Telegram + CLI) ──────────────────────────────────────────────

const trunc = (s: string, head = 6, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 0.01 && abs > 0) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtDateAge(ms: number | null): string {
  if (ms == null) return "—";
  const days = (Date.now() - ms) / (24 * 3_600_000);
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  return `${Math.floor(days)}d ago`;
}

export function formatPnlText(r: PnlReport): string {
  const xSym = r.pool?.tokenX ?? "X";
  const ySym = r.pool?.tokenY ?? "Y";
  const pair = `${xSym}/${ySym}`;
  const lines: string[] = [];
  lines.push(`💰 PnL — ${pair}`);
  lines.push("");
  lines.push(`Wallet     ${trunc(r.wallet, 8, 4)}`);
  if (r.pool) {
    lines.push(`Pool       ${trunc(r.pool.address, 8, 4)}`);
    lines.push(
      `Prices     ${xSym} $${r.pool.tokenXPrice.toFixed(2)}  ·  ${ySym} $${r.pool.tokenYPrice.toFixed(4)}`,
    );
  }
  if (r.notIndexed) {
    lines.push("");
    lines.push("No LP activity on this pool yet (or wallet not yet indexed by Meteora).");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`────── totals ──────`);
  lines.push(`PnL vs USDC hold  ${fmtUsd(r.total.pnlUsd)}  (${fmtPct(r.total.pnlPctChange)})`);
  if (r.total.pnlSol !== 0 || r.total.pnlSolPctChange !== 0) {
    lines.push(`PnL vs SOL hold   ${r.total.pnlSol.toFixed(4)} SOL  (${fmtPct(r.total.pnlSolPctChange)})`);
  }
  lines.push(`Fees collected    ${fmtUsd(r.total.feesUsd)}  (${r.total.feeClaimCount} claims, last ${fmtDateAge(r.total.lastFeeClaimAt)})`);
  lines.push(`Deposits          ${fmtUsd(r.total.depositsUsd)}`);
  lines.push(`Withdrawals       ${fmtUsd(r.total.withdrawalsUsd)}`);
  lines.push(`Current value     ${fmtUsd(r.total.currentBalancesUsd)}`);
  lines.push(`Unclaimed fees    ${fmtUsd(r.total.unclaimedFeesUsd)}`);

  if (r.positions.length > 0) {
    let inRange = 0;
    let outOfRange = 0;
    let closed = 0;
    for (const p of r.positions) {
      if (p.isClosed) closed++;
      else if (p.isOutOfRange === true) outOfRange++;
      else inRange++;
    }
    lines.push("");
    lines.push(
      `────── positions (${r.positions.length}) — ${inRange} in-range · ${outOfRange} out · ${closed} closed ──────`,
    );
    for (const p of r.positions) {
      const status = p.isClosed
        ? "closed"
        : p.isOutOfRange === true
        ? "out-of-range"
        : "in-range";
      lines.push("");
      lines.push(
        `${trunc(p.positionAddress, 6, 4)}  ${status}  ` +
          `range $${p.minPrice.toFixed(2)}–$${p.maxPrice.toFixed(2)}`,
      );
      const solPart =
        p.pnlSol != null && p.pnlSolPctChange != null
          ? `  ·  vs SOL ${p.pnlSol.toFixed(4)} SOL (${fmtPct(p.pnlSolPctChange)})`
          : "";
      lines.push(
        `  vs USDC ${fmtUsd(p.pnlUsd)} (${fmtPct(p.pnlPctChange)})${solPart}  ·  ` +
          `fees ${fmtUsd(p.feesUsd)}`,
      );
      lines.push(
        `  deposits ${fmtUsd(p.depositsUsd)}  withdrawals ${fmtUsd(p.withdrawalsUsd)}` +
          (p.currentBalancesUsd != null ? `  current ${fmtUsd(p.currentBalancesUsd)}` : ""),
      );
      lines.push(
        `  opened ${fmtDateAge(p.createdAt)}` +
          (p.closedAt != null ? `  closed ${fmtDateAge(p.closedAt)}` : ""),
      );
    }
  }

  return lines.join("\n");
}

export function formatPnlHtml(r: PnlReport): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre>${esc(formatPnlText(r))}</pre>`;
}
