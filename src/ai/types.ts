/**
 * LLM-agnostic types for the analyzer.
 *
 * The Decision schema is what every provider must produce. The DecisionInput
 * is the structured payload we hand to the model. The LLMProvider interface
 * is what each implementation (Gemini / Groq / Anthropic) satisfies.
 */

import { z } from "zod";
import type { IndicatorPack } from "../data/indicators";

// ─── Decision schema ─────────────────────────────────────────────────────────

export const StrategyType = z.enum(["Spot", "Curve", "BidAsk"]);
export type StrategyType = z.infer<typeof StrategyType>;

export const Action = z.enum([
  "hold",
  "rebalance",
  "pause",
]);
export type Action = z.infer<typeof Action>;

export const KeyLevels = z.object({
  support: z.number().nullable(),
  resistance: z.number().nullable(),
});
export type KeyLevels = z.infer<typeof KeyLevels>;

export const SignalKind = z.enum(["bullish", "bearish", "caution", "structural"]);
export type SignalKind = z.infer<typeof SignalKind>;

export const Signal = z.object({
  kind: SignalKind,
  title: z.string().min(3).max(80),
  note: z.string().min(3).max(240),
});
export type Signal = z.infer<typeof Signal>;

export const Scenario = z.object({
  priceTarget: z.number(),
  trigger: z.string().min(3).max(400),
  probabilityPct: z.number().int().min(0).max(100),
});
export type Scenario = z.infer<typeof Scenario>;

export const Scenarios = z.object({
  bull: Scenario,
  base: Scenario,
  bear: Scenario,
}).refine(
  (s) => s.bull.probabilityPct + s.base.probabilityPct + s.bear.probabilityPct === 100,
  { message: "scenario probabilities must sum to 100" },
);
export type Scenarios = z.infer<typeof Scenarios>;

export const DlmmVerb = z.enum(["HOLD", "ROLL", "OPEN", "CLOSE"]);
export type DlmmVerb = z.infer<typeof DlmmVerb>;

export const DlmmSuggestion = z.object({
  verb: DlmmVerb,
  /** One-line action description, e.g. "Roll range to 185-210, keep BidAsk". */
  detail: z.string().min(3).max(240),
});
export type DlmmSuggestion = z.infer<typeof DlmmSuggestion>;

export const Decision = z.object({
  // Field order mirrors DECISION_JSON_SCHEMA: reason-then-act (analysis fields
  // first, execution fields last) so the model reasons before committing.

  // — TA / reasoning fields —
  /** 1–2 sentence top-line: the single most important development this cycle. */
  headline: z.string().min(10).transform((s) => s.slice(0, 300)),
  /** 3–6 key signals ranked by importance. Omit on intraday cycles to save tokens. */
  signals: z.array(Signal).min(3).max(6).optional(),
  /** Bull/base/bear scenarios summing to 100%. Omit on intraday cycles. */
  scenarios: Scenarios.optional(),
  keyLevels: KeyLevels.optional(),
  /** ≤1500 char narrative tying signals into a coherent picture (hard cap 2500 to absorb minor overruns). */
  reasoning: z.string().min(20).max(2500),

  // — execution-layer fields (read by rebalance.ts / scheduler.ts — do not remove) —
  /** Mandatory DLMM verdict with verb + 1-line detail. */
  dlmm: DlmmSuggestion,
  /** Required when action="rebalance"; ignored otherwise. */
  strategyType: StrategyType.nullable().optional(),
  /** Absolute USD price of the lower bound. Required when action="rebalance"; null otherwise. */
  lowerBoundPrice: z.number().positive().nullable().optional(),
  /** Absolute USD price of the upper bound. Required when action="rebalance"; null otherwise. Must exceed lowerBoundPrice. */
  upperBoundPrice: z.number().positive().nullable().optional(),
  action: Action,
  confidence: z.number().min(0).max(1),
}).refine(
  (d) =>
    d.action !== "rebalance" ||
    (d.strategyType != null &&
      d.lowerBoundPrice != null &&
      d.upperBoundPrice != null &&
      d.upperBoundPrice > d.lowerBoundPrice),
  {
    message:
      "action='rebalance' requires strategyType + lowerBoundPrice + upperBoundPrice with upperBoundPrice > lowerBoundPrice > 0",
  },
);
export type Decision = z.infer<typeof Decision>;

