/**
 * Technical-indicator pack computed from OHLCV candles.
 *
 * Each indicator returns its most recent value (for the latest closed
 * candle). The Sonnet analyzer consumes this as a compact JSON object —
 * no need for full series arrays in the prompt.
 */

import { RSI, EMA, BollingerBands, MACD, ATR } from "technicalindicators";
import type { Candle } from "../state/repos";

export interface IndicatorPack {
  /** Latest close price (for context). */
  close: number;
  /** Period in source candles, just for prompt clarity. */
  candleCount: number;

  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  bb: { upper: number; middle: number; lower: number; pctB: number } | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr14: number | null;
  /** ATR as a fraction of close (atr14/close) — vol regime, comparable across price levels. */
  atrPct: number | null;

  /** Latest closed-candle volume. */
  volume: number | null;
  /** 20-period SMA of candle volume. */
  volumeSma20: number | null;

  /** Derived "trend stack" view — quick to read in the prompt. */
  trend: {
    /** "above" if close > EMA, "below" if below, null if EMA undefined. */
    vsEma20: "above" | "below" | null;
    vsEma50: "above" | "below" | null;
    vsEma200: "above" | "below" | null;
    /** Bullish stacking: EMA20 > EMA50 > EMA200. */
    bullishStacked: boolean | null;
    bearishStacked: boolean | null;
  };
}

/** Pull the last value of an array, or null if empty. */
function last<T>(arr: T[]): T | null {
  return arr.length === 0 ? null : (arr[arr.length - 1] as T);
}

/**
 * Compute the full indicator pack. Tolerates short series — any indicator
 * that doesn't have enough data points returns null (rather than throwing).
 */
export function computeIndicators(candles: Candle[]): IndicatorPack {
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const volumes = candles.map((c) => c.v);
  const close = last(closes) ?? 0;

  const rsi14 = closes.length >= 15 ? last(RSI.calculate({ values: closes, period: 14 })) : null;

  const ema = (period: number): number | null => {
    if (closes.length < period) return null;
    return last(EMA.calculate({ values: closes, period }));
  };
  const ema20 = ema(20);
  const ema50 = ema(50);
  const ema200 = ema(200);

  let bb: IndicatorPack["bb"] = null;
  if (closes.length >= 20) {
    const out = last(
      BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }),
    );
    if (out) {
      const range = out.upper - out.lower;
      const pctB = range > 0 ? (close - out.lower) / range : 0.5;
      bb = { upper: out.upper, middle: out.middle, lower: out.lower, pctB };
    }
  }

  let macd: IndicatorPack["macd"] = null;
  if (closes.length >= 35) {
    const out = last(
      MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }),
    );
    if (out && out.MACD !== undefined && out.signal !== undefined && out.histogram !== undefined) {
      macd = { macd: out.MACD, signal: out.signal, histogram: out.histogram };
    }
  }

  let atr14: number | null = null;
  if (candles.length >= 15) {
    atr14 = last(
      ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    );
  }

  const cmpEma = (e: number | null): "above" | "below" | null =>
    e === null ? null : close > e ? "above" : "below";

  const bullishStacked =
    ema20 !== null && ema50 !== null && ema200 !== null
      ? ema20 > ema50 && ema50 > ema200
      : null;
  const bearishStacked =
    ema20 !== null && ema50 !== null && ema200 !== null
      ? ema20 < ema50 && ema50 < ema200
      : null;

  const volume = last(volumes) ?? null;
  const volumeSma20 =
    volumes.length >= 20
      ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
      : null;

  return {
    close,
    candleCount: candles.length,
    rsi14,
    ema20,
    ema50,
    ema200,
    bb,
    macd,
    atr14,
    atrPct: atr14 !== null && close > 0 ? atr14 / close : null,
    volume,
    volumeSma20,
    trend: {
      vsEma20: cmpEma(ema20),
      vsEma50: cmpEma(ema50),
      vsEma200: cmpEma(ema200),
      bullishStacked,
      bearishStacked,
    },
  };
}
