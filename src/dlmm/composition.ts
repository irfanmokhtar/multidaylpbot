/**
 * Auto-derive target X:Y composition for a planned position.
 *
 * USD-weight basis: each bin in the planned range receives a strategy-specific
 * weight `w[i]` (normalized to sum 1). Bins above the active bin will be filled
 * with token X; bins at-or-below the active bin will be filled with token Y.
 * Summing the weights on each side directly yields the USD-share split — we
 * don't need per-bin price math because the strategy weight already represents
 * the planned USD allocation, not a token amount.
 *
 * Active bin OUTSIDE the range collapses to 100% one side (the SDK requires a
 * single-sided position).
 *
 * Strategy weights (when active is inside the range):
 *   Spot   — uniform across all bins.
 *   Curve  — triangular peak at the active bin (high near current price).
 *   BidAsk — inverse: zero at active bin, peaks at the range edges.
 */

import type { StrategyType } from "../ai/types";
import type { PriceBoundsWindow } from "./strategy";
import type { BN } from "@coral-xyz/anchor";

export interface CompositionTarget {
  xWeight: number; // 0..1, X-side share of total USD value
  yWeight: number; // 0..1, Y-side share
}

export function deriveTargetXWeight(args: {
  window: Pick<PriceBoundsWindow, "minBinId" | "maxBinId" | "width">;
  activeBinId: number;
  strategyType: StrategyType;
}): CompositionTarget {
  const { window, activeBinId, strategyType } = args;
  const { minBinId, maxBinId, width } = window;

  if (activeBinId < minBinId) return { xWeight: 1, yWeight: 0 };
  if (activeBinId > maxBinId) return { xWeight: 0, yWeight: 1 };

  // Compute raw per-bin weights.
  const raw: number[] = new Array(width);
  const halfWidth = Math.max(1, width / 2);
  for (let k = 0; k < width; k++) {
    const binId = minBinId + k;
    const dist = Math.abs(binId - activeBinId);
    switch (strategyType) {
      case "Spot":
        raw[k] = 1;
        break;
      case "Curve":
        raw[k] = Math.max(0, 1 - dist / halfWidth);
        break;
      case "BidAsk":
        raw[k] = dist / halfWidth;
        break;
    }
  }
  let sum = 0;
  for (const v of raw) sum += v;
  if (sum === 0) {
    // BidAsk with width 1 + active centered, or pathological config.
    // Fall back to uniform.
    for (let k = 0; k < width; k++) raw[k] = 1;
    sum = width;
  }

  let xWeight = 0;
  for (let k = 0; k < width; k++) {
    const binId = minBinId + k;
    if (binId > activeBinId) xWeight += raw[k]! / sum;
  }
  // Clamp to [0, 1] to absorb any FP drift.
  xWeight = Math.min(1, Math.max(0, xWeight));
  return { xWeight, yWeight: 1 - xWeight };
}

/**
 * USD-share of token X for a (balX, balY) wallet snapshot.
 * Y is treated as $1 when it's a stablecoin (or its price is unknown);
 * otherwise we use activeBinPrice (Y-per-X) as the quote.
 *
 * Returns 0 when totalUsd is 0 (nothing to allocate — caller should bail).
 */
export function currentXWeight(args: {
  balX: BN;
  balY: BN;
  xDec: number;
  yDec: number;
  activeBinPrice: number; // Y per X
  yIsStablecoin: boolean;
}): { xWeight: number; totalUsd: number; xUsd: number; yUsd: number } {
  const xUi = Number(args.balX.toString()) / 10 ** args.xDec;
  const yUi = Number(args.balY.toString()) / 10 ** args.yDec;
  // When Y is a stablecoin, Y price = $1 and X price (in USD) = activeBinPrice.
  // When Y is not a stablecoin we still use activeBinPrice as a relative quote;
  // the resulting weight is unitless so it still compares to deriveTargetXWeight.
  const yPriceUsd = args.yIsStablecoin ? 1 : 1; // relative basis
  const xPriceUsd = args.activeBinPrice * yPriceUsd;
  const xUsd = xUi * xPriceUsd;
  const yUsd = yUi * yPriceUsd;
  const totalUsd = xUsd + yUsd;
  if (totalUsd <= 0) return { xWeight: 0, totalUsd: 0, xUsd: 0, yUsd: 0 };
  return { xWeight: xUsd / totalUsd, totalUsd, xUsd, yUsd };
}
