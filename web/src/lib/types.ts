export type Action = "hold" | "rebalance" | "claim_fees" | "pause";
export type CycleType = "daily" | "intraday" | "ad_hoc";

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  label?: string | null;
}

export interface BBPoint {
  mid: number;
  hi: number;
  lo: number;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  hist: number;
}

export interface IndicatorBundle {
  candles: Candle[];
  ema20: number[];
  ema50: number[];
  bb: BBPoint[];
  rsi: number[];
  macd: MacdPoint[];
}

export interface DecisionRowMock {
  id: number;
  t: string;
  absT: string;
  cycle: CycleType;
  action: Action;
  confidence: number;
  model: string;
}

export interface ScheduleJob {
  name: string;
  cron: string;
  description: string;
  nextRun: string;
  nextRel: string;
  lastRun: string;
  enabled: boolean;
}
