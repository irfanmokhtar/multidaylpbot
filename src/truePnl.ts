/**
 * True P&L — cost-basis-anchored performance view.
 *
 * Reframes LP performance against the VERY FIRST deposit as a fixed baseline
 * (never reset on rebalance), rolling in withdrawn + unclaimed fees, and
 * comparing against a simple hold of the original SOL + USDC.
 *
 * The baseline (first deposit amounts + entry price) is derived once from
 * Meteora's historical event stream and PINNED in SQLite (`cost_basis` table)
 * so it survives Meteora aging out old closed positions. Everything else is
 * computed live by the callers (`src/report.ts`, `src/pnlReport.ts`) and fed
 * into `computeTruePnl`.
 *
 * Only meaningful for stablecoin pairs (SOL/USDC) — callers guard on that.
 */

import { logger } from "./logger";
import { loadWallet } from "./wallet";
import { costBasisRepo, type CostBasisRow } from "./state/repos";
import {
  getPoolPositionPnL,
  getPositionHistorical,
  getPortfolio,
} from "./data/meteora_pnl";
import { getPortfolioSnapshot } from "./dlmm/positions";
import { getActiveBinSummary } from "./dlmm/client";

export interface CostBasisBaseline {
  initialCapitalUsd: number;
  /** Non-stable (SOL) side amount at first deposit. */
  initialNonStableAmount: number;
  /** Stable (USDC) side amount at first deposit. */
  initialStableAmount: number;
  solPriceAtEntry: number;
  openedAt: number | null;
  rebalanceCount: number;
  /** Meteora cumulative totalFee snapshotted at last reset (0 if never reset). */
  feesWithdrawnOffsetUsd: number;
}

export interface TruePnlInputs {
  baseline: CostBasisBaseline;
  /** Current USD value of principal still in-pool (excludes unclaimed fees). */
  currentPrincipalUsd: number;
  /** USD value of fees earned but not yet withdrawn. */
  currentUnclaimedFeesUsd: number;
  /** Cumulative USD of all fees already withdrawn (Meteora pool totalFee). */
  totalFeesWithdrawnUsd: number;
  /** Live non-stable (SOL) price in USD. */
  currentSolPrice: number;
}

export interface TruePnlResult {
  initialCapitalUsd: number;
  currentPrincipalUsd: number;
  currentUnclaimedFeesUsd: number;
  totalFeesWithdrawnUsd: number;
  truePnlUsd: number;
  holdValueUsd: number;
  lpAlphaUsd: number;
  principalHealthPct: number;
  totalFeesUsd: number;
  netFeeYieldPct: number;
  rebalanceCount: number;
}

export function computeTruePnl(i: TruePnlInputs): TruePnlResult {
  const { baseline } = i;
  const initialCapitalUsd = baseline.initialCapitalUsd;

  // Withdrawn fees count only from the last reset point. Meteora's totalFee is
  // all-time; subtract the offset captured at reset (0 when never reset).
  const totalFeesWithdrawnUsd = Math.max(
    0,
    i.totalFeesWithdrawnUsd - baseline.feesWithdrawnOffsetUsd,
  );

  const truePnlUsd =
    i.currentPrincipalUsd +
    totalFeesWithdrawnUsd +
    i.currentUnclaimedFeesUsd -
    initialCapitalUsd;

  const holdValueUsd =
    baseline.initialNonStableAmount * i.currentSolPrice +
    baseline.initialStableAmount;

  const lpAlphaUsd = truePnlUsd - (holdValueUsd - initialCapitalUsd);

  const principalHealthPct =
    initialCapitalUsd > 0
      ? (i.currentPrincipalUsd / initialCapitalUsd) * 100
      : 0;

  const totalFeesUsd = totalFeesWithdrawnUsd + i.currentUnclaimedFeesUsd;
  const netFeeYieldPct =
    initialCapitalUsd > 0 ? (totalFeesUsd / initialCapitalUsd) * 100 : 0;

  return {
    initialCapitalUsd,
    currentPrincipalUsd: i.currentPrincipalUsd,
    currentUnclaimedFeesUsd: i.currentUnclaimedFeesUsd,
    totalFeesWithdrawnUsd,
    truePnlUsd,
    holdValueUsd,
    lpAlphaUsd,
    principalHealthPct,
    totalFeesUsd,
    netFeeYieldPct,
    rebalanceCount: baseline.rebalanceCount,
  };
}

// ─── baseline (DB-pinned, lazily seeded from Meteora) ─────────────────────────

const DEPOSIT_EVENT_RX = /deposit|add|open|increase/i;

