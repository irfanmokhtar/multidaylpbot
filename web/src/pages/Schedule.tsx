import { Icon } from "../components/icons";
import { useHealth, useScheduler } from "../lib/queries";

const TELEGRAM_COMMANDS: Array<[string, string]> = [
  ["/status", "Position + indicator snapshot"],
  ["/analyze", "Raw indicator pass (no LLM)"],
  ["/decide", "Force a fresh LLM decision (ad hoc cycle)"],
  ["/cancel", "Abort the pending rebalance countdown"],
  ["/pause", "Stop new actions"],
  ["/resume", "Re-enable scheduled actions"],
  ["/sched", "List job state · same as this page"],
];

const JOB_DESCRIPTION: Record<string, string> = {
  "daily-ta": "Full TA + LLM decision + Telegram report (always notifies)",
  "intraday-ta": "Light TA (1H + 4H); notifies only if action ≠ hold",
  "position-health": "Read active bin + range; alerts on out-of-range only",
};

/**
 * Backend emits either ISO 8601 or an `en-GB` locale string
 * ("18/05/2026, 08:00:00"). Try ISO first, fall back to parsing en-GB.
 */
function parseNextRun(s: string): number | null {
  const t1 = Date.parse(s);
  if (Number.isFinite(t1)) return t1;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const t2 = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  ).getTime();
  return Number.isFinite(t2) ? t2 : null;
}

function fmtNextRun(iso: string | null): { abs: string; rel: string } {
  if (!iso) return { abs: "—", rel: "" };
  const t = parseNextRun(iso);
  if (t == null) return { abs: iso, rel: "" };
  const sec = Math.max(0, (t - Date.now()) / 1000);
  let rel = "";
  if (sec < 60) rel = `in ${Math.round(sec)}s`;
  else if (sec < 3600) rel = `in ${Math.round(sec / 60)}m`;
  else if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec - h * 3600) / 60);
    rel = `in ${h}h ${m}m`;
  } else rel = `in ${Math.floor(sec / 86400)}d`;
  const abs = new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return { abs, rel };
}

export function Schedule() {
  const { data: sched } = useScheduler();
  const { data: health } = useHealth();
  const paused = health?.paused ?? false;
  const jobs = sched?.jobs ?? [];

  return (
    <div style={{ padding: "20px 24px 32px", maxWidth: 1400, margin: "0 auto" }}>
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <div className="label" style={{ marginBottom: 4 }}>
            SCHEDULE
          </div>
          <div
            style={{
              fontSize: 18,
              color: "var(--fg-0)",
              fontWeight: 500,
              letterSpacing: "-0.01em",
            }}
          >
            Cron jobs · controlled from Telegram
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
          NODE-CRON · {sched?.enabled ? "ENABLED" : "DISABLED"}
        </span>
      </div>

      {paused && (
        <div
          style={{
            background: "var(--red-soft)",
            border: "1px solid var(--red-line)",
            borderRadius: 4,
            padding: "14px 16px",
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Icon.warn style={{ color: "var(--red)", width: 16, height: 16 }} />
          <div className="col">
            <div style={{ fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500 }}>
              Bot is paused — cron jobs continue ticking but short-circuit on entry
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--fg-2)",
                marginTop: 4,
              }}
            >
              Resume from Telegram with{" "}
              <span style={{ color: "var(--amber)" }}>/resume</span>
            </div>
          </div>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--red)",
              letterSpacing: "0.16em",
            }}
          >
            PAUSED
          </span>
        </div>
      )}

      <div className="card" style={{ overflow: "hidden", marginBottom: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>Job</th>
              <th>Cron</th>
              <th>Next run</th>
              <th className="r">Status</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    textAlign: "center",
                    color: "var(--fg-3)",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    padding: 24,
                  }}
                >
                  scheduler not running
                </td>
              </tr>
            )}
            {jobs.map((s) => {
              const next = fmtNextRun(s.nextRun);
              return (
                <tr key={s.name} style={{ cursor: "default" }}>
                  <td>
                    <span
                      className="dot"
                      style={{
                        background: paused
                          ? "var(--fg-3)"
                          : sched?.enabled
                            ? "var(--green)"
                            : "var(--fg-3)",
                        width: 9,
                        height: 9,
                        boxShadow:
                          !paused && sched?.enabled
                            ? "0 0 6px rgba(109,190,135,0.5)"
                            : "none",
                      }}
                    />
                  </td>
                  <td>
                    <div className="num" style={{ fontSize: 13, color: "var(--fg-0)" }}>
                      {s.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--fg-3)",
                        marginTop: 2,
                        fontFamily: "var(--sans)",
                      }}
                    >
                      {JOB_DESCRIPTION[s.name] ?? "—"}
                    </div>
                  </td>
                  <td className="num" style={{ color: "var(--fg-1)", fontSize: 12 }}>
                    {s.cron}
                  </td>
                  <td>
                    <div
                      className="num"
                      style={{
                        fontSize: 12.5,
                        color: paused ? "var(--fg-3)" : "var(--fg-1)",
                      }}
                    >
                      {next.abs}
                    </div>
                    <div
                      className="num"
                      style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}
                    >
                      {next.rel}
                    </div>
                  </td>
                  <td className="r">
                    <span
                      className="pill"
                      style={
                        paused
                          ? { color: "var(--fg-3)", borderColor: "var(--line-2)" }
                          : {
                              color: "var(--green)",
                              borderColor: "var(--green-line)",
                              background: "var(--green-soft)",
                            }
                      }
                    >
                      <span className="pill-dot" />
                      {paused ? "STANDBY" : "ENABLED"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-h">
          <span className="card-h-title">Telegram Controls</span>
          <span className="card-h-sub">READ-ONLY HERE</span>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          {TELEGRAM_COMMANDS.map(([cmd, desc], i) => (
            <div
              key={i}
              className="row"
              style={{
                padding: "10px 16px",
                borderBottom:
                  i < TELEGRAM_COMMANDS.length - 1
                    ? "1px solid var(--line)"
                    : "none",
              }}
            >
              <span
                className="num"
                style={{ fontSize: 12, color: "var(--amber)", width: 80 }}
              >
                {cmd}
              </span>
              <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
