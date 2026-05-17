import { useState } from "react";
import { AddressChip, KpiTile } from "../components/atoms";
import { fmt } from "../lib/format";
import { usePnl, usePositionHistory } from "../lib/queries";
import type { PnlReportPosition, PositionEvent } from "../lib/schemas";

function relTime(ms: number | null): string {
  if (ms == null) return "—";
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  const d = Math.floor(sec / 86400);
  return `${d}d ago`;
}

function fmtSigned(v: number, kind: "usd" | "pct"): string {
  const sign = v > 0 ? "+" : "";
  return kind === "usd" ? `${sign}${fmt.usd(v)}` : `${sign}${fmt.pct(v)}`;
}

function fmtSignedSol(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(4)} SOL`;
}

function pnlTone(v: number): "up" | "down" | "neutral" {
  if (v > 0.005) return "up";
  if (v < -0.005) return "down";
  return "neutral";
}

function statusLabel(p: PnlReportPosition): { text: string; color: string } {
  if (p.isClosed) return { text: "CLOSED", color: "var(--fg-3)" };
  if (p.isOutOfRange === true) return { text: "OUT-OF-RANGE", color: "var(--amber)" };
  return { text: "IN-RANGE", color: "var(--green)" };
}

function statusCounts(positions: PnlReportPosition[]): {
  inRange: number;
  outOfRange: number;
  closed: number;
} {
  let inRange = 0;
  let outOfRange = 0;
  let closed = 0;
  for (const p of positions) {
    if (p.isClosed) closed++;
    else if (p.isOutOfRange === true) outOfRange++;
    else inRange++;
  }
  return { inRange, outOfRange, closed };
}

export function Pnl() {
  const { data, isLoading, error } = usePnl();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div
        style={{
          flex: 1,
          padding: "20px 24px 32px",
          overflow: "auto",
          minWidth: 0,
        }}
      >
        <div className="row" style={{ marginBottom: 18 }}>
          <div>
            <div className="label" style={{ marginBottom: 4 }}>
              P&amp;L
            </div>
            <div
              style={{
                fontSize: 18,
                color: "var(--fg-0)",
                fontWeight: 500,
                letterSpacing: "-0.01em",
              }}
            >
              Fees collected + USD PnL vs cost basis
            </div>
          </div>
          {data?.pool && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
              <span className="chip">
                {data.pool.tokenX}/{data.pool.tokenY}
              </span>
              <AddressChip addr={data.pool.address} label="pool" />
              {data.cached && <span className="chip">cached</span>}
            </div>
          )}
        </div>

        {isLoading && (
          <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--fg-2)" }}>
            Loading PnL data from Meteora indexer…
          </div>
        )}

        {error && (
          <div className="card" style={{ padding: 32, color: "var(--red)" }}>
            Failed to load: {(error as Error).message}
          </div>
        )}

        {data?.notIndexed && !isLoading && (
          <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--fg-2)" }}>
            <div style={{ color: "var(--amber)", marginBottom: 8 }}>No LP activity yet</div>
            <div style={{ fontSize: 13 }}>
              Meteora's indexer hasn't seen any deposits/withdrawals/claims for this wallet on the
              configured pool. Open a position via the bot or Meteora app first.
            </div>
          </div>
        )}

        {data && !data.notIndexed && (
          <>
            <div
              className="grid"
              style={{
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 14,
                marginBottom: 14,
              }}
            >
              <KpiTile
                label="PnL vs USDC hold"
                value={fmtSigned(data.total.pnlPctChange, "pct")}
                sub={`${fmtSigned(data.total.pnlUsd, "usd")} since first deposit`}
                delta="profit indicator"
                deltaTone={pnlTone(data.total.pnlUsd)}
                accent={
                  data.total.pnlUsd > 0
                    ? "var(--green)"
                    : data.total.pnlUsd < 0
                      ? "var(--red)"
                      : undefined
                }
              />
              <KpiTile
                label="PnL vs SOL hold"
                value={fmtSigned(data.total.pnlSolPctChange, "pct")}
                sub={`${fmtSignedSol(data.total.pnlSol)} — vs holding all SOL`}
                delta="impermanent loss view"
                deltaTone={pnlTone(data.total.pnlSolPctChange)}
                accent={
                  data.total.pnlSolPctChange > 0
                    ? "var(--green)"
                    : data.total.pnlSolPctChange < 0
                      ? "var(--red)"
                      : undefined
                }
              />
            </div>
            <div
              className="grid"
              style={{
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 14,
                marginBottom: 18,
              }}
            >
              <KpiTile
                label="Fees Collected"
                value={fmt.usd(data.total.feesUsd)}
                sub={`${data.total.feeClaimCount} claim${data.total.feeClaimCount === 1 ? "" : "s"}`}
                delta={`last ${relTime(data.total.lastFeeClaimAt)}`}
                accent="var(--green)"
              />
              <KpiTile
                label="Current Value"
                value={fmt.usd(data.total.currentBalancesUsd)}
                sub={`+${fmt.usd(data.total.unclaimedFeesUsd)} unclaimed`}
              />
              <KpiTile
                label="Deposits / Withdrawals"
                value={fmt.usd(data.total.depositsUsd)}
                sub={`withdrew ${fmt.usd(data.total.withdrawalsUsd)}`}
              />
            </div>

            <div className="card" style={{ padding: 0 }}>
              <div
                className="row"
                style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}
              >
                <span className="label">
                  Positions ({data.positions.length})
                </span>
                {data.positions.length > 0 && (() => {
                  const c = statusCounts(data.positions);
                  return (
                    <span style={{ marginLeft: 12, fontSize: 11, color: "var(--fg-3)" }}>
                      <span style={{ color: "var(--green)" }}>{c.inRange} in-range</span>
                      {"  ·  "}
                      <span style={{ color: "var(--amber)" }}>{c.outOfRange} out</span>
                      {"  ·  "}
                      <span style={{ color: "var(--fg-3)" }}>{c.closed} closed</span>
                    </span>
                  );
                })()}
                {data.pool && (
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-3)" }}>
                    {data.pool.tokenX} ${data.pool.tokenXPrice.toFixed(2)}  ·  {data.pool.tokenY} $
                    {data.pool.tokenYPrice.toFixed(4)}
                  </span>
                )}
              </div>
              {data.positions.length === 0 ? (
                <div style={{ padding: 24, color: "var(--fg-2)", textAlign: "center" }}>
                  No positions recorded for this pool yet.
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th>Status</th>
                      <th>Range</th>
                      <th style={{ textAlign: "right" }}>Deposits</th>
                      <th style={{ textAlign: "right" }}>Withdrawals</th>
                      <th style={{ textAlign: "right" }}>Fees</th>
                      <th style={{ textAlign: "right" }}>Current</th>
                      <th style={{ textAlign: "right" }}>vs USDC</th>
                      <th style={{ textAlign: "right" }}>vs SOL</th>
                      <th style={{ textAlign: "right" }}>Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p) => {
                      const status = statusLabel(p);
                      const tone = pnlTone(p.pnlUsd);
                      return (
                        <tr
                          key={p.positionAddress}
                          onClick={() => setSelected(p.positionAddress)}
                          style={{
                            cursor: "pointer",
                            background:
                              selected === p.positionAddress ? "var(--bg-2)" : undefined,
                          }}
                        >
                          <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                            {fmt.addr(p.positionAddress)}
                          </td>
                          <td style={{ color: status.color, fontSize: 11 }}>{status.text}</td>
                          <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                            ${p.minPrice.toFixed(2)}–${p.maxPrice.toFixed(2)}
                          </td>
                          <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
                            {fmt.usd(p.depositsUsd)}
                          </td>
                          <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
                            {fmt.usd(p.withdrawalsUsd)}
                          </td>
                          <td
                            style={{
                              textAlign: "right",
                              fontFamily: "var(--mono)",
                              color: "var(--green)",
                            }}
                          >
                            {fmt.usd(p.feesUsd)}
                          </td>
                          <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>
                            {p.currentBalancesUsd != null ? fmt.usd(p.currentBalancesUsd) : "—"}
                          </td>
                          <td
                            style={{
                              textAlign: "right",
                              fontFamily: "var(--mono)",
                              color:
                                tone === "up"
                                  ? "var(--green)"
                                  : tone === "down"
                                    ? "var(--red)"
                                    : "var(--fg-2)",
                            }}
                          >
                            {fmtSigned(p.pnlUsd, "usd")}{" "}
                            <span style={{ fontSize: 10, color: "var(--fg-3)" }}>
                              ({fmtSigned(p.pnlPctChange, "pct")})
                            </span>
                          </td>
                          <td
                            style={{
                              textAlign: "right",
                              fontFamily: "var(--mono)",
                              color:
                                p.pnlSolPctChange == null
                                  ? "var(--fg-3)"
                                  : p.pnlSolPctChange > 0.005
                                    ? "var(--green)"
                                    : p.pnlSolPctChange < -0.005
                                      ? "var(--red)"
                                      : "var(--fg-2)",
                            }}
                          >
                            {p.pnlSolPctChange == null
                              ? "—"
                              : fmtSigned(p.pnlSolPctChange, "pct")}
                            {p.pnlSol != null && (
                              <span style={{ fontSize: 10, color: "var(--fg-3)" }}>
                                {" "}({p.pnlSol.toFixed(3)})
                              </span>
                            )}
                          </td>
                          <td
                            style={{ textAlign: "right", fontSize: 11, color: "var(--fg-3)" }}
                          >
                            {relTime(p.createdAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      {selected && (
        <PositionDrawer
          positionAddress={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function PositionDrawer({
  positionAddress,
  onClose,
}: {
  positionAddress: string;
  onClose: () => void;
}) {
  const { data, isLoading } = usePositionHistory(positionAddress);
  const events = data?.events ?? [];
  return (
    <aside
      style={{
        width: 460,
        borderLeft: "1px solid var(--line)",
        background: "var(--bg-1)",
        padding: "20px 18px",
        overflow: "auto",
      }}
    >
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <div className="label">Event history</div>
          <AddressChip addr={positionAddress} />
        </div>
        <button
          className="btn"
          style={{ marginLeft: "auto" }}
          onClick={onClose}
        >
          close
        </button>
      </div>
      {isLoading && (
        <div style={{ color: "var(--fg-2)" }}>Loading event log…</div>
      )}
      {!isLoading && events.length === 0 && (
        <div style={{ color: "var(--fg-2)" }}>No events.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {events.map((e) => (
          <EventRow key={`${e.signature}-${e.ixIndex}`} event={e} />
        ))}
      </div>
    </aside>
  );
}

function EventRow({ event: e }: { event: PositionEvent }) {
  const at = e.blockTime * 1000;
  const total = parseFloat(e.totalUsd);
  const kindColor = e.eventType.toLowerCase().includes("claim")
    ? "var(--green)"
    : e.eventType.toLowerCase().includes("deposit")
      ? "var(--fg-0)"
      : "var(--amber)";
  return (
    <div
      className="card"
      style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div className="row">
        <span style={{ color: kindColor, fontWeight: 500, fontSize: 12 }}>
          {e.eventType.toUpperCase()}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fg-3)",
          }}
        >
          {relTime(at)}
        </span>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)" }}>
        X {parseFloat(e.amountX).toFixed(4)} (${parseFloat(e.amountXUsd).toFixed(2)}) · Y{" "}
        {parseFloat(e.amountY).toFixed(2)} (${parseFloat(e.amountYUsd).toFixed(2)})
      </div>
      <div className="row" style={{ fontSize: 11 }}>
        <span style={{ color: "var(--fg-3)" }}>total ${total.toFixed(2)}</span>
        <a
          href={`https://solscan.io/tx/${e.signature}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginLeft: "auto", color: "var(--fg-2)", fontSize: 11 }}
        >
          {fmt.addr(e.signature)} ↗
        </a>
      </div>
    </div>
  );
}