function rowToBaseline(row: CostBasisRow): CostBasisBaseline | null {
  if (
    row.initialCapitalUsd == null ||
    row.initialXAmount == null ||
    row.initialYAmount == null ||
    row.solPriceAtEntry == null ||
    row.baselinePinnedAt == null
  ) {
    return null; // counter-only row, baseline not yet pinned
  }
  return {
    initialCapitalUsd: row.initialCapitalUsd,
    // Seed convention: initial_x_amount = pool tokenX = SOL (non-stable),
    // initial_y_amount = USDC (stable). This bot manages SOL/USDC with SOL as X.
    initialNonStableAmount: row.initialXAmount,
    initialStableAmount: row.initialYAmount,
    solPriceAtEntry: row.solPriceAtEntry,
    openedAt: row.openedAt,
    rebalanceCount: row.rebalanceCount,
    feesWithdrawnOffsetUsd: row.feesWithdrawnOffset ?? 0,
  };
}

/**
 * Returns the pinned baseline, seeding it from Meteora's first-deposit event on
 * first call. Best-effort: returns null (caller omits the section) if Meteora
 * has no indexed activity yet or the fetch fails.
 */
export async function getCostBasisBaseline(
  pool: string,
): Promise<CostBasisBaseline | null> {
  const existing = costBasisRepo.get(pool);
  if (existing) {
    const b = rowToBaseline(existing);
    if (b) return b;
  }

  try {
    const wallet = loadWallet().publicKey.toBase58();
    const resp = await getPoolPositionPnL(pool, wallet, { pageSize: 100 });
    const positions = resp.positions ?? [];
    if (positions.length === 0) return null;

    // Oldest position by createdAt holds the very first deposit.
    const oldest = positions
      .filter((p) => p.createdAt != null)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
    if (!oldest) return null;

    const events = await getPositionHistorical(oldest.positionAddress, {
      orderDirection: "asc",
    });
    if (events.length === 0) return null;

    // First deposit-like event (earliest is the open). Fall back to the first
    // event carrying positive amounts.
    const deposit =
      events.find(
        (e) =>
          DEPOSIT_EVENT_RX.test(e.eventType) &&
          (parseFloat(e.amountX) > 0 || parseFloat(e.amountY) > 0),
      ) ??
      events.find(
        (e) => parseFloat(e.amountX) > 0 || parseFloat(e.amountY) > 0,
      );
    if (!deposit) return null;

    const amountX = parseFloat(deposit.amountX);
    const amountY = parseFloat(deposit.amountY);
    const amountXUsd = parseFloat(deposit.amountXUsd);
    const amountYUsd = parseFloat(deposit.amountYUsd);
    const totalUsd = parseFloat(deposit.totalUsd);
    const initialCapitalUsd = Number.isFinite(totalUsd) && totalUsd > 0
      ? totalUsd
      : amountXUsd + amountYUsd;
    const solPriceAtEntry = amountX > 0 ? amountXUsd / amountX : 0;
    const openedAt = secToMs(deposit.blockTime);

    const closedCount = positions.filter((p) => p.isClosed).length;

    costBasisRepo.pinBaseline({
      pool,
      initialCapitalUsd,
      initialXAmount: amountX,
      initialYAmount: amountY,
      solPriceAtEntry,
      openedAt,
      seedRebalanceCount: closedCount,
    });

    const pinned = costBasisRepo.get(pool);
    return pinned ? rowToBaseline(pinned) : null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err, pool },
      "true-pnl: baseline seed failed (Meteora not ready?)",
    );
    return null;
  }
}

function secToMs(t: number | null | undefined): number | null {
  if (t == null) return null;
  return t > 10 ** 12 ? t : t * 1000;
}

// ─── baseline reset (re-anchor to current position) ───────────────────────────

export interface ResetSummary {
  pool: string;
  initialCapitalUsd: number;
  solAmount: number;
  usdcAmount: number;
  solPrice: number;
  feesWithdrawnOffsetUsd: number;
  /** Baseline that was in place before the reset (null if none pinned). */
  previous: CostBasisBaseline | null;
}

function getExistingBaseline(pool: string): CostBasisBaseline | null {
  const row = costBasisRepo.get(pool);
  return row ? rowToBaseline(row) : null;
}

async function fetchCumulativeFeeUsd(pool: string): Promise<number> {
  try {
    const wallet = loadWallet().publicKey.toBase58();
    const portfolio = await getPortfolio(wallet, { pageSize: 20 });
    const item = portfolio.pools.find(
      (p) => p.poolAddress.toLowerCase() === pool.toLowerCase(),
    );
    return item ? parseFloat(item.totalFee) || 0 : 0;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      "reset: cumulative fee fetch failed — offset 0",
    );
    return 0;
  }
}

