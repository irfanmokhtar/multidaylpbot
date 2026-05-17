import { useState, type CSSProperties, type ReactNode } from "react";
import type { Action } from "../lib/types";
import { fmt } from "../lib/format";
import { Icon } from "./icons";

// ─── Action pill ────────────────────────────────────────────────────────────
const ACTION_CLASS: Record<Action, string> = {
  hold: "hold",
  rebalance: "rebalance",
  claim_fees: "claim",
  pause: "pause",
};
const ACTION_LABEL: Record<Action, string> = {
  hold: "HOLD",
  rebalance: "REBALANCE",
  claim_fees: "CLAIM FEES",
  pause: "PAUSE",
};

export function ActionPill({ action, size = "md" }: { action: Action; size?: "sm" | "md" }) {
  const cls = ACTION_CLASS[action];
  const label = ACTION_LABEL[action];
  const style: CSSProperties | undefined =
    size === "sm" ? { padding: "2px 6px", fontSize: 10 } : undefined;
  return (
    <span className={`pill ${cls}`} style={style}>
      <span className="pill-dot" />
      {label}
    </span>
  );
}

// ─── Confidence bar ─────────────────────────────────────────────────────────
export function ConfBar({
  value,
  width = 96,
  showNum = true,
}: {
  value: number;
  width?: number;
  showNum?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value));
  const tier = pct < 0.4 ? "lo" : pct < 0.7 ? "md" : "hi";
  return (
    <span className="conf">
      <span className="conf-track" style={{ width }}>
        <span className={`conf-fill ${tier}`} style={{ width: `${pct * 100}%` }} />
      </span>
      {showNum && <span className="conf-num">{(pct * 100).toFixed(0)}%</span>}
    </span>
  );
}

// ─── Address chip ───────────────────────────────────────────────────────────
export function AddressChip({ addr, label }: { addr: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  };
  return (
    <span className="addr" title={addr} onClick={onCopy} style={{ position: "relative" }}>
      {label && <span style={{ color: "var(--fg-3)" }}>{label}</span>}
      <span>{fmt.addr(addr)}</span>
      <Icon.copy className="addr-icn" />
      <a
        href={`https://solscan.io/account/${addr}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ display: "inline-flex", color: "inherit" }}
      >
        <Icon.ext className="addr-icn ext" />
      </a>
      {copied && (
        <span
          style={{
            position: "absolute",
            marginTop: 22,
            background: "var(--bg-3)",
            border: "1px solid var(--line-3)",
            color: "var(--green)",
            padding: "2px 8px",
            borderRadius: 3,
            fontSize: 10,
            letterSpacing: "0.1em",
            pointerEvents: "none",
            transform: "translateX(-30%)",
          }}
        >
          COPIED
        </span>
      )}
    </span>
  );
}

// ─── KPI tile ───────────────────────────────────────────────────────────────
export function KpiTile({
  label,
  value,
  sub,
  accent,
  status,
  delta,
  deltaTone,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: string;
  status?: ReactNode;
  delta?: ReactNode;
  deltaTone?: "up" | "down" | "neutral";
}) {
  return (
    <div className="card" style={{ padding: 0, position: "relative", overflow: "hidden" }}>
      {accent && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: `linear-gradient(90deg, ${accent} 0%, transparent 60%)`,
            opacity: 0.7,
          }}
        />
      )}
      <div style={{ padding: "14px 16px 14px" }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="label">{label}</span>
          {status && <span style={{ marginLeft: "auto" }}>{status}</span>}
        </div>
        <div
          className="num"
          style={{ fontSize: 26, lineHeight: 1.1, color: "var(--fg-0)", fontWeight: 500 }}
        >
          {value}
        </div>
        <div className="row" style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
          {sub && <span style={{ color: "var(--fg-3)" }}>{sub}</span>}
          {delta != null && (
            <span
              style={{
                marginLeft: "auto",
                color:
                  deltaTone === "up"
                    ? "var(--green)"
                    : deltaTone === "down"
                      ? "var(--red)"
                      : "var(--fg-2)",
              }}
            >
              {delta}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
