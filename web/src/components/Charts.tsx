import { useMemo } from "react";
import type { Candle, BBPoint, MacdPoint } from "../lib/types";

interface CandleProps {
  candles: Candle[];
  width?: number;
  height?: number;
  range?: { minPrice: number; maxPrice: number; activePrice: number };
  ema20?: number[];
  ema50?: number[];
  bb?: BBPoint[];
  showAxes?: boolean;
  padding?: { l: number; r: number; t: number; b: number };
}

export function CandleChart({
  candles,
  width = 800,
  height = 240,
  range,
  ema20,
  ema50,
  bb,
  showAxes = true,
  padding = { l: 56, r: 8, t: 8, b: 22 },
}: CandleProps) {
  const inner = {
    w: width - padding.l - padding.r,
    h: height - padding.t - padding.b,
  };
  const allHi = candles.map((c) => c.h);
  const allLo = candles.map((c) => c.l);
  let lo = Math.min(...allLo);
  let hi = Math.max(...allHi);
  if (range) {
    lo = Math.min(lo, range.minPrice);
    hi = Math.max(hi, range.maxPrice);
  }
  if (bb) {
    lo = Math.min(lo, ...bb.map((p) => p.lo));
    hi = Math.max(hi, ...bb.map((p) => p.hi));
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const yScale = (p: number) => padding.t + ((hi - p) / (hi - lo)) * inner.h;
  const xScale = (i: number) =>
    padding.l + (i / Math.max(candles.length - 1, 1)) * inner.w;
  const cw = Math.max(2, (inner.w / candles.length) * 0.55);

  const yTicks = useMemo(() => {
    const n = 5;
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n);
    return out;
  }, [lo, hi]);

  const xTicks = useMemo(() => {
    const n = Math.min(6, candles.length - 1);
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(Math.round((i / n) * (candles.length - 1)));
    return out;
  }, [candles.length]);

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {showAxes &&
        yTicks.map((p, i) => (
          <g key={i}>
            <line
              x1={padding.l}
              x2={width - padding.r}
              y1={yScale(p)}
              y2={yScale(p)}
              stroke="var(--line)"
              strokeDasharray={i === 0 || i === yTicks.length - 1 ? "" : "1 3"}
            />
            <text
              x={padding.l - 8}
              y={yScale(p) + 3}
              textAnchor="end"
              fill="var(--fg-3)"
              fontSize="10"
              fontFamily="var(--mono)"
            >
              {p.toFixed(2)}
            </text>
          </g>
        ))}

      {range && (
        <g>
          <rect
            x={padding.l}
            y={yScale(range.maxPrice)}
            width={inner.w}
            height={yScale(range.minPrice) - yScale(range.maxPrice)}
            fill="rgba(212,160,86,0.07)"
            stroke="var(--amber-line)"
            strokeDasharray="2 2"
            strokeWidth="0.7"
          />
          <line
            x1={padding.l}
            x2={width - padding.r}
            y1={yScale(range.activePrice)}
            y2={yScale(range.activePrice)}
            stroke="var(--amber)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <text
            x={width - padding.r - 4}
            y={yScale(range.activePrice) - 4}
            fill="var(--amber)"
            fontSize="10"
            fontFamily="var(--mono)"
            textAnchor="end"
          >
            ACTIVE {range.activePrice.toFixed(2)}
          </text>
        </g>
      )}

      {bb && (
        <g>
          <path
            d={
              "M " +
              bb.map((p, i) => `${xScale(i)},${yScale(p.hi)}`).join(" L ") +
              " L " +
              bb
                .slice()
                .reverse()
                .map((p, i) => `${xScale(bb.length - 1 - i)},${yScale(p.lo)}`)
                .join(" L ") +
              " Z"
            }
            fill="rgba(123,160,217,0.06)"
            stroke="rgba(123,160,217,0.25)"
            strokeWidth="0.6"
          />
          <polyline
            points={bb.map((p, i) => `${xScale(i)},${yScale(p.mid)}`).join(" ")}
            fill="none"
            stroke="rgba(123,160,217,0.45)"
            strokeWidth="0.8"
            strokeDasharray="2 2"
          />
        </g>
      )}

      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const x = xScale(i);
        const yO = yScale(c.o);
        const yC = yScale(c.c);
        const yH = yScale(c.h);
        const yL = yScale(c.l);
        const col = up ? "var(--green)" : "var(--red)";
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yH} y2={yL} stroke={col} strokeWidth="0.8" />
            <rect
              x={x - cw / 2}
              y={Math.min(yO, yC)}
              width={cw}
              height={Math.max(1, Math.abs(yO - yC))}
              fill={up ? "var(--candle-up-fill)" : col}
              stroke={col}
              strokeWidth="0.8"
            />
          </g>
        );
      })}

      {ema20 && (
        <polyline
          points={ema20.map((p, i) => `${xScale(i)},${yScale(p)}`).join(" ")}
          fill="none"
          stroke="var(--amber)"
          strokeWidth="1.1"
          opacity="0.85"
        />
      )}
      {ema50 && (
        <polyline
          points={ema50.map((p, i) => `${xScale(i)},${yScale(p)}`).join(" ")}
          fill="none"
          stroke="var(--purple)"
          strokeWidth="1.1"
          opacity="0.8"
        />
      )}

      {showAxes &&
        xTicks.map((idx, i) => {
          const c = candles[idx];
          if (!c || !c.label) return null;
          return (
            <text
              key={i}
              x={xScale(idx)}
              y={height - 6}
              fill="var(--fg-3)"
              fontSize="10"
              fontFamily="var(--mono)"
              textAnchor="middle"
            >
              {c.label}
            </text>
          );
        })}
    </svg>
  );
}

