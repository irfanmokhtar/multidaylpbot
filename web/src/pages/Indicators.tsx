import { useMemo } from "react";
import { CandleChart, MacdChart, RsiChart } from "../components/Charts";
import { IND_1D, IND_1H, IND_4H, buildIndicatorBundle } from "../lib/mocks";
import { useOhlcv } from "../lib/queries";
import type { Candle, IndicatorBundle } from "../lib/types";
import type { OhlcvCandle } from "../lib/schemas";

const W = 1336;

function toCandles(raw: OhlcvCandle[], labelEvery: number): Candle[] {
  return raw.map((c, i, arr) => ({
    o: c.o, h: c.h, l: c.l, c: c.c,
    label: i % labelEvery === 0 ? `D-${Math.round((arr.length - i) / (arr.length / 10))}` : null,
  }));
}

function IndicatorPanel({ ind, label }: { ind: IndicatorBundle; label: string }) {
  const last = ind.candles[ind.candles.length - 1];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <span className="card-h-title">{label}</span>
        <span style={{ marginLeft: 12 }} className="row">
          <span className="row" style={{ gap: 6 }}>
            <span style={{ width: 14, height: 1, background: "var(--amber)" }} />
            <span className="label" style={{ letterSpacing: "0.1em" }}>
              EMA20
            </span>
          </span>
          <span className="row" style={{ gap: 6 }}>
            <span style={{ width: 14, height: 1, background: "var(--purple)" }} />
            <span className="label" style={{ letterSpacing: "0.1em" }}>
              EMA50
            </span>
          </span>
          <span className="row" style={{ gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 6,
                background: "rgba(123,160,217,0.14)",
                border: "1px solid rgba(123,160,217,0.4)",
              }}
            />
            <span className="label" style={{ letterSpacing: "0.1em" }}>
              BOLLINGER 20·2σ
            </span>
          </span>
        </span>
        <span className="card-h-sub" style={{ marginLeft: "auto" }}>
          {ind.candles.length} CANDLES · CLOSE ${last ? last.c.toFixed(2) : "—"}
        </span>
      </div>
      <div className="card-b" style={{ paddingTop: 10, paddingBottom: 6 }}>
        <CandleChart
          candles={ind.candles}
          width={W}
          height={210}
          ema20={ind.ema20}
          ema50={ind.ema50}
          bb={ind.bb}
        />
        <div style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 4 }}>
          <RsiChart data={ind.rsi} width={W} height={64} />
        </div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 4 }}>
          <MacdChart data={ind.macd} width={W} height={64} />
        </div>
      </div>
    </div>
  );
}

export function Indicators() {
  const { data: ohlcv1h } = useOhlcv("1H");
  const { data: ohlcv4h } = useOhlcv("4H");
  const { data: ohlcv1d } = useOhlcv("1D");

  const ind1h = useMemo(
    () => ohlcv1h?.candles ? buildIndicatorBundle(toCandles(ohlcv1h.candles, 12)) : IND_1H,
    [ohlcv1h],
  );
  const ind4h = useMemo(
    () => ohlcv4h?.candles ? buildIndicatorBundle(toCandles(ohlcv4h.candles, 14)) : IND_4H,
    [ohlcv4h],
  );
  const ind1d = useMemo(
    () => ohlcv1d?.candles ? buildIndicatorBundle(toCandles(ohlcv1d.candles, 10)) : IND_1D,
    [ohlcv1d],
  );

  return (
    <div style={{ padding: "20px 24px 32px", maxWidth: 1400, margin: "0 auto" }}>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <div className="label" style={{ marginBottom: 4 }}>
            INDICATORS
          </div>
          <div
            style={{
              fontSize: 18,
              color: "var(--fg-0)",
              fontWeight: 500,
              letterSpacing: "-0.01em",
            }}
          >
            Technical pack — 1H · 4H · 1D
          </div>
        </div>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          BIRDEYE · CACHED · TTL 60S
        </span>
      </div>

      <IndicatorPanel ind={ind1h} label="1H · INTRADAY" />
      <IndicatorPanel ind={ind4h} label="4H · STRUCTURE" />
      <IndicatorPanel ind={ind1d} label="1D · REGIME" />
    </div>
  );
}
