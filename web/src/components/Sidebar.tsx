export type NavKey = "overview" | "decisions" | "indicators" | "pnl" | "schedule";

interface Props {
  active: NavKey;
  onNav: (k: NavKey) => void;
  decisionsCount?: number;
}

const ITEMS: Array<{ key: NavKey; label: string; count?: number }> = [
  { key: "overview", label: "Overview" },
  { key: "decisions", label: "Decisions" },
  { key: "indicators", label: "Indicators" },
  { key: "pnl", label: "P&L" },
  { key: "schedule", label: "Schedule" },
];

export function Sidebar({ active, onNav, decisionsCount }: Props) {
  return (
    <aside className="sb">
      <div className="sb-brand">
        <div className="sb-brand-mark" />
        <div className="col">
          <div className="sb-brand-name">Waza</div>
          <div className="sb-brand-sub">DLMM · v0.5</div>
        </div>
      </div>
      <nav className="sb-nav">
        <div className="sb-section">Bot</div>
        {ITEMS.map((it) => {
          const count = it.key === "decisions" ? decisionsCount : undefined;
          return (
            <div
              key={it.key}
              className={`sb-item ${active === it.key ? "active" : ""}`}
              onClick={() => onNav(it.key)}
            >
              <span>{it.label}</span>
              {count != null && <span className="sb-item-num">{count}</span>}
            </div>
          );
        })}
      </nav>
      <div className="sb-foot">
        <div>
          <span style={{ color: "var(--fg-2)" }}>WALLET</span>
          <span style={{ marginLeft: 6 }}>9xQe…7Hw2</span>
        </div>
        <div>10.412 SOL · 384.21 USDC</div>
        <div style={{ color: "var(--fg-4)" }}>HOST 127.0.0.1:3001</div>
      </div>
    </aside>
  );
}
