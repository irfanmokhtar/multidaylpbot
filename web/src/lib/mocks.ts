import type {
  Candle,
  IndicatorBundle,
  DecisionRowMock,
  ScheduleJob,
} from "./types";

export const POOL = {
  pair: "SOL/USDC",
  address: "AnXqEjQ4n3LZ5xVtmKpNc7H4yT2sR9JvL3pBUMfgVL3p",
  binStep: 25,
  activeBinId: 8412,
  activePrice: 167.34,
  apr24h: 142.7,
  feeTvl24h: 0.39,
  tvlUsd: 1_842_350,
};

export const POSITION = {
  pubkey: "Po1sNvYx7T8mFeZ2bKa9LqWcGtR5dHj4nQpAxBcDeFgH",
  lowerBinId: 8388,
  upperBinId: 8438,
  width: 51,
  minPrice: 162.41,
  maxPrice: 173.04,
  inRange: true,
  valueUsd: 4_283.72,
  feesAccrued: 18.42,
  feesAccruedSol: 0.0428,
  feesAccruedUsdc: 11.27,
  holdings: { sol: 14.213, usdc: 1908.41 },
  openedAt: "2026-05-08T09:11:00Z",
  cyclesSinceOpen: 7,
};

export const LAST_DECISION = {
  id: 142,
  cycle: "intraday" as const,
  action: "hold" as const,
  confidence: 0.74,
  decidedAtIso: "2026-05-10T14:30:11Z",
  ageMin: 22,
  model: "gemini-2.5-flash",
  reasoning:
    "Active bin at 8412 sits comfortably in the upper half of the range with 26 bins of headroom up. RSI on 4H is 58 — neutral but trending. EMA20 > EMA50 > EMA200 with a tight stack, so the trend is intact but losing steam at this level. Bollinger %B is 0.71 — late-cycle but not overextended. No reason to disturb a position earning fees. Re-evaluate at the daily TA window or if active bin drifts below 8400.",
  keyLevels: { support: 164.2, resistance: 171.8 },
  strategyType: null,
  lowerBoundPrice: null,
  upperBoundPrice: null,
};

export const DECISIONS: DecisionRowMock[] = [
  { id: 142, t: "2m ago", absT: "14:30:11 UTC · May 10", cycle: "intraday", action: "hold", confidence: 0.74, model: "gemini-2.5-flash" },
  { id: 141, t: "4h ago", absT: "10:30:00 UTC · May 10", cycle: "intraday", action: "hold", confidence: 0.68, model: "gemini-2.5-flash" },
  { id: 140, t: "8h ago", absT: "06:30:00 UTC · May 10", cycle: "intraday", action: "claim_fees", confidence: 0.81, model: "gemini-2.5-flash" },
  { id: 139, t: "12h ago", absT: "02:30:00 UTC · May 10", cycle: "intraday", action: "hold", confidence: 0.62, model: "gemini-2.5-flash" },
  { id: 138, t: "1d ago", absT: "09:00:00 UTC · May 09", cycle: "daily", action: "rebalance", confidence: 0.83, model: "gemini-2.5-flash" },
  { id: 137, t: "1d 4h ago", absT: "22:30:00 UTC · May 08", cycle: "intraday", action: "hold", confidence: 0.41, model: "gemini-2.5-flash" },
  { id: 136, t: "1d 8h ago", absT: "18:30:00 UTC · May 08", cycle: "intraday", action: "hold", confidence: 0.55, model: "gemini-2.5-flash" },
  { id: 135, t: "1d 12h ago", absT: "14:30:00 UTC · May 08", cycle: "ad_hoc", action: "pause", confidence: 0.92, model: "gemini-2.5-flash" },
  { id: 134, t: "1d 16h ago", absT: "10:30:00 UTC · May 08", cycle: "intraday", action: "hold", confidence: 0.66, model: "gemini-2.5-flash" },
  { id: 133, t: "2d ago", absT: "09:00:00 UTC · May 08", cycle: "daily", action: "rebalance", confidence: 0.78, model: "gemini-2.5-flash" },
  { id: 132, t: "2d 4h ago", absT: "22:30:00 UTC · May 07", cycle: "intraday", action: "hold", confidence: 0.59, model: "gemini-2.5-flash" },
  { id: 131, t: "2d 8h ago", absT: "18:30:00 UTC · May 07", cycle: "intraday", action: "claim_fees", confidence: 0.71, model: "gemini-2.5-flash" },
];

