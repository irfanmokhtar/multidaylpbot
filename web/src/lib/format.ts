export const fmt = {
  usd: (v: number, d = 2) =>
    "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }),
  num: (v: number, d = 2) =>
    v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (v: number, d = 2) => v.toFixed(d) + "%",
  short: (v: number) => {
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + "K";
    return v.toFixed(2);
  },
  addr: (s: string | undefined | null) =>
    s && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s ?? "",
};
