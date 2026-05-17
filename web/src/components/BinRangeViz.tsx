import { useMemo } from "react";
import { Icon } from "./icons";

type Distribution = "spot" | "curve" | "bid-ask";

const BIN_DISTRIBUTIONS: Record<Distribution, (t: number) => number> = {
  spot: (t) => 0.7 + 0.18 * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 23.1),
  curve: (t) => {
    const x = (t - 0.5) * 2;
    return Math.max(0.08, Math.exp(-x * x * 2.2) * (1 + 0.05 * Math.sin(t * 31)));
  },
  "bid-ask": (t) => {
    const x = (t - 0.5) * 2;
    return Math.max(0.12, 0.25 + 0.75 * x * x + 0.04 * Math.sin(t * 27));
  },
};

function priceDecimals(p: number): number {
  const v = Math.abs(p);
  if (!Number.isFinite(v) || v === 0) return 2;
  if (v >= 100) return 2;
  if (v >= 1) return 3;
  if (v >= 0.01) return 4;
  if (v >= 0.0001) return 6;
  return 8;
}

interface PositionBin {
  binId: number;
  x: number;
  y: number;
}

interface Props {
  minBin: number;
  maxBin: number;
  activeBin: number;
  minPrice: number;
  maxPrice: number;
  activePrice: number;
  binStep: number;
  distribution?: Distribution;
  bins?: PositionBin[];
  quoteIsStable?: boolean;
  baseIsStable?: boolean;
  baseSymbol?: string;
  quoteSymbol?: string;
  height?: number;
}

