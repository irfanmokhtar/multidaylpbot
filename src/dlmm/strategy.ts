/**
 * Bin-range math + strategy enum mapping.
 *
 * Two roles:
 *   1. Map the LLM's textual `strategyType` to the SDK's `StrategyType` enum.
 *   2. Convert price bounds (LLM output) into [minBinId, maxBinId] windows.
 */

import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import type { Decision } from "../ai/types";

export const MIN_RANGE_WIDTH = 5;
// 343 = DEFAULT_BIN_PER_POSITION (70) + 3 × MAX_RESIZE_LENGTH (91). Solana tx
// size + CU caps fit at most 3 increasePositionLength2 ix per init tx without
// an Address Lookup Table, so wider single-position windows can't be opened.
export const MAX_RANGE_WIDTH = 343;

export function mapStrategyType(s: Decision["strategyType"]): StrategyType {
  switch (s) {
    case "Spot":
      return StrategyType.Spot;
    case "Curve":
      return StrategyType.Curve;
    case "BidAsk":
      return StrategyType.BidAsk;
    default:
      throw new Error(`mapStrategyType: missing or invalid strategyType: ${s}`);
  }
}

export interface BinWindow {
  minBinId: number;
  maxBinId: number;
  width: number;
}

/**
 * Convert a USD price to its containing binId, using the SDK's static helper.
 * `rounding="floor"` picks the largest binId whose price ≤ target;
 * `rounding="ceil"` picks the smallest binId whose price ≥ target.
 */
export function priceToBinId(
  price: number,
  binStep: number,
  rounding: "floor" | "ceil",
): number {
  return DLMM.getBinIdFromPrice(price, binStep, rounding === "floor");
}

export interface PriceBoundsWindow extends BinWindow {
  lowerPrice: number;
  upperPrice: number;
  /** True when the active bin falls within [minBinId, maxBinId] inclusive. */
  activeBinInside: boolean;
}

/**
 * Convert (lowerPrice, upperPrice) into a bin window.
 * Floors the lower bound to its bin; ceils the upper bound. Throws if the
 * derived width violates [MIN_RANGE_WIDTH, MAX_RANGE_WIDTH] — caller surfaces
 * to Telegram so the LLM retries with sane bounds. No silent clamping.
 */
export function priceBoundsToWindow(
  lowerPrice: number,
  upperPrice: number,
  binStep: number,
  activeBinId: number,
): PriceBoundsWindow {
  if (!(lowerPrice > 0 && upperPrice > lowerPrice)) {
    throw new Error(
      `priceBoundsToWindow: invalid bounds lower=${lowerPrice} upper=${upperPrice}`,
    );
  }
  const minBinId = priceToBinId(lowerPrice, binStep, "floor");
  const maxBinId = priceToBinId(upperPrice, binStep, "ceil");
  const width = maxBinId - minBinId + 1;
  if (width < MIN_RANGE_WIDTH || width > MAX_RANGE_WIDTH) {
    throw new Error(
      `priceBoundsToWindow: derived width ${width} outside ` +
        `[${MIN_RANGE_WIDTH},${MAX_RANGE_WIDTH}] (bounds $${lowerPrice}–$${upperPrice}, ` +
        `binStep ${binStep} bps). Decision rejected; LLM should retry with wider/narrower bounds.`,
    );
  }
  return {
    minBinId,
    maxBinId,
    width,
    lowerPrice,
    upperPrice,
    activeBinInside: activeBinId >= minBinId && activeBinId <= maxBinId,
  };
}