interface SubchartPad {
  padding?: { l: number; r: number; t: number; b: number };
}

export function RsiChart({
  data,
  width = 800,
  height = 70,
  padding = { l: 56, r: 8, t: 6, b: 14 },
}: { data: number[]; width?: number; height?: number } & SubchartPad) {
  const inner = { w: width - padding.l - padding.r, h: height - padding.t - padding.b };
  const xScale = (i: number) =>
    padding.l + (i / Math.max(data.length - 1, 1)) * inner.w;
  const yScale = (v: number) => padding.t + ((100 - v) / 100) * inner.h;
  const last = data[data.length - 1] ?? 50;
  const tone = last > 70 ? "var(--red)" : last < 30 ? "var(--green)" : "var(--fg-1)";
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <rect
        x={padding.l}
        y={yScale(70)}
        width={inner.w}
        height={yScale(30) - yScale(70)}
        fill="var(--bg-2)"
        opacity="0.4"
      />
      {[30, 50, 70].map((v, i) => (
        <g key={i}>
          <line
            x1={padding.l}
            x2={width - padding.r}
            y1={yScale(v)}
            y2={yScale(v)}
            stroke={v === 50 ? "var(--line)" : "var(--line-2)"}
            strokeDasharray={v === 50 ? "1 3" : ""}
          />
          <text
            x={padding.l - 8}
            y={yScale(v) + 3}
            textAnchor="end"
            fill="var(--fg-3)"
            fontSize="9"
            fontFamily="var(--mono)"
          >
            {v}
          </text>
        </g>
      ))}
      <polyline
        points={data.map((v, i) => `${xScale(i)},${yScale(v)}`).join(" ")}
        fill="none"
        stroke={tone}
        strokeWidth="1.1"
      />
      <text
        x={padding.l + 6}
        y={padding.t + 10}
        fill="var(--fg-3)"
        fontSize="9.5"
        fontFamily="var(--mono)"
        letterSpacing="0.15em"
      >
        RSI 14 · <tspan fill={tone}>{last.toFixed(1)}</tspan>
      </text>
    </svg>
  );
}

export function MacdChart({
  data,
  width = 800,
  height = 70,
  padding = { l: 56, r: 8, t: 6, b: 14 },
}: { data: MacdPoint[]; width?: number; height?: number } & SubchartPad) {
  const inner = { w: width - padding.l - padding.r, h: height - padding.t - padding.b };
  const all = data.flatMap((d) => [d.macd, d.signal, d.hist]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.1;
  const yScale = (v: number) => padding.t + ((hi + pad - v) / (hi - lo + 2 * pad)) * inner.h;
  const xScale = (i: number) =>
    padding.l + (i / Math.max(data.length - 1, 1)) * inner.w;
  const zero = yScale(0);
  const bw = Math.max(1, (inner.w / data.length) * 0.6);
  const last = data[data.length - 1] ?? { macd: 0, signal: 0, hist: 0 };
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <line x1={padding.l} x2={width - padding.r} y1={zero} y2={zero} stroke="var(--line-2)" />
      {data.map((d, i) => (
        <rect
          key={i}
          x={xScale(i) - bw / 2}
          y={Math.min(yScale(0), yScale(d.hist))}
          width={bw}
          height={Math.max(1, Math.abs(yScale(0) - yScale(d.hist)))}
          fill={d.hist >= 0 ? "var(--green)" : "var(--red)"}
          opacity="0.7"
        />
      ))}
      <polyline
        points={data.map((d, i) => `${xScale(i)},${yScale(d.macd)}`).join(" ")}
        fill="none"
        stroke="var(--amber)"
        strokeWidth="1.1"
      />
      <polyline
        points={data.map((d, i) => `${xScale(i)},${yScale(d.signal)}`).join(" ")}
        fill="none"
        stroke="var(--purple)"
        strokeWidth="1"
        strokeDasharray="2 2"
      />
      <text
        x={padding.l + 6}
        y={padding.t + 10}
        fill="var(--fg-3)"
        fontSize="9.5"
        fontFamily="var(--mono)"
        letterSpacing="0.15em"
      >
        MACD · <tspan fill="var(--amber)">{last.macd.toFixed(2)}</tspan>{" "}
        <tspan fill="var(--purple)"> sig {last.signal.toFixed(2)}</tspan>
      </text>
    </svg>
  );
}
