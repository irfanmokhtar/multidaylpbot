import { useMemo, useState } from "react";
import { ActionPill, ConfBar } from "../components/atoms";
import { Icon } from "../components/icons";
import { useDecision, useDecisions } from "../lib/queries";
import type { Action, CycleType } from "../lib/types";
import type { DecisionRow } from "../lib/schemas";

const ACTION_FILTERS: Array<[Action | "all", string]> = [
  ["all", "All"],
  ["hold", "Hold"],
  ["rebalance", "Rebalance"],
  ["claim_fees", "Claim"],
  ["pause", "Pause"],
];

const CYCLE_FILTERS: Array<[CycleType | "all", string]> = [
  ["all", "All"],
  ["daily", "Daily"],
  ["intraday", "Intraday"],
  ["ad_hoc", "Ad hoc"],
];

function relTime(ms: number): string {
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  const d = Math.floor(sec / 86400);
  const h = Math.round((sec - d * 86400) / 3600);
  return h > 0 ? `${d}d ${h}h ago` : `${d}d ago`;
}

function absTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toISOString().slice(11, 19);
  const md = d.toUTCString().slice(5, 11);
  return `${time} UTC · ${md.trim()}`;
}

export function Decisions() {
  const [selected, setSelected] = useState<number | null>(null);
  const [actionFilter, setActionFilter] = useState<Action | "all">("all");
  const [cycleFilter, setCycleFilter] = useState<CycleType | "all">("all");
  const [search, setSearch] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  const { data: page, isLoading } = useDecisions(10);
  const rows: DecisionRow[] = page?.rows ?? [];

  // Auto-select most recent on first load.
  const effectiveSelected =
    selected != null ? selected : (rows[0]?.id ?? null);

  const { data: detail } = useDecision(effectiveSelected);

  const filtered = useMemo(
    () =>
      rows.filter(
        (d) =>
          (actionFilter === "all" || d.action === actionFilter) &&
          (cycleFilter === "all" || d.cycle === cycleFilter) &&
          (search === "" ||
            d.decision.reasoning.toLowerCase().includes(search.toLowerCase())),
      ),
    [rows, actionFilter, cycleFilter, search],
  );

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
              DECISIONS
            </div>
            <div
              style={{
                fontSize: 18,
                color: "var(--fg-0)",
                fontWeight: 500,
                letterSpacing: "-0.01em",
              }}
            >
              Every LLM decision · {filtered.length} of {rows.length} shown
            </div>
          </div>
          <div className="search" style={{ marginLeft: "auto" }}>
            <Icon.search />
            <input
              placeholder="Search reasoning…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="search-kbd">⌘K</span>
          </div>
        </div>

        <div className="row" style={{ marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <span className="label" style={{ marginRight: 4 }}>
            ACTION
          </span>
          {ACTION_FILTERS.map(([k, l]) => (
            <button
              key={k}
              className={`chip ${actionFilter === k ? "on" : ""}`}
              onClick={() => setActionFilter(k)}
            >
              {l}{" "}
              <span className="chip-count">
                {k === "all"
                  ? rows.length
                  : rows.filter((d) => d.action === k).length}
              </span>
            </button>
          ))}
          <span
            style={{
              width: 1,
              height: 18,
              background: "var(--line-2)",
              margin: "0 6px",
            }}
          />
          <span className="label" style={{ marginRight: 4 }}>
            CYCLE
          </span>
          {CYCLE_FILTERS.map(([k, l]) => (
            <button
              key={k}
              className={`chip ${cycleFilter === k ? "on" : ""}`}
              onClick={() => setCycleFilter(k)}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>Time</th>
                <th>Cycle</th>
                <th>Action</th>
                <th>Confidence</th>
                <th>Model</th>
                <th className="r" style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      textAlign: "center",
                      color: "var(--fg-3)",
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      padding: 32,
                    }}
                  >
                    {isLoading ? "loading…" : "no decisions match the current filter"}
                  </td>
                </tr>
              )}
              {filtered.map((d) => (
                <tr
                  key={d.id}
                  className={effectiveSelected === d.id ? "sel" : ""}
                  onClick={() => setSelected(d.id)}
                >
                  <td className="num" style={{ color: "var(--fg-3)", fontSize: 11 }}>
                    {d.id}
                  </td>
                  <td>
                    <div className="num" style={{ color: "var(--fg-1)", fontSize: 13 }}>
                      {relTime(d.decidedAt)}
                    </div>
                    <div
                      className="num"
                      style={{ color: "var(--fg-3)", fontSize: 10.5, marginTop: 2 }}
                    >
                      {absTime(d.decidedAt)}
                    </div>
                  </td>
                  <td>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: "var(--fg-2)",
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                      }}
                    >
                      {d.cycle === "ad_hoc" ? "ad hoc" : d.cycle}
                    </span>
                  </td>
                  <td>
                    <ActionPill action={d.action} />
                  </td>
                  <td>
                    <ConfBar value={d.confidence} width={120} />
                  </td>
                  <td className="num" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                    {d.model}
                  </td>
                  <td className="r" style={{ color: "var(--fg-3)" }}>
                    <Icon.chev
                      style={{
                        transform: effectiveSelected === d.id ? "rotate(90deg)" : "",
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <DecisionDrawer
          row={detail}
          showRaw={showRaw}
          setShowRaw={setShowRaw}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

interface DrawerProps {
  row: DecisionRow;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  onClose: () => void;
}

function DecisionDrawer({ row, showRaw, setShowRaw, onClose }: DrawerProps) {
  const { decision, input } = row;
  const isRebalance = row.action === "rebalance";
  return (
    <aside
      style={{
        width: 460,
        flexShrink: 0,
        background: "var(--bg-1)",
        borderLeft: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        boxShadow: "var(--drawer-shadow)",
      }}
    >
      <div
        className="row"
        style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}
      >
        <div className="col">
          <div className="label">DECISION #{row.id}</div>
          <div
            className="num"
            style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 4 }}
          >
            {absTime(row.decidedAt)}
          </div>
        </div>
        <button
          className="chip"
          style={{ marginLeft: "auto", padding: "5px 8px" }}
          onClick={onClose}
        >
          <Icon.x />
        </button>
      </div>

      <div className="drawer-body" style={{ padding: 18, overflow: "auto", flex: 1 }}>
        <div className="row" style={{ gap: 10, marginBottom: 14 }}>
          <ActionPill action={row.action} />
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fg-2)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            {row.cycle === "ad_hoc" ? "ad hoc" : row.cycle} cycle
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: 12,
            }}
          >
            <div className="label" style={{ marginBottom: 8 }}>
              CONFIDENCE
            </div>
            <div className="row" style={{ gap: 10 }}>
              <span className="num" style={{ fontSize: 18, color: "var(--fg-0)" }}>
                {(row.confidence * 100).toFixed(0)}
                <span style={{ fontSize: 12, color: "var(--fg-3)" }}>%</span>
              </span>
              <ConfBar value={row.confidence} width={100} showNum={false} />
            </div>
          </div>
          <div
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: 12,
            }}
          >
            <div className="label" style={{ marginBottom: 8 }}>
              MODEL
            </div>
            <div className="num" style={{ fontSize: 12, color: "var(--fg-1)" }}>
              {row.model}
            </div>
            <div
              className="num"
              style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 4 }}
            >
              provider: {row.provider}
            </div>
          </div>
        </div>

        <div className="label" style={{ marginBottom: 8 }}>
          REASONING
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.65,
            color: "var(--fg-1)",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderLeft: "2px solid var(--amber)",
            borderRadius: 3,
            padding: "12px 14px",
            marginBottom: 16,
            textWrap: "pretty",
          }}
        >
          {decision.reasoning}
        </div>

        {decision.keyLevels &&
          (decision.keyLevels.support != null ||
            decision.keyLevels.resistance != null) && (
            <>
              <div className="label" style={{ marginBottom: 8 }}>
                KEY LEVELS
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    background: "var(--bg-2)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    padding: 12,
                  }}
                >
                  <div
                    className="num"
                    style={{
                      fontSize: 10.5,
                      color: "var(--green)",
                      letterSpacing: "0.16em",
                    }}
                  >
                    SUPPORT
                  </div>
                  <div
                    className="num"
                    style={{ fontSize: 16, color: "var(--fg-0)", marginTop: 4 }}
                  >
                    {decision.keyLevels.support != null
                      ? `$${decision.keyLevels.support.toFixed(2)}`
                      : "—"}
                  </div>
                </div>
                <div
                  style={{
                    background: "var(--bg-2)",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                    padding: 12,
                  }}
                >
                  <div
                    className="num"
                    style={{
                      fontSize: 10.5,
                      color: "var(--red)",
                      letterSpacing: "0.16em",
                    }}
                  >
                    RESISTANCE
                  </div>
                  <div
                    className="num"
                    style={{ fontSize: 16, color: "var(--fg-0)", marginTop: 4 }}
                  >
                    {decision.keyLevels.resistance != null
                      ? `$${decision.keyLevels.resistance.toFixed(2)}`
                      : "—"}
                  </div>
                </div>
              </div>
            </>
          )}

        {isRebalance &&
          (decision.strategyType ||
            decision.lowerBoundPrice != null ||
            decision.rangeWidthBins != null) && (
            <>
              <div className="label" style={{ marginBottom: 8 }}>
                REBALANCE DETAILS
              </div>
              <div
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: 12,
                  marginBottom: 16,
                }}
              >
                {[
                  ["Strategy", decision.strategyType ?? "—"],
                  [
                    "Bounds",
                    decision.lowerBoundPrice != null &&
                    decision.upperBoundPrice != null
                      ? `$${decision.lowerBoundPrice.toFixed(2)} – $${decision.upperBoundPrice.toFixed(2)}`
                      : decision.rangeWidthBins != null
                      ? `${decision.rangeWidthBins} bins (legacy)`
                      : "—",
                  ],
                ].map(([k, v], i, arr) => (
                  <div
                    key={i}
                    className="row"
                    style={{
                      padding: "6px 0",
                      borderBottom:
                        i < arr.length - 1 ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <span className="label">{k}</span>
                    <span
                      className="num"
                      style={{
                        marginLeft: "auto",
                        fontSize: 12,
                        color: "var(--fg-1)",
                      }}
                    >
                      {v}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

        <button
          className="row"
          style={{
            width: "100%",
            padding: "10px 12px",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 4,
            cursor: "pointer",
            color: "var(--fg-1)",
          }}
          onClick={() => setShowRaw(!showRaw)}
        >
          <Icon.chev
            style={{
              transform: showRaw ? "rotate(90deg)" : "",
              transition: "transform 0.15s",
            }}
          />
          <span className="label" style={{ marginLeft: 6 }}>
            RAW LLM INPUT
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fg-3)",
            }}
          >
            JSON
          </span>
        </button>
        {showRaw && (
          <pre
            style={{
              marginTop: 8,
              background: "var(--bg-0)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: 12,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fg-2)",
              lineHeight: 1.55,
              overflow: "auto",
              maxHeight: 320,
              whiteSpace: "pre",
            }}
          >
            {JSON.stringify(input, null, 2)}
          </pre>
        )}
      </div>
    </aside>
  );
}
