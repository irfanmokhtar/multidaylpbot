import { useState } from "react";
import { ActionPill, AddressChip, ConfBar, KpiTile } from "../components/atoms";
import { BinRangeViz } from "../components/BinRangeViz";
import { CandleChart } from "../components/Charts";
import { Icon } from "../components/icons";
import { fmt } from "../lib/format";
import {
  useDecisions,
  useOhlcv,
  usePool,
  useStatus,
} from "../lib/queries";
import { CANDLES_4H } from "../lib/mocks";
import type { PortfolioSnapshot, PositionSummary } from "../lib/schemas";

function positionValueUsd(snap: PortfolioSnapshot, p: PositionSummary): number | null {
  const price = parseFloat(snap.activeBinPrice);
  if (!Number.isFinite(price)) return null;
  if (snap.tokenY.isStablecoin) {
    return (p.totalX + p.feeX) * price + (p.totalY + p.feeY);
  }
  if (snap.tokenX.isStablecoin) {
    return p.totalX + p.feeX + (p.totalY + p.feeY) / price;
  }
  return null;
}

function feesUsd(snap: PortfolioSnapshot, p: PositionSummary): number | null {
  const price = parseFloat(snap.activeBinPrice);
  if (!Number.isFinite(price)) return null;
  if (snap.tokenY.isStablecoin) return p.feeX * price + p.feeY;
  if (snap.tokenX.isStablecoin) return p.feeX + p.feeY / price;
  return null;
}

function binPrice(binId: number, binStep: number): number {
  // price = (1 + binStep/10000) ^ binId — same approximation Meteora uses
  return Math.pow(1 + binStep / 10000, binId);
}

