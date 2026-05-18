/**
 * Shared status-report builder. Used by both the CLI (`src/cli/status.ts`)
 * and the Telegram bot's /status handler so they always agree.
 */

import { loadConfig } from "./config";
import { loadWallet } from "./wallet";
import { getActiveBinSummary } from "./dlmm/client";
import {
  getPortfolioSnapshot,
  type PortfolioSnapshot,
  type PositionSummary,
} from "./dlmm/positions";

export interface StatusReport {
  snapshot: PortfolioSnapshot;
  activeBin: { binId: number; pricePerToken: string; binStep: number };
  mode: "dryrun" | "live";
  wallet: string;
}

export async function buildStatusReport(): Promise<StatusReport> {
  const cfg = loadConfig();
  const wallet = loadWallet();
  const [activeBin, snapshot] = await Promise.all([
    getActiveBinSummary(),
    getPortfolioSnapshot(),
  ]);
  return {
    snapshot,
    activeBin: {
      binId: activeBin.binId,
      pricePerToken: activeBin.pricePerToken,
      binStep: activeBin.binStep,
    },
    mode: cfg.MODE,
    wallet: wallet.publicKey.toBase58(),
  };
}

// ─── formatting helpers ───────────────────────────────────────────────────────

const trunc = (s: string, head = 6, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

/**
 * Format a token amount with sensible precision:
 *   - ≥ 1     → 4 sig figs after the decimal, trimmed
 *   - < 1     → up to 6 sig figs, trimmed
 *   - 0       → "0"
 */
function fmtTok(n: number): string {
  if (n === 0) return "0";
  const s = n >= 1 ? n.toFixed(4) : n.toFixed(6);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Format USD with 2 decimals; for amounts < $0.01 use 4. */
function fmtUsd(n: number): string {
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * The SDK returns prices with ~20 digits of precision. Trim to a number of
 * decimals that's appropriate for the magnitude (4 decimals for prices ≥ 1,
 * 6 for stablecoin-pair prices like USDC/USDT).
 */
function fmtPrice(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

/** Pad a label to a fixed width so values line up. */
function row(label: string, value: string, labelWidth = 11): string {
  return `${label.padEnd(labelWidth)}${value}`;
}

// ─── USD value + composition ──────────────────────────────────────────────────

/** Returns "30% SOL / 70% USDC" based on LP liquidity (excl. fees). Null if no stablecoin side. */
function positionComposition(
  pos: PositionSummary,
  snap: PortfolioSnapshot,
): string | null {
  const price = parseFloat(snap.activeBinPrice);
  if (!Number.isFinite(price) || price === 0) return null;

  let xUsd: number, yUsd: number;
  if (snap.tokenY.isStablecoin) {
    xUsd = pos.totalX * price;
    yUsd = pos.totalY;
  } else if (snap.tokenX.isStablecoin) {
    xUsd = pos.totalX;
    yUsd = pos.totalY / price;
  } else {
    return null;
  }

  const total = xUsd + yUsd;
  if (total === 0) return null;

  const xPct = Math.round((xUsd / total) * 100);
  const yPct = 100 - xPct;
  return `${xPct}% ${snap.tokenX.symbol} / ${yPct}% ${snap.tokenY.symbol}`;
}

/**
 * Position value in USD, but only when token Y is a USD-pegged stablecoin
 * (which is the case for SOL/USDC). Returns null if we can't compute it
 * without a price oracle (e.g. SOL/JUP pool).
 */
function valueUsd(
  pos: PositionSummary,
  snap: PortfolioSnapshot,
): number | null {
  const price = parseFloat(snap.activeBinPrice);
  if (!Number.isFinite(price)) return null;

  if (snap.tokenY.isStablecoin) {
    // price = Y per X (USDC per SOL for SOL/USDC)
    return (pos.totalX + pos.feeX) * price + (pos.totalY + pos.feeY);
  }
  if (snap.tokenX.isStablecoin) {
    // price = Y per X, so 1/price = X per Y
    return (pos.totalX + pos.feeX) + (pos.totalY + pos.feeY) / price;
  }
  return null;
}

// ─── plain-text renderer ──────────────────────────────────────────────────────

export function renderStatusText(r: StatusReport): string {
  const { snapshot: s, activeBin } = r;
  const xSym = s.tokenX.symbol;
  const ySym = s.tokenY.symbol;
  const pair = `${xSym}/${ySym}`;

  const lines: string[] = [];
  lines.push(`📊 LP Status — ${pair}  (${r.mode})`);
  lines.push(``);

  // Header block
  lines.push(row("Pool", `${trunc(s.pool, 8, 4)}  ·  bin step ${s.binStep}`));
  lines.push(
    row(
      "Price",
      `${fmtPrice(activeBin.pricePerToken)} ${ySym} per ${xSym}  ·  active bin ${activeBin.binId}`,
    ),
  );
  lines.push(row("Wallet", trunc(r.wallet, 8, 4)));

  if (s.positions.length === 0) {
    lines.push(``);
    lines.push(`No positions on this pool.`);
    return lines.join("\n");
  }

  // Per-position blocks
  let totalValueUsd = 0;
  let valueKnown = true;

  s.positions.forEach((p, i) => {
    const flag = p.inRange ? "✅ in range" : "⚠️ out of range";
    const v = valueUsd(p, s);
    if (v === null) valueKnown = false;
    else totalValueUsd += v;

    lines.push(``);
    lines.push(
      `Position ${i + 1}/${s.positions.length}  ${flag}  ·  bins ${p.lowerBinId}..${p.upperBinId} (width ${p.width})`,
    );
    lines.push(row("  Address", trunc(p.publicKey, 8, 4), 13));
    lines.push(
      row(
        "  Liquidity",
        `${fmtTok(p.totalX)} ${xSym}  +  ${fmtTok(p.totalY)} ${ySym}`,
        13,
      ),
    );
    const comp = positionComposition(p, s);
    if (comp) lines.push(row("  Composition", comp, 13));
    const feeXPct = p.totalX > 0 ? (p.feeX / p.totalX) * 100 : null;
    const feeYPct = p.totalY > 0 ? (p.feeY / p.totalY) * 100 : null;
    const feeXPctStr = feeXPct !== null ? ` (${feeXPct.toFixed(2)}%)` : "";
    const feeYPctStr = feeYPct !== null ? ` (${feeYPct.toFixed(2)}%)` : "";
    lines.push(
      row(
        "  Fees",
        `${fmtTok(p.feeX)} ${xSym}${feeXPctStr}  +  ${fmtTok(p.feeY)} ${ySym}${feeYPctStr}`,
        13,
      ),
    );
    if (v !== null) {
      lines.push(row("  Value", `≈ ${fmtUsd(v)}`, 13));
    }
  });

  // Totals footer (only if multiple positions or we know the USD value)
  if (s.positions.length > 1 || valueKnown) {
    lines.push(``);
    lines.push(`────────────────────────────`);

    const labelW = 14; // wide enough for "Total value " + gap

    if (s.positions.length > 1) {
      const aggX = s.positions.reduce((a, p) => a + p.totalX + p.feeX, 0);
      const aggY = s.positions.reduce((a, p) => a + p.totalY + p.feeY, 0);
      lines.push(
        row(
          "Aggregate",
          `${fmtTok(aggX)} ${xSym}  +  ${fmtTok(aggY)} ${ySym}`,
          labelW,
        ),
      );
    }
    if (valueKnown) {
      lines.push(row("Total value", `≈ ${fmtUsd(totalValueUsd)}`, labelW));
    }
  }

  return lines.join("\n");
}

/** Telegram HTML rendering — wraps the plain text in <pre> for monospace alignment. */
export function renderStatusHtml(r: StatusReport): string {
  const esc = (str: string) =>
    str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre>${esc(renderStatusText(r))}</pre>`;
}
