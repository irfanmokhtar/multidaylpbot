/**
 * Frontend mirrors of backend response shapes.
 * Hand-mirrored (not generated) — keep in sync with:
 *   src/report.ts            → StatusReport
 *   src/dlmm/positions.ts    → PortfolioSnapshot, PositionSummary, TokenSide
 *   src/state/repos.ts       → DecisionRow
 *   src/ai/types.ts          → Decision, DecisionInput, KeyLevels
 *   src/data/indicators.ts   → IndicatorPack
 *   src/data/meteora_api.ts  → PoolRow
 *   src/scheduler.ts         → SchedulerStatus
 */

import type { Action, CycleType } from "./types";

export interface TokenSide {
  mint: string;
  decimals: number;
  symbol: string;
  isStablecoin: boolean;
}

export interface PositionBin {
  binId: number;
  x: number;
  y: number;
}

export interface PositionSummary {
  publicKey: string;
  lowerBinId: number;
  upperBinId: number;
  width: number;
  totalX: number;
  totalY: number;
  feeX: number;
  feeY: number;
  inRange: boolean;
  bins?: PositionBin[];
}

export interface PortfolioSnapshot {
  user: string;
  pool: string;
  activeBinId: number;
  activeBinPrice: string;
  binStep: number;
  tokenX: TokenSide;
  tokenY: TokenSide;
  positions: PositionSummary[];
}

export interface StatusReport {
  snapshot: PortfolioSnapshot;
  activeBin: { binId: number; pricePerToken: string; binStep: number };
  mode: "dryrun" | "live";
  wallet: string;
}

export interface HealthReport {
  uptimeSec: number;
  dbSizeBytes: number | null;
  mode: "dryrun" | "live";
  paused: boolean;
}

// ─── decisions ──────────────────────────────────────────────────────────────

export type StrategyType = "Spot" | "Curve" | "BidAsk";

export interface KeyLevels {
  support: number | null;
  resistance: number | null;
}

export type SignalKind = "bullish" | "bearish" | "caution" | "structural";

export interface Signal {
  kind: SignalKind;
  title: string;
  note: string;
}

export interface Scenario {
  priceTarget: number;
  trigger: string;
  probabilityPct: number;
}

export type DlmmVerb = "HOLD" | "ROLL" | "OPEN" | "CLOSE";

export interface DlmmSuggestion {
  verb: DlmmVerb;
  detail: string;
}

export interface Decision {
  action: Action;
  strategyType?: StrategyType;
  /** Pre-migration rows may still carry this; new rows use lower/upperBoundPrice. */
  rangeWidthBins?: number;
  lowerBoundPrice?: number;
  upperBoundPrice?: number;
  confidence: number;
  keyLevels?: KeyLevels;
  // new fields — optional for back-compat with pre-migration DB rows
  headline?: string;
  dlmm?: DlmmSuggestion;
  reasoning: string;
  signals?: Signal[];
  scenarios?: { bull: Scenario; base: Scenario; bear: Scenario };
}

export interface IndicatorPack {
  close: number;
  candleCount: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  bb: { upper: number; middle: number; lower: number; pctB: number } | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr14: number | null;
  trend: {
    vsEma20: "above" | "below" | null;
    vsEma50: "above" | "below" | null;
    vsEma200: "above" | "below" | null;
    bullishStacked: boolean | null;
    bearishStacked: boolean | null;
  };
}

export interface PriorReading {
  takenAt: number;
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
  priorReadings?: {
    "1H": PriorReading[];
    "4H": PriorReading[];
    "1D": PriorReading[];
  };
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
}

export interface DecisionRow {
  id: number;
  decidedAt: number;
  cycle: CycleType;
  provider: string;
  model: string;
  action: Action;
  confidence: number;
  decision: Decision;
  input: DecisionInput;
}

export interface DecisionsPage {
  rows: DecisionRow[];
  nextBefore: number | null;
}

// ─── pool / scheduler / ohlcv ───────────────────────────────────────────────

export interface PoolRow {
  address: string;
  name: string;
  binStep: number;
  baseFeePct: number;
  tokenX: { symbol: string; address: string };
  tokenY: { symbol: string; address: string };
  currentPrice: number;
  tvlUsd: number;
  apr: number;
  apy: number;
  volume24hUsd: number;
  fees24hUsd: number;
  feeTvlRatio24hPct: number;
  feeTvlRatio4hPct: number;
  hasFarm: boolean;
  farmApr: number;
}

export interface SchedulerJob {
  name: string;
  cron: string;
  nextRun: string | null;
}

export interface SchedulerStatus {
  enabled: boolean;
  paused: boolean;
  jobs: SchedulerJob[];
}

export interface OhlcvCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OhlcvSnapshot {
  symbol: string;
  interval: string;
  fetchedAt: number;
  candles: OhlcvCandle[];
}

export interface IndicatorsResponse {
  "1H": IndicatorPack | null;
  "4H": IndicatorPack | null;
  "1D": IndicatorPack | null;
  decidedAt: number | null;
  cycle?: CycleType;
}

// ─── pnl ─────────────────────────────────────────────────────────────────────

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
  createdAt: number | null;
  closedAt: number | null;
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
  generatedAt: number;
  cached: boolean;
  wallet: string;
  pool: {
    address: string;
    tokenX: string;
    tokenY: string;
    tokenXPrice: number;
    tokenYPrice: number;
  } | null;
  notIndexed: boolean;
  total: PnlReportTotal;
  positions: PnlReportPosition[];
}

export interface PositionEvent {
  signature: string;
  ixIndex: number;
  eventType: string;
  positionAddress: string;
  poolAddress: string;
  userAddress: string;
  blockTime: number;
  slot: number;
  tokenX: string;
  tokenY: string;
  amountX: string;
  amountY: string;
  amountXUsd: string;
  amountYUsd: string;
  totalUsd: string;
  createdAt: string;
}

export interface PositionHistoryResponse {
  events: PositionEvent[];
}
