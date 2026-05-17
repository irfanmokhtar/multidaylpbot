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
  "claim_fees",
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
  // — execution-layer fields (read by rebalance.ts / scheduler.ts — do not remove) —
  action: Action,
  /** Required when action="rebalance"; ignored otherwise. */
  strategyType: StrategyType.nullable().optional(),
  /** Absolute USD price of the lower bound. Required when action="rebalance"; null otherwise. */
  lowerBoundPrice: z.number().positive().nullable().optional(),
  /** Absolute USD price of the upper bound. Required when action="rebalance"; null otherwise. Must exceed lowerBoundPrice. */
  upperBoundPrice: z.number().positive().nullable().optional(),
  confidence: z.number().min(0).max(1),
  keyLevels: KeyLevels.optional(),

  // — always-required TA fields —
  /** 1–2 sentence top-line: the single most important development this cycle. */
  headline: z.string().min(10).transform((s) => s.slice(0, 300)),
  /** Mandatory DLMM verdict with verb + 1-line detail. */
  dlmm: DlmmSuggestion,
  /** ≤1500 char narrative tying signals into a coherent picture. */
  reasoning: z.string().min(20).max(1500),

  // — rich TA fields — required on daily/ad_hoc by system prompt; optional for intraday —
  /** 3–6 key signals ranked by importance. Omit on intraday cycles to save tokens. */
  signals: z.array(Signal).min(3).max(6).optional(),
  /** Bull/base/bear scenarios summing to 100%. Omit on intraday cycles. */
  scenarios: Scenarios.optional(),
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