export function BinRangeViz({
  minBin,
  maxBin,
  activeBin,
  minPrice,
  maxPrice,
  activePrice,
  binStep,
  distribution = "curve",
  bins: realBins,
  quoteIsStable = true,
  baseIsStable = false,
  baseSymbol = "SOL",
  quoteSymbol = "USDC",
  height = 96,
}: Props) {
  const inRange = activeBin >= minBin && activeBin <= maxBin;
  const span = maxBin - minBin;
  const pad = Math.max(2, Math.round(span * 0.06));
  const overshoot = inRange
    ? 0
    : Math.abs(activeBin > maxBin ? activeBin - maxBin : minBin - activeBin) + pad;
  const drawMin = (activeBin < minBin ? minBin - overshoot : minBin) - pad;
  const drawMax = (activeBin > maxBin ? maxBin + overshoot : maxBin) + pad;
  const drawSpan = drawMax - drawMin;

  const firstBar = Math.floor(drawMin);
  const lastBar = Math.ceil(drawMax);
  const nBars = lastBar - firstBar + 1;
  const pos = (b: number) => ((b - firstBar + 0.5) / nBars) * 100;

  const dist = BIN_DISTRIBUTIONS[distribution];
  const hasReal = !!realBins && realBins.length > 0;
  const bins = useMemo(() => {
    const out: Array<{ b: number; inPosition: boolean; h: number }> = [];

    if (hasReal) {
      const byBin = new Map<number, PositionBin>();
      for (const rb of realBins!) byBin.set(rb.binId, rb);
      const usdOf = (rb: PositionBin) => {
        if (quoteIsStable) return rb.x * activePrice + rb.y;
        if (baseIsStable) return rb.x + (activePrice > 0 ? rb.y / activePrice : 0);
        return rb.x * activePrice + rb.y;
      };
      let maxUsd = 0;
      for (const rb of realBins!) {
        const u = usdOf(rb);
        if (u > maxUsd) maxUsd = u;
      }
      for (let b = Math.floor(drawMin); b <= Math.ceil(drawMax); b++) {
        const inPosition = b >= minBin && b <= maxBin;
        const rb = byBin.get(b);
        const u = rb ? usdOf(rb) : 0;
        const h = inPosition && maxUsd > 0 ? u / maxUsd : 0;
        out.push({ b, inPosition, h });
      }
      return out;
    }

    for (let b = Math.floor(drawMin); b <= Math.ceil(drawMax); b++) {
      const inPosition = b >= minBin && b <= maxBin;
      const t = inPosition ? (b - minBin) / Math.max(1, maxBin - minBin) : null;
      const h = inPosition && t !== null ? dist(t) : 0;
      out.push({ b, inPosition, h });
    }
    return out;
  }, [drawMin, drawMax, minBin, maxBin, dist, hasReal, realBins, quoteIsStable, baseIsStable, activePrice]);

  const priceTicks = useMemo(() => {
    const n = 5;
    const priceAt = (b: number) => {
      const t = (b - minBin) / Math.max(1, maxBin - minBin);
      return minPrice + (maxPrice - minPrice) * t;
    };
    const arr: Array<{ b: number; p: number }> = [];
    for (let i = 0; i < n; i++) {
      const b = drawMin + (i / (n - 1)) * drawSpan;
      arr.push({ b, p: priceAt(b) });
    }
    return arr;
  }, [drawMin, drawSpan, minPrice, maxPrice, minBin, maxBin]);

  const quoteColor = "var(--blue)";
  const baseColor = "var(--amber)";
  const oorColor = "var(--red)";

  const priceDp = priceDecimals(activePrice || maxPrice || minPrice);

  const activePct = pos(activeBin);
  const tooltipTransform =
    activePct < 14
      ? "translateX(-8px)"
      : activePct > 86
      ? "translateX(calc(-100% + 8px))"
      : "translateX(-50%)";

  return (
    <div style={{ width: "100%" }}>
      {/* legend row */}
      <div className="row" style={{ marginBottom: 14, fontSize: 11 }}>
        <span className="row" style={{ gap: 6, fontFamily: "var(--mono)", color: "var(--fg-1)" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: baseColor }} />
          {baseSymbol}
        </span>
        <span className="row" style={{ gap: 6, marginLeft: 14, fontFamily: "var(--mono)", color: "var(--fg-1)" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: quoteColor }} />
          {quoteSymbol}
        </span>
        <span className="row" style={{ gap: 14, marginLeft: "auto" }}>
          {inRange ? (
            <span className="row" style={{ gap: 6, color: "var(--green)", fontFamily: "var(--mono)", fontSize: 11 }}>
              <span className="dot" style={{ background: "var(--green)" }} /> IN RANGE
            </span>
          ) : (
            <span className="row" style={{ gap: 6, color: "var(--red)", fontFamily: "var(--mono)", fontSize: 11 }}>
              <Icon.warn /> OUT OF RANGE — DRIFTED {activeBin > maxBin ? "UP" : "DOWN"}{" "}
              {Math.abs(activeBin > maxBin ? activeBin - maxBin : minBin - activeBin)} BINS
            </span>
          )}
          <span
            className="row"
            style={{ gap: 6, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)", padding: "3px 8px", border: "1px solid var(--line-2)", background: "var(--bg-2)", borderRadius: 3, cursor: "pointer", letterSpacing: "0.06em" }}
          >
            {quoteSymbol}/{baseSymbol}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.6 }}>
              <path d="M2.5 3.5h5M2.5 3.5l1.5-1.5M2.5 3.5l1.5 1.5M7.5 6.5h-5M7.5 6.5L6 5M7.5 6.5L6 8" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </div>

      {/* Pool-price tooltip — floats above the chart, anchored to active bin */}
      <div style={{ position: "relative", height: 44, marginTop: 4 }}>
        <div
          style={{
            position: "absolute",
            bottom: 4,
            left: `${activePct}%`,
            transform: tooltipTransform,
            background: "var(--bg-0)",
            border: `1px solid ${inRange ? "var(--line-3)" : "var(--red-line)"}`,
            borderRadius: 4,
            padding: "6px 10px",
            fontFamily: "var(--mono)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg-3)" }}>
            Pool Price
          </div>
          <div style={{ fontSize: 12, color: inRange ? "var(--fg-0)" : "var(--red)", marginTop: 1 }}>
            {activePrice.toFixed(priceDp)}{" "}
            <span style={{ color: "var(--fg-3)" }}>{quoteSymbol}/{baseSymbol}</span>
          </div>
        </div>
      </div>

      {/* bars + active marker */}
      <div style={{ position: "relative", height }}>
        {/* baseline */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, background: "var(--line-2)" }} />

        {/* bin bars */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "flex-end", gap: 1, paddingBottom: 1 }}>
          {bins.map(({ b, inPosition, h }) => {
            if (!inPosition) return <div key={b} style={{ flex: 1, height: 0 }} />;
            const isQuote = b < activeBin;
            const color = inRange ? (isQuote ? quoteColor : baseColor) : oorColor;
            return (
              <div
                key={b}
                style={{
                  flex: 1,
                  height: `${Math.max(4, h * (height - 14))}px`,
                  background: color,
                  opacity: inRange ? 0.85 : 0.55,
                  borderRadius: "1.5px 1.5px 0 0",
                }}
              />
            );
          })}
        </div>

        {/* range edge marks */}
        {[minBin, maxBin].map((b, i) => (
          <div
            key={i}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${pos(b)}%`, width: 1, background: "var(--line-2)", opacity: 0.7 }}
          />
        ))}

        {/* active-bin dashed line — full chart height */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${activePct}%`,
            width: 0,
            borderLeft: `1.5px dashed ${inRange ? "var(--fg-1)" : "var(--red)"}`,
            transform: "translateX(-0.75px)",
            pointerEvents: "none",
          }}
        />
      </div>

      {/* price scale */}
      <div style={{ position: "relative", marginTop: 8, height: 18, fontFamily: "var(--mono)", fontSize: 11 }}>
        {priceTicks.map((t, i) => {
          const left = ((t.b - drawMin) / drawSpan) * 100;
          const align =
            i === 0 ? "flex-start" : i === priceTicks.length - 1 ? "flex-end" : "center";
          const transform =
            align === "center" ? "translateX(-50%)" : align === "flex-start" ? "translateX(0)" : "translateX(-100%)";
          return (
            <span
              key={i}
              className="num"
              style={{ position: "absolute", left: `${left}%`, transform, color: "var(--fg-3)" }}
            >
              {t.p.toFixed(priceDp)}
            </span>
          );
        })}
      </div>

      {/* range summary */}
      <div className="row" style={{ marginTop: 12, fontSize: 11, paddingTop: 12, borderTop: "1px dashed var(--line)" }}>
        <span className="label">RANGE</span>
        <span className="num" style={{ color: "var(--fg-2)" }}>
          {minBin} → {maxBin}{" "}
          <span style={{ color: "var(--fg-3)" }}>
            · {maxBin - minBin + 1} BINS · STEP {binStep}BPS · {hasReal ? "ACTUAL" : distribution.toUpperCase()}
          </span>
        </span>
        <span style={{ marginLeft: "auto" }} className="num">
          <span style={{ color: "var(--fg-3)" }}>LOWER ·</span> ${minPrice.toFixed(priceDp)}
          <span style={{ color: "var(--fg-3)", margin: "0 8px" }}>→</span>
          <span style={{ color: "var(--fg-3)" }}>UPPER ·</span> ${maxPrice.toFixed(priceDp)}
        </span>
      </div>
    </div>
  );
}