/** Read current on-chain principal + live price + Meteora cumulative fees. */
async function gatherCurrentBasis(): Promise<Omit<ResetSummary, "previous">> {
  const snapshot = await getPortfolioSnapshot();
  if (!snapshot.tokenY.isStablecoin || snapshot.tokenX.isStablecoin) {
    throw new Error(
      "reset baseline only supported for SOL/USDC pools (stablecoin Y)",
    );
  }
  if (snapshot.positions.length === 0) {
    throw new Error("no open position — nothing to anchor the baseline to");
  }
  const active = await getActiveBinSummary();
  const solPrice = parseFloat(active.pricePerToken);
  if (!Number.isFinite(solPrice) || solPrice <= 0) {
    throw new Error("could not read a valid active-bin price");
  }
  const solAmount = snapshot.positions.reduce((a, p) => a + p.totalX, 0);
  const usdcAmount = snapshot.positions.reduce((a, p) => a + p.totalY, 0);
  const initialCapitalUsd = solAmount * solPrice + usdcAmount;
  const feesWithdrawnOffsetUsd = await fetchCumulativeFeeUsd(snapshot.pool);
  return {
    pool: snapshot.pool,
    initialCapitalUsd,
    solAmount,
    usdcAmount,
    solPrice,
    feesWithdrawnOffsetUsd,
  };
}

/** Read-only preview of what a reset would set, plus the current baseline. */
export async function previewReset(): Promise<ResetSummary> {
  const g = await gatherCurrentBasis();
  return { ...g, previous: getExistingBaseline(g.pool) };
}

/** Re-anchor the baseline to the current position. Overwrites the pinned row. */
export async function resetBaselineToCurrent(): Promise<ResetSummary> {
  const g = await gatherCurrentBasis();
  const previous = getExistingBaseline(g.pool);
  costBasisRepo.resetBaseline({
    pool: g.pool,
    initialCapitalUsd: g.initialCapitalUsd,
    initialXAmount: g.solAmount,
    initialYAmount: g.usdcAmount,
    solPriceAtEntry: g.solPrice,
    feesWithdrawnOffset: g.feesWithdrawnOffsetUsd,
  });
  logger.info(
    {
      pool: g.pool,
      initialCapitalUsd: g.initialCapitalUsd,
      feesWithdrawnOffsetUsd: g.feesWithdrawnOffsetUsd,
    },
    "true-pnl: baseline reset to current position",
  );
  return { ...g, previous };
}

// ─── shared renderer ──────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function healthBadge(pct: number): string {
  if (pct >= 98) return "🟢";
  if (pct >= 95) return "🟡";
  return "🔴";
}

/** The "💰 True P&L" block. Shared by /status and /pnl renderers. */
export function formatTruePnlLines(r: TruePnlResult): string[] {
  const lines: string[] = [];
  lines.push(`────── True P&L ──────`);

  const pnlBadge = r.truePnlUsd >= 0 ? "🟢" : "🔴";
  lines.push(`True P&L          ${pnlBadge} ${fmtUsd(r.truePnlUsd)}`);

  const alphaLabel =
    r.lpAlphaUsd >= 0 ? "Outperforming Hold" : "Underperforming Hold";
  const alphaBadge = r.lpAlphaUsd >= 0 ? "🟢" : "🔴";
  lines.push(
    `LP Alpha vs Hold  ${alphaBadge} ${fmtUsd(r.lpAlphaUsd)}  (${alphaLabel})`,
  );

  lines.push(
    `Principal Health  ${healthBadge(r.principalHealthPct)} ${fmtPct(r.principalHealthPct)}`,
  );
  lines.push(`Total Fees        ${fmtUsd(r.totalFeesUsd)}`);
  lines.push(`Net Fee Yield     ${fmtPct(r.netFeeYieldPct)}`);

  lines.push(``);
  lines.push(`Initial capital   ${fmtUsd(r.initialCapitalUsd)}`);
  lines.push(`Current principal ${fmtUsd(r.currentPrincipalUsd)}`);
  lines.push(
    `Fees withdrawn    ${fmtUsd(r.totalFeesWithdrawnUsd)}  ·  unclaimed ${fmtUsd(r.currentUnclaimedFeesUsd)}`,
  );
  lines.push(`Hold value        ${fmtUsd(r.holdValueUsd)}`);
  lines.push(`Rebalances        ${r.rebalanceCount}`);

  return lines;
}

/** Render a baseline-reset summary (preview or applied). */
export function formatResetSummary(s: ResetSummary, applied: boolean): string[] {
  const lines: string[] = [];
  lines.push(applied ? `✅ Baseline reset` : `↻ Baseline reset preview`);
  lines.push(``);
  if (s.previous) {
    lines.push(`Old initial cap   ${fmtUsd(s.previous.initialCapitalUsd)}`);
  } else {
    lines.push(`Old initial cap   (none pinned)`);
  }
  lines.push(`New initial cap   ${fmtUsd(s.initialCapitalUsd)}`);
  lines.push(
    `  = ${s.solAmount.toFixed(4)} SOL @ $${s.solPrice.toFixed(2)} + ${s.usdcAmount.toFixed(2)} USDC`,
  );
  lines.push(`Fees offset       ${fmtUsd(s.feesWithdrawnOffsetUsd)}  (fees now count from here)`);
  lines.push(`Rebalances        reset to 0`);
  return lines;
}
