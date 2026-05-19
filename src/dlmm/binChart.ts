import type { PortfolioSnapshot, PositionSummary } from "./positions";

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const DEFAULT_MAX_COLS = 60;

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function binUsd(
  b: { x: number; y: number },
  price: number,
  snap: PortfolioSnapshot,
): number {
  if (snap.tokenY.isStablecoin) return b.x * price + b.y;
  if (snap.tokenX.isStablecoin) return b.x + b.y / price;
  return b.x + b.y;
}

function binPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

export function renderBinChart(
  pos: PositionSummary,
  snap: PortfolioSnapshot,
  opts?: { maxCols?: number },
): string {
  if (pos.bins.length === 0) return "";

  const maxCols = opts?.maxCols ?? DEFAULT_MAX_COLS;
  const price = parseFloat(snap.activeBinPrice);

  const usds = pos.bins.map((b) => binUsd(b, price, snap));

  const width = pos.width;
  const bucketSize = Math.max(1, Math.ceil(width / maxCols));
  const cols = Math.ceil(width / bucketSize);

  const buckets = new Array<number>(cols).fill(0);
  for (let i = 0; i < pos.bins.length; i++) {
    const b = pos.bins[i]!;
    const idx = Math.floor((b.binId - pos.lowerBinId) / bucketSize);
    if (idx >= 0 && idx < cols) buckets[idx]! += usds[i]!;
  }

  const max = Math.max(...buckets);

  // Price labels — use bin-step math so it works for any pool, not just SOL/USDC.
  // Note: this gives the raw bin price; for inverse pools (USDC/SOL) the active
  // price string is already in display units, so we approximate via ratio.
  const activeBinId = snap.activeBinId;
  let loPrice: number, hiPrice: number;
  if (Number.isFinite(price) && price > 0) {
    const activeBinRawPrice = binPrice(activeBinId, snap.binStep);
    const scale = price / activeBinRawPrice;
    loPrice = binPrice(pos.lowerBinId, snap.binStep) * scale;
    hiPrice = binPrice(pos.upperBinId, snap.binStep) * scale;
  } else {
    loPrice = NaN;
    hiPrice = NaN;
  }

  const bar = buckets
    .map((v) => {
      if (max === 0) return " ";
      if (v === 0) return " ";
      const step = Math.min(7, Math.max(0, Math.round((v / max) * 7)));
      return BLOCKS[step];
    })
    .join("");

  const loLabel = `lo ${fmtPrice(loPrice)}`;
  const hiLabel = `hi ${fmtPrice(hiPrice)}`;
  const barLine = `${loLabel} │${bar}│ ${hiLabel}`;

  // Active-bin marker line — aligned to the bar's interior columns.
  const padBeforeBar = loLabel.length + 2; // "lo X.XX │"
  const activeCol = Math.floor((activeBinId - pos.lowerBinId) / bucketSize);

  let markerLine: string;
  if (activeCol >= 0 && activeCol < cols) {
    const marker = " ".repeat(padBeforeBar + activeCol) + `▲ ${fmtPrice(price)} (active)`;
    markerLine = marker;
  } else {
    const side = activeBinId < pos.lowerBinId ? "below" : "above";
    markerLine = `${" ".repeat(padBeforeBar)}active bin ${activeBinId} (${fmtPrice(price)}) is ${side} range`;
  }

  if (max === 0) {
    return [barLine, `${" ".repeat(padBeforeBar)}(no liquidity)`].join("\n");
  }

  return [barLine, markerLine].join("\n");
}