export function Overview() {
  const [showFullReasoning, setShowFullReasoning] = useState(false);

  const { data: status, isLoading: statusLoading } = useStatus();
  const { data: pool } = usePool();
  const { data: decisionsPage } = useDecisions(1);
  const { data: ohlcv4h } = useOhlcv("4H");
  const lastDecision = decisionsPage?.rows[0] ?? null;

  const candles4h = ohlcv4h?.candles
    ? ohlcv4h.candles.map((c, i, arr) => ({
        o: c.o, h: c.h, l: c.l, c: c.c,
        label: i % 16 === 0 ? `D-${Math.round((arr.length - i) / 6)}` : null,
      }))
    : CANDLES_4H;

  if (statusLoading || !status) {
    return (
      <div style={{ padding: 32, color: "var(--fg-3)", fontFamily: "var(--mono)" }}>
        Loading status…
      </div>
    );
  }

  const snap = status.snapshot;
  const position = snap.positions[0] ?? null;
  const xSym = snap.tokenX.symbol;
  const ySym = snap.tokenY.symbol;
  const activePrice = parseFloat(snap.activeBinPrice);
  const inRange = position ? position.inRange : false;
  const positionValue = position ? positionValueUsd(snap, position) : null;
  const positionFees = position ? feesUsd(snap, position) : null;

  const minPrice = position ? binPrice(position.lowerBinId, snap.binStep) : 0;
  const maxPrice = position ? binPrice(position.upperBinId, snap.binStep) : 0;

  const reasoning = lastDecision?.decision.reasoning ?? "";
  const truncated =
    reasoning.length > 200 ? reasoning.slice(0, 200) + "…" : reasoning;
  const display = showFullReasoning ? reasoning : truncated;

  const decisionAgeMin = lastDecision
    ? Math.round((Date.now() - lastDecision.decidedAt) / 60_000)
    : null;

  return (
    <div style={{ padding: "20px 24px 32px", maxWidth: 1400, margin: "0 auto" }}>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <div className="label" style={{ marginBottom: 4 }}>
            OVERVIEW
          </div>
          <div
            style={{
              fontSize: 18,
              color: "var(--fg-0)",
              fontWeight: 500,
              letterSpacing: "-0.01em",
            }}
          >
            Position health and the latest LLM decision
          </div>
        </div>
        <div style={{ marginLeft: "auto" }} className="row">
          <span className="chip">
            <Icon.refresh /> Refresh
          </span>
          <span className="chip on">
            <span className="dot live" /> LIVE
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <KpiTile
          label="Position Value"
          value={
            <span>
              {positionValue != null ? (
                <>
                  <span style={{ color: "var(--fg-3)", fontSize: 15 }}>$</span>
                  {fmt.num(positionValue, 2)}
                </>
              ) : (
                <span style={{ color: "var(--fg-3)" }}>—</span>
              )}
            </span>
          }
          sub={
            position
              ? `${fmt.num(position.totalX, 4)} ${xSym} · ${fmt.num(position.totalY, 2)} ${ySym}`
              : "no open position"
          }
        />
        <KpiTile
          label="Fees Accrued"
          value={
            <span>
              {positionFees != null ? (
                <>
                  <span style={{ color: "var(--fg-3)", fontSize: 15 }}>$</span>
                  {fmt.num(positionFees, 2)}
                </>
              ) : (
                <span style={{ color: "var(--fg-3)" }}>—</span>
              )}
            </span>
          }
          sub={
            position
              ? `${fmt.num(position.feeX, 6)} ${xSym} · ${fmt.num(position.feeY, 4)} ${ySym}`
              : "—"
          }
        />
        <KpiTile
          label="Range Status"
          value={
            position ? (
              <span
                style={{
                  color: inRange ? "var(--green)" : "var(--red)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  className="dot"
                  style={{
                    background: inRange ? "var(--green)" : "var(--red)",
                    width: 9,
                    height: 9,
                  }}
                />
                {inRange ? "IN RANGE" : "OUT OF RANGE"}
              </span>
            ) : (
              <span style={{ color: "var(--fg-3)" }}>NO POSITION</span>
            )
          }
          sub={
            position
              ? `Active bin ${snap.activeBinId} · width ${position.width} bins`
              : "open one to see range"
          }
        />
        <KpiTile
          label="Last Decision"
          value={
            lastDecision ? (
              <span>
                <span className="num">{decisionAgeMin}</span>
                <span style={{ color: "var(--fg-3)", fontSize: 15, marginLeft: 4 }}>
                  min ago
                </span>
              </span>
            ) : (
              <span style={{ color: "var(--fg-3)" }}>—</span>
            )
          }
          sub={
            lastDecision
              ? `${lastDecision.cycle} · cycle #${lastDecision.id} · ${lastDecision.model}`
              : "no decisions yet"
          }
        />
      </div>

      {position && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-h">
            <span className="card-h-title">Position Range</span>
            <span className="card-h-sub">DLMM · {snap.binStep}BPS BIN</span>
            <span style={{ marginLeft: "auto" }}>
              <AddressChip addr={position.publicKey} label="POSITION" />
            </span>
          </div>
          <div className="card-b" style={{ paddingTop: 24, paddingBottom: 24 }}>
            <BinRangeViz
              minBin={position.lowerBinId}
              maxBin={position.upperBinId}
              activeBin={snap.activeBinId}
              minPrice={minPrice}
              maxPrice={maxPrice}
              activePrice={Number.isFinite(activePrice) ? activePrice : 0}
              binStep={snap.binStep}
              bins={position.bins}
              quoteIsStable={snap.tokenY.isStablecoin}
              baseIsStable={snap.tokenX.isStablecoin}
              baseSymbol={xSym}
              quoteSymbol={ySym}
            />
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div className="card">
          <div className="card-h">
            <span className="card-h-title">Last Decision</span>
            <span className="card-h-sub">
              {lastDecision
                ? `CYCLE #${lastDecision.id} · ${lastDecision.cycle.toUpperCase()} · ${decisionAgeMin}M AGO`
                : "NO DECISIONS YET"}
            </span>
          </div>
          <div className="card-b">
            {lastDecision ? (
              <>
                <div className="row" style={{ marginBottom: 14, gap: 14 }}>
                  <ActionPill action={lastDecision.action} />
                  <div className="col" style={{ gap: 4 }}>
                    <span className="label">CONFIDENCE</span>
                    <ConfBar value={lastDecision.confidence} width={140} />
                  </div>
                  {lastDecision.decision.keyLevels?.support != null && (
                    <div className="col" style={{ gap: 4, marginLeft: 28 }}>
                      <span className="label">SUPPORT</span>
                      <span
                        className="num"
                        style={{ fontSize: 13, color: "var(--fg-1)" }}
                      >
                        ${lastDecision.decision.keyLevels.support.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {lastDecision.decision.keyLevels?.resistance != null && (
                    <div className="col" style={{ gap: 4 }}>
                      <span className="label">RESISTANCE</span>
                      <span
                        className="num"
                        style={{ fontSize: 13, color: "var(--fg-1)" }}
                      >
                        ${lastDecision.decision.keyLevels.resistance.toFixed(2)}
                      </span>
                    </div>
                  )}
                  <div className="col" style={{ gap: 4, marginLeft: "auto" }}>
                    <span className="label">MODEL</span>
                    <span
                      className="num"
                      style={{ fontSize: 11, color: "var(--fg-2)" }}
                    >
                      {lastDecision.model}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    fontSize: 13.5,
                    lineHeight: 1.62,
                    color: "var(--fg-1)",
                    background: "var(--bg-2)",
                    border: "1px solid var(--line)",
                    borderLeft: "2px solid var(--amber)",
                    borderRadius: 3,
                    padding: "12px 14px",
                    fontFamily: "var(--sans)",
                    textWrap: "pretty",
                  }}
                >
                  {display}
                  {reasoning.length > 200 && (
                    <button
                      onClick={() => setShowFullReasoning((v) => !v)}
                      style={{
                        marginLeft: 6,
                        color: "var(--amber)",
                        fontSize: 12,
                        fontFamily: "var(--mono)",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {showFullReasoning ? "show less" : "show more →"}
                    </button>
                  )}
                </div>

                <div
                  className="row"
                  style={{
                    marginTop: 14,
                    fontSize: 11,
                    color: "var(--fg-3)",
                    fontFamily: "var(--mono)",
                  }}
                >
                  <span>{lastDecision.provider}</span>
                  <span>·</span>
                  <span>{lastDecision.cycle}</span>
                  <span style={{ marginLeft: "auto" }}>
                    persisted decision_id #{lastDecision.id}
                  </span>
                </div>
              </>
            ) : (
              <div
                style={{
                  color: "var(--fg-3)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  padding: "24px 0",
                  textAlign: "center",
                }}
              >
                Run /decide in Telegram or wait for the next scheduled cycle.
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <span className="card-h-title">Pool Vitals</span>
            <span className="card-h-sub">METEORA API</span>
          </div>
          <div className="card-b" style={{ padding: 0 }}>
            {pool ? (
              [
                { k: "TVL", v: fmt.usd(pool.tvlUsd, 0) },
                { k: "APR (24h)", v: fmt.pct(pool.apr, 2) },
                { k: "Fee / TVL (24h)", v: fmt.pct(pool.feeTvlRatio24hPct, 2) },
                { k: "Volume (24h)", v: fmt.usd(pool.volume24hUsd, 0) },
                { k: "Fees (24h)", v: fmt.usd(pool.fees24hUsd, 2) },
                { k: "Bin Step", v: `${pool.binStep} bps` },
              ].map((r, i, arr) => (
                <div
                  key={i}
                  className="row"
                  style={{
                    padding: "10px 16px",
                    borderBottom:
                      i < arr.length - 1 ? "1px solid var(--line)" : "none",
                  }}
                >
                  <span className="label">{r.k}</span>
                  <span style={{ marginLeft: "auto", textAlign: "right" }}>
                    <div className="num" style={{ color: "var(--fg-0)", fontSize: 13 }}>
                      {r.v}
                    </div>
                  </span>
                </div>
              ))
            ) : (
              <div
                style={{
                  padding: 32,
                  color: "var(--fg-3)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  textAlign: "center",
                }}
              >
                pool metadata unavailable
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <span className="card-h-title">Price · 4H · last 100 candles</span>
          <span className="card-h-sub">SOURCE BIRDEYE · OHLCV</span>
          <span style={{ marginLeft: "auto" }} className="row">
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 14, height: 1, background: "var(--amber)", borderTop: "1px dashed var(--amber)" }} />
              <span className="label" style={{ letterSpacing: "0.1em" }}>
                RANGE
              </span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 14, height: 1, background: "transparent", borderTop: "1px dashed var(--amber)" }} />
              <span className="label" style={{ letterSpacing: "0.1em" }}>
                ACTIVE BIN
              </span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 8, height: 8, background: "var(--green)" }} />
              <span className="label" style={{ letterSpacing: "0.1em" }}>
                UP
              </span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 8, height: 8, background: "var(--red)" }} />
              <span className="label" style={{ letterSpacing: "0.1em" }}>
                DOWN
              </span>
            </span>
          </span>
        </div>
        <div className="card-b" style={{ overflow: "hidden" }}>
          <CandleChart
            candles={candles4h}
            width={1336}
            height={260}
            range={
              position && Number.isFinite(activePrice)
                ? {
                    minPrice,
                    maxPrice,
                    activePrice,
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