export const DECISION_REASONINGS: Record<number, string> = {
  142: LAST_DECISION.reasoning,
  141: "Active bin holding 8410. RSI 4H climbed to 56 from 51 — momentum building but no breakout signal. Position is mid-range and earning steady fees. Standard hold; check at next intraday window.",
  140: "Fees accrued have crossed $1.20 SOL-side and $9.80 USDC-side. Pool fee rate spiked 4 hours ago (37bps → 52bps). LLM sweep recommendation: claim now to compound on next rebalance, no range change needed. Active bin is 8409, well within range.",
  139: "Choppy 1H action — last 4 candles all closed within a $0.40 band. RSI flat at 49. ATR has compressed by 28% over the prior 24h. Holding is the dominant move; rebalancing now would lock in a tighter range right before a potential breakout.",
  138: "DAILY: Trend regime has shifted from balanced to weakly bullish — EMA20 crossed above EMA50 on the 4H 12 hours ago and held. Active bin drifted to 8401, still in range but on the lower third. Recommending rebalance to recenter at 8412 with the same width (51 bins) using Curve strategy to concentrate around the new EMA20 support.",
  137: "Active bin 8398 — drifted 3 bins below the previous center but still in range. Hold; do not chase yet. Daily TA in 10h will get a cleaner read.",
  136: "Mid-range, low-conviction hold. All indicators sideways. No action.",
  135: "Daily TA window detected an unusual on-chain event — flash dump of ~$3.4M into the pool 18 minutes ago skewed the active bin and historical volume. Recommending pause to avoid a reactive rebalance on bad data. User should `/resume` after reviewing the price chart.",
  134: "Standard intraday hold. Active bin centered, RSI 54, no signal. Position earning ~$1.10/h in fees at current TVL share.",
  133: "DAILY: Position has aged 6 cycles in current range. Active bin is at the upper edge (8431 of 8438). Recommend rebalance to recenter using Spot strategy with width 51 bins — same width preserves balanced path and avoids close+reopen tx cost.",
  132: "Active bin 8424. Drifting up but still has 14 bins of headroom. Hold; daily window will get clearer signal.",
  131: "Fees have built up materially during the recent volume spike. Active bin still mid-range. Claim and continue holding the same range — no rebalance needed.",
};

function genCandles(n: number, seed = 0.42, vol = 1.6, base = 165): Candle[] {
  const out: Candle[] = [];
  let close = base;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 6 + seed) * 0.4 + Math.cos(i / 11) * 0.25;
    const noise = ((Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1) - 0.5;
    const open = close;
    close = open + drift + noise * vol;
    const high = Math.max(open, close) + Math.abs(noise) * 0.6;
    const low = Math.min(open, close) - Math.abs(noise) * 0.6;
    out.push({ o: open, c: close, h: high, l: low });
  }
  return out;
}

export const CANDLES_4H: Candle[] = genCandles(100, 0.31, 1.4, 158).map((c, i) => ({
  ...c,
  label: i % 16 === 0 ? `D-${Math.round((100 - i) / 6)}` : null,
}));
const CANDLES_1H: Candle[] = genCandles(80, 0.18, 0.9, 162).map((c, i) => ({
  ...c,
  label: i % 12 === 0 ? `${24 - Math.round((80 - i) / 3.3)}:00` : null,
}));
const CANDLES_4H_IND: Candle[] = CANDLES_4H.map((c, i) => ({
  ...c,
  label: i % 14 === 0 ? `D-${Math.round((100 - i) / 6)}` : null,
}));
const CANDLES_1D: Candle[] = genCandles(60, 0.55, 4.2, 140).map((c, i) => ({
  ...c,
  label: i % 10 === 0 ? `M-${Math.round((60 - i) / 30)}` : null,
}));

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  return values.map((v, i) => {
    if (i === 0) return v;
    prev = v * k + prev * (1 - k);
    return prev;
  });
}

function bollinger(values: number[], period = 20, stdN = 2) {
  return values.map((_, i) => {
    const s = Math.max(0, i - period + 1);
    const slice = values.slice(s, i + 1);
    const mid = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / slice.length;
    const sd = Math.sqrt(variance);
    return { mid, hi: mid + stdN * sd, lo: mid - stdN * sd };
  });
}