// ─── DecisionInput — what we pass to the LLM ─────────────────────────────────

export type CycleType = "daily" | "intraday" | "ad_hoc";

/** Compact prior-reading row from SQLite (5 delta-relevant fields). */
export interface PriorReading {
  takenAt: number; // unix ms
  close: number;
  rsi14: number | null;
  ema20: number | null;
  bbPctB: number | null;
  macdHist: number | null;
  atr14: number | null;
  ema50: number | null;
}

export interface DecisionInput {
  cycle: CycleType;
  pool: {
    address: string | null;
    binStep: number | null;
    activeBinId: number | null;
    activeBinPrice: number | null;
    apr24h: number | null;
    feeTvlRatio24hPct: number | null;
    tvlUsd: number | null;
  };
  /** All open positions on the pool. Empty array = no open position. */
  positions: Array<{
    lowerBinId: number;
    upperBinId: number;
    width: number;
    inRange: boolean;
    holdings: { x: number; y: number };
    fees: { x: number; y: number };
    valueUsd: number | null;
    tokenX: { symbol: string };
    tokenY: { symbol: string };
    /** Pre-computed USD bounds of this position (from bin IDs × bin step). */
    lowerPriceUsd: number | null;
    upperPriceUsd: number | null;
    /** Active-bin position within range: 0=lower edge, 1=upper edge (outside [0,1] when out of range). */
    activeBinOffsetPct: number | null;
    /** Bins between the active bin and each edge (negative = active bin past that edge). */
    binsToLowerEdge: number | null;
    binsToUpperEdge: number | null;
  }>;
  indicators: {
    "1H": IndicatorPack | null;
    "4H": IndicatorPack | null;
    "1D": IndicatorPack | null;
  };
  /** Last 2 prior indicator readings per timeframe from SQLite (oldest first). */
  priorReadings: {
    "1H": PriorReading[];
    "4H": PriorReading[];
    "1D": PriorReading[];
  };
  /** Last 5 prior decisions (most recent first). */
  recentDecisions: Array<{
    cycle: CycleType;
    action: Action;
    confidence: number;
    reasoning: string;
    decidedAtIso: string;
  }>;
  constraints: {
    maxDeployUsd: number;
  };
  /** BTC macro trend context — EMA20/EMA50 on 1D. Null if fetch failed. */
  btcContext: {
    price: number;
    trend: "bullish" | "bearish" | "neutral";
    detail: string;
  } | null;
  /**
   * Newest BTC_DAILY_RESEARCH.md block — sentiment + TA + Elliott Wave brief.
   * Daily/ad_hoc cycles only; null on intraday or if the file is missing.
   */
  btcResearch: {
    dateIso: string;
    ageDays: number;
    stale: boolean;
    text: string;
  } | null;
}

// ─── LLMProvider interface ───────────────────────────────────────────────────

export interface GenerateJsonArgs<T> {
  system: string;
  user: string;
  /** Human-readable name of the schema (used in some prompts). */
  schemaName: string;
  /** JSON-schema-compatible object describing the response shape. */
  schemaJson: object;
  /** Zod validator the response is parsed against. */
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
  /** 0..1; use lower for more deterministic decisions. */
  temperature?: number;
}

export interface LLMProvider {
  /** "gemini" | "groq" | "anthropic" — used in logs. */
  name: string;
  /** The actual model id used (after env override is applied). */
  model: string;
  generateJson<T>(args: GenerateJsonArgs<T>): Promise<T>;
}
