import { useEffect, useState } from "react";
import { useHealth, useStatus } from "../lib/queries";
import { fmt } from "../lib/format";

function ThemeToggle() {
  const [light, setLight] = useState(
    () => typeof document !== "undefined" && document.body.classList.contains("light"),
  );
  useEffect(() => {
    try {
      const saved = localStorage.getItem("waza.theme");
      if (saved === "light") { document.body.classList.add("light"); setLight(true); }
      else if (saved === "dark") { document.body.classList.remove("light"); setLight(false); }
    } catch {}
  }, []);
  const toggle = () => {
    const next = !light;
    setLight(next);
    document.body.classList.toggle("light", next);
    try { localStorage.setItem("waza.theme", next ? "light" : "dark"); } catch {}
  };
  const seg = (active: boolean, icon: React.ReactNode, label: string) => ({
    style: {
      padding: "2px 6px", borderRadius: 2,
      background: active ? "var(--bg-3)" : "transparent",
      color: active ? "var(--fg-0)" : "var(--fg-3)",
      border: active ? "1px solid var(--line)" : "1px solid transparent",
      display: "inline-flex", alignItems: "center", gap: 4,
    } as React.CSSProperties,
    children: <>{icon}{label}</>,
  });
  return (
    <button
      type="button"
      onClick={toggle}
      title={light ? "Switch to dark" : "Switch to light"}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 4px", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)", background: "var(--bg-2)", border: "1px solid var(--line-2)", borderRadius: 3, letterSpacing: "0.14em", textTransform: "uppercase" }}
    >
      <span {...seg(!light, <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M8 5.5a3 3 0 0 1-3.5-3.5A3.5 3.5 0 1 0 8 5.5Z" fill="currentColor" /></svg>, "DARK")} />
      <span {...seg(light, <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="2" fill="currentColor" /><g stroke="currentColor" strokeWidth="0.9" strokeLinecap="round"><path d="M5 0.5v1.4M5 8.1v1.4M0.5 5h1.4M8.1 5h1.4M1.6 1.6l1 1M7.4 7.4l1 1M1.6 8.4l1-1M7.4 2.6l1-1" /></g></svg>, "LIGHT")} />
    </button>
  );
}

function relTime(secAgo: number): string {
  if (secAgo < 5) return "just now";
  if (secAgo < 60) return `${Math.round(secAgo)}s ago`;
  if (secAgo < 3600) return `${Math.round(secAgo / 60)}m ago`;
  return `${Math.round(secAgo / 3600)}h ago`;
}

export function Topbar() {
  const { data: health } = useHealth();
  const { data: status, dataUpdatedAt } = useStatus();
  const [now, setNow] = useState(Date.now());

  // Tick once a second so "UPDATED 12s ago" stays accurate without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const mode = health?.mode ?? "dryrun";
  const paused = health?.paused ?? false;
  const lastUpdate = dataUpdatedAt
    ? relTime((now - dataUpdatedAt) / 1000)
    : "—";
  const live = !!status;
  const pair =
    status?.snapshot.tokenX.symbol && status?.snapshot.tokenY.symbol
      ? `${status.snapshot.tokenX.symbol} / ${status.snapshot.tokenY.symbol}`
      : "SOL / USDC";
  const poolAddr = status?.snapshot.pool;
  const utc = new Date(now).toISOString().slice(11, 19);

  return (
    <header className="tb">
      <div className="pair">
        <div className="pair-tokens">
          <div className="tk sol">◎</div>
          <div className="tk usdc">$</div>
        </div>
        <div className="pair-name">{pair}</div>
        <div className="pair-sep" />
        <div className="pair-meta">
          {status?.activeBin.binStep ?? 25}BPS · DLMM
        </div>
        <div className="pair-sep" />
        <div className="pair-meta" style={{ color: "var(--fg-1)" }}>
          {poolAddr ? fmt.addr(poolAddr) : "—"}
        </div>
      </div>

      <span className={`tb-mode ${mode}`}>
        <span
          className="dot"
          style={{ background: mode === "live" ? "var(--green)" : "var(--amber)" }}
        />
        {mode === "live" ? "LIVE" : "DRYRUN"}
      </span>

      {paused && (
        <span
          className="tb-mode"
          style={{
            color: "var(--red)",
            borderColor: "var(--red-line)",
            background: "var(--red-soft)",
          }}
        >
          <span className="dot red" /> PAUSED
        </span>
      )}

      <div className="tb-spacer" />

      <span className="tb-meta">
        <span className={`dot ${live ? "live" : ""}`} />
        {live ? "API CONNECTED" : "API OFFLINE"}
      </span>
      <span className="tb-meta">UPDATED {lastUpdate}</span>
      <span className="tb-meta" style={{ color: "var(--fg-3)" }}>
        UTC {utc}
      </span>
      <ThemeToggle />
    </header>
  );
}