function rsi(values: number[], period = 14): number[] {
  const out = new Array(values.length).fill(50);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < values.length; i++) {
    const d = (values[i] ?? 0) - (values[i - 1] ?? 0);
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    if (i <= period) {
      gains += g;
      losses += l;
      if (i === period) {
        const avgG = gains / period;
        const avgL = losses / period;
        out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9));
      }
    } else {
      gains = (gains * (period - 1) + g) / period;
      losses = (losses * (period - 1) + l) / period;
      out[i] = 100 - 100 / (1 + gains / (losses || 1e-9));
    }
  }
  return out;
}

function macd(values: number[]) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);
  const macdLine = values.map((_, i) => (e12[i] ?? 0) - (e26[i] ?? 0));
  const signal = ema(macdLine, 9);
  return values.map((_, i) => ({
    macd: macdLine[i] ?? 0,
    signal: signal[i] ?? 0,
    hist: (macdLine[i] ?? 0) - (signal[i] ?? 0),
  }));
}

function indicatorsFor(candles: Candle[]): IndicatorBundle {
  const closes = candles.map((c) => c.c);
  return {
    candles,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    bb: bollinger(closes, 20, 2),
    rsi: rsi(closes, 14),
    macd: macd(closes),
  };
}

export { indicatorsFor as buildIndicatorBundle };

export const IND_1H = indicatorsFor(CANDLES_1H);
export const IND_4H = indicatorsFor(CANDLES_4H_IND);
export const IND_1D = indicatorsFor(CANDLES_1D);

export const SCHEDULE: ScheduleJob[] = [
  { name: "daily-ta", cron: "0 9 * * *", description: "Full TA + LLM decision + Telegram report (always notifies)", nextRun: "Tomorrow 09:00 UTC", nextRel: "in 18h 28m", lastRun: "Today 09:00 UTC", enabled: true },
  { name: "intraday-ta", cron: "0 */4 * * *", description: "Light TA (1H + 4H); notifies only if action ≠ hold", nextRun: "Today 16:00 UTC", nextRel: "in 1h 28m", lastRun: "Today 12:00 UTC", enabled: true },
  { name: "position-health", cron: "0 * * * *", description: "Read active bin + range; alerts on out-of-range only", nextRun: "Today 15:00 UTC", nextRel: "in 28m", lastRun: "Today 14:00 UTC", enabled: true },
];

export const RAW_INPUT = {
  cycle: "intraday",
  pool: { address: "AnXqEjQ4...VL3p", binStep: 25, activeBinId: 8412, activeBinPrice: 167.34, apr24h: 142.7, feeTvlRatio24hPct: 0.39, tvlUsd: 1842350 },
  position: {
    exists: true, lowerBinId: 8388, upperBinId: 8438, width: 51, inRange: true,
    holdings: { x: 14.213, y: 1908.41 }, fees: { x: 0.0428, y: 11.27 },
    valueUsd: 4283.72, tokenX: { symbol: "SOL" }, tokenY: { symbol: "USDC" },
  },
  indicators: {
    "1H": { close: 167.34, rsi14: 56.4, ema20: 166.21, ema50: 164.78, ema200: 158.42, bb: { upper: 169.41, middle: 166.18, lower: 162.95, pctB: 0.68 }, macd: { macd: 0.42, signal: 0.31, histogram: 0.11 }, atr14: 1.42, trend: { vsEma20: "above", vsEma50: "above", vsEma200: "above", bullishStacked: true, bearishStacked: false } },
    "4H": { close: 167.34, rsi14: 58.1, ema20: 165.04, ema50: 162.91, ema200: 154.18, bb: { upper: 171.20, middle: 165.18, lower: 159.16, pctB: 0.71 }, macd: { macd: 1.21, signal: 0.92, histogram: 0.29 }, atr14: 3.10, trend: { vsEma20: "above", vsEma50: "above", vsEma200: "above", bullishStacked: true, bearishStacked: false } },
    "1D": null,
  },
  recentDecisions: [
    { cycle: "intraday", action: "hold", confidence: 0.68, reasoning: "Mid-range hold, RSI 51", decidedAtIso: "2026-05-10T10:30:00Z" },
    { cycle: "intraday", action: "claim_fees", confidence: 0.81, reasoning: "Fee threshold exceeded", decidedAtIso: "2026-05-10T06:30:00Z" },
  ],
  constraints: { maxDeployUsd: 5000, minRebalanceIntervalHours: 0 },
};
