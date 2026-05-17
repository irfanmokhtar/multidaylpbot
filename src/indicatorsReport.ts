/**
 * Shared indicator-pass builder. Used by both the CLI (`src/cli/analyze.ts`)
 * and the Telegram bot's /analyze handler so output stays consistent.
 *
 * Pure indicators — no LLM call, no on-chain reads. The /decide path is what
 * pulls in position state and asks the model.
 */

import { fetchOhlcv, BTC_MINT, type Interval } from "./data/birdeye";
import { computeIndicators, type IndicatorPack } from "./data/indicators";
import { ohlcvRepo } from "./state/repos";
import { logger } from "./logger";

const INTERVALS: Interval[] = ["1H", "4H", "1D"];
const CANDLES_PER_INTERVAL = 220;

export interface BtcContext {
  price: number;
  trend: "bullish" | "bearish" | "neutral";
  detail: string;
}

export interface IndicatorsReport {
  symbol: string;
  packs: Partial<Record<Interval, IndicatorPack>>;
  btcContext: BtcContext | null;
}

function deriveBtcContext(price: number, ema20: number | null, ema50: number | null): BtcContext {
  if (ema20 === null && ema50 === null) {
    return { price, trend: "neutral", detail: "insufficient data" };
  }
  const aboveEma20 = ema20 !== null && price > ema20;
  const aboveEma50 = ema50 !== null && price > ema50;
  const belowEma20 = ema20 !== null && price < ema20;
  const belowEma50 = ema50 !== null && price < ema50;

  const parts: string[] = [];
  if (ema20 !== null) parts.push(aboveEma20 ? "above EMA20" : "below EMA20");
  if (ema50 !== null) parts.push(aboveEma50 ? "above EMA50" : "below EMA50");

  let trend: BtcContext["trend"];
  if (aboveEma20 && aboveEma50) trend = "bullish";
  else if (belowEma20 && belowEma50) trend = "bearish";
  else trend = "neutral";

  return { price, trend, detail: parts.join(", ") };
}

export async function runIndicatorsPass(symbol = "SOL"): Promise<IndicatorsReport> {
  const packs: Partial<Record<Interval, IndicatorPack>> = {};
  for (const interval of INTERVALS) {
    try {
      const candles = await fetchOhlcv({ interval, candles: CANDLES_PER_INTERVAL });
      if (candles.length === 0) {
        logger.warn({ interval }, "no candles returned — skipping");
        continue;
      }
      ohlcvRepo.insert({ symbol, interval, candles });
      packs[interval] = computeIndicators(candles);
    } catch (err) {
      logger.warn(
        { interval, err: err instanceof Error ? err.message : err },
        "OHLCV fetch failed — skipping interval",
      );
    }
  }
  ohlcvRepo.prune(30);

  let btcContext: BtcContext | null = null;
  try {
    const btcCandles = await fetchOhlcv({ address: BTC_MINT, interval: "1D", candles: 55 });
    if (btcCandles.length >= 20) {
      const pack = computeIndicators(btcCandles);
      btcContext = deriveBtcContext(pack.close, pack.ema20, pack.ema50);
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "BTC context fetch failed — skipping");
  }

  return { symbol, packs, btcContext };
}

function fmtNum(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(digits);
  return n.toFixed(4);
}

function fmtVol(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function interpretRsi(rsi: number | null): string {
  if (rsi === null) return "";
  if (rsi >= 70) return "(overbought)";
  if (rsi <= 30) return "(oversold)";
  if (rsi >= 60) return "(strong)";
  if (rsi <= 40) return "(weak)";
  return "(neutral)";
}

function summarize(interval: Interval, p: IndicatorPack): string {
  const lines: string[] = [];
  lines.push(`╭─ ${interval} (n=${p.candleCount})`);
  lines.push(`│  close   ${fmtNum(p.close)}`);
  lines.push(`│  RSI14   ${fmtNum(p.rsi14)}   ${interpretRsi(p.rsi14)}`);
  lines.push(
    `│  EMAs    20=${fmtNum(p.ema20)}   50=${fmtNum(p.ema50)}   200=${fmtNum(p.ema200)}`,
  );
  if (p.trend.bullishStacked) lines.push(`│          bullish-stacked (20>50>200)`);
  else if (p.trend.bearishStacked) lines.push(`│          bearish-stacked (20<50<200)`);
  if (p.bb)
    lines.push(
      `│  BB(20)  upper=${fmtNum(p.bb.upper)}  lower=${fmtNum(p.bb.lower)}  %B=${(p.bb.pctB * 100).toFixed(0)}%`,
    );
  if (p.macd)
    lines.push(
      `│  MACD    macd=${fmtNum(p.macd.macd, 4)}  sig=${fmtNum(p.macd.signal, 4)}  hist=${fmtNum(p.macd.histogram, 4)}`,
    );
  lines.push(`│  ATR14   ${fmtNum(p.atr14)}`);
  lines.push(`│  Volume  cur=${fmtVol(p.volume)}  sma20=${fmtVol(p.volumeSma20)}`);
  lines.push(`╰────`);
  return lines.join("\n");
}

export function formatIndicatorsText(report: IndicatorsReport): string {
  const lines: string[] = [`📊 ${report.symbol} technical indicators`, ``];
  if (report.btcContext) {
    const { price, trend, detail } = report.btcContext;
    const icon = trend === "bullish" ? "📈" : trend === "bearish" ? "📉" : "➡️";
    lines.push(`${icon} BTC  $${price.toFixed(0)}  —  ${trend}  (${detail})`);
    lines.push(``);
  }
  for (const interval of INTERVALS) {
    const pack = report.packs[interval];
    if (pack) lines.push(summarize(interval, pack));
  }
  return lines.join("\n");
}

export function formatIndicatorsHtml(report: IndicatorsReport): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre>${esc(formatIndicatorsText(report))}</pre>`;
}
