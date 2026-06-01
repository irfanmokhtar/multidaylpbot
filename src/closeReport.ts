/**
 * Shared report builder for the `close` command (Telegram /close + CLI
 * `npm run close`). Output is identical across both surfaces.
 *
 *  - buildCloseSnapshotText()  — read-only pre-close view: on-chain position
 *    state (+ local True P&L) and the Meteora-indexed PnL. Used by the Telegram
 *    confirm prompt and the CLI dry preview.
 *  - executeCloseAndReport()   — captures the pre-close snapshot (the on-chain
 *    position vanishes after close and the Meteora indexer lags a fresh
 *    withdrawal), runs executeClose(), and composes the final report:
 *    claimed fees + amounts returned + tx signatures + SOL cost + the pre-close
 *    PnL/True-PnL block + a /resetbaseline hint.
 */

import { executeClose, type CloseExecution } from "./dlmm/rebalance";
import { buildStatusReport, renderStatusText, type StatusReport } from "./report";
import { buildPnlReport, formatPnlText, type PnlReport } from "./pnlReport";

function fmt(n: number, dp = 4): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: dp });
}

/** Build the read-only pre-close snapshot: position state + Meteora PnL. */
export async function buildCloseSnapshotText(): Promise<string> {
  const [status, pnl] = await Promise.all([
    buildStatusReport(),
    buildPnlReport({ force: true }).catch(() => null),
  ]);
  return composeSnapshot(status, pnl);
}

function composeSnapshot(status: StatusReport, pnl: PnlReport | null): string {
  const parts = [renderStatusText(status)];
  if (pnl) parts.push(formatPnlText(pnl));
  return parts.join("\n\n");
}

/** Confirmation preview shown before the user commits to closing. */
export async function buildClosePreviewText(): Promise<string> {
  const snapshot = await buildCloseSnapshotText();
  return `⚠️ CLOSE PREVIEW — this fully exits the position.\n\n${snapshot}`;
}

function formatCloseResult(r: CloseExecution, xSym: string, ySym: string): string {
  const lines: string[] = ["✅ Position closed"];
  lines.push(`• Returned to wallet: ${fmt(r.preX + r.feeX)} ${xSym} + ${fmt(r.preY + r.feeY, 2)} ${ySym}`);
  lines.push(`• Fees claimed: ${fmt(r.feeX)} ${xSym} + ${fmt(r.feeY, 2)} ${ySym}`);
  if (r.preValueUsd != null) lines.push(`• Exit value: $${fmt(r.preValueUsd, 2)}`);
  lines.push(
    `• Closed range (bins): ${r.closedWindow.lower}–${r.closedWindow.upper} (w${r.closedWindow.width})`,
  );
  lines.push(`• SOL cost: ${(r.solFeesLamports / 1e9).toFixed(6)} SOL (${r.signatures.length} tx)`);
  for (const sig of r.signatures) lines.push(`  ↳ ${sig}`);
  return lines.join("\n");
}

/**
 * Execute the close and return the full report text. Captures the pre-close
 * PnL snapshot BEFORE removing liquidity (the position is gone afterward and
 * the Meteora indexer lags), then appends the on-chain close result.
 */
export async function executeCloseAndReport(): Promise<string> {
  // Snapshot first — once closed there's no on-chain position to read and the
  // Meteora row for the fresh withdrawal hasn't been indexed yet.
  const status = await buildStatusReport();
  const pnl = await buildPnlReport({ force: true }).catch(() => null);
  const xSym = status.snapshot.tokenX.symbol;
  const ySym = status.snapshot.tokenY.symbol;
  const snapshot = composeSnapshot(status, pnl);

  const result = await executeClose();

  return [
    formatCloseResult(result, xSym, ySym),
    "",
    "— PnL at close —",
    snapshot,
    "",
    "ℹ️ Position closed. Run /resetbaseline (or npm run reset-baseline) before reopening with new capital so True P&L re-anchors.",
  ].join("\n");
}
