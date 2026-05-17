import { getDb } from "./db";
import type { Decision, DecisionInput, Action, CycleType, PriorReading } from "../ai/types";

// ─── ohlcv_snapshot ──────────────────────────────────────────────────────────

export interface Candle {
  /** unix seconds */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OhlcvSnapshotRow {
  id: number;
  symbol: string;
  interval: string;
  fetchedAt: number;
  candles: Candle[];
}

export const ohlcvRepo = {
  insert(args: { symbol: string; interval: string; candles: Candle[] }): void {
    getDb()
      .prepare(
        `INSERT INTO ohlcv_snapshot (symbol, interval, fetched_at, candles_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(args.symbol, args.interval, Date.now(), JSON.stringify(args.candles));
  },

  latest(symbol: string, interval: string): OhlcvSnapshotRow | null {
    const row = getDb()
      .prepare(
        `SELECT id, symbol, interval, fetched_at AS fetchedAt, candles_json AS candlesJson
         FROM ohlcv_snapshot
         WHERE symbol = ? AND interval = ?
         ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(symbol, interval) as
      | (Omit<OhlcvSnapshotRow, "candles"> & { candlesJson: string })
      | undefined;
    if (!row) return null;
    const { candlesJson, ...rest } = row;
    return { ...rest, candles: JSON.parse(candlesJson) as Candle[] };
  },

  /** Trim old snapshots beyond the most recent N per (symbol,interval). */
  prune(keepPerInterval = 30): void {
    getDb()
      .prepare(
        `DELETE FROM ohlcv_snapshot
         WHERE id NOT IN (
           SELECT id FROM ohlcv_snapshot AS s
           WHERE (
             SELECT COUNT(*) FROM ohlcv_snapshot AS s2
             WHERE s2.symbol = s.symbol
               AND s2.interval = s.interval
               AND s2.fetched_at >= s.fetched_at
           ) <= ?
         )`,
      )
      .run(keepPerInterval);
  },
};

// ─── decision ────────────────────────────────────────────────────────────────

export interface DecisionRow {
  id: number;
  decidedAt: number;
  cycle: CycleType;
  provider: string;
  model: string;
  action: Action;
  confidence: number;
  decision: Decision;
  /** Full input snapshot — handy for replaying a decision later. */
  input: DecisionInput;
}

type DecisionRowRaw = Omit<DecisionRow, "decision" | "input"> & {
  decisionJson: string;
  inputJson: string;
};

function hydrateRow(r: DecisionRowRaw): DecisionRow {
  const { decisionJson, inputJson, ...rest } = r;
  return {
    ...rest,
    decision: JSON.parse(decisionJson) as Decision,
    input: JSON.parse(inputJson) as DecisionInput,
  };
}

export const decisionRepo = {
  insert(args: {
    cycle: CycleType;
    provider: string;
    model: string;
    decision: Decision;
    input: DecisionInput;
  }): number {
    const info = getDb()
      .prepare(
        `INSERT INTO decision (decided_at, mode, cycle, provider, model,
                               action, confidence, decision_json, input_json)
         VALUES (?, 'pinned', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        args.cycle,
        args.provider,
        args.model,
        args.decision.action,
        args.decision.confidence,
        JSON.stringify(args.decision),
        JSON.stringify(args.input),
      );
    return Number(info.lastInsertRowid);
  },

  recent(limit = 5): DecisionRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, decided_at AS decidedAt, cycle, provider, model,
                action, confidence,
                decision_json AS decisionJson, input_json AS inputJson
         FROM decision
         ORDER BY decided_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<
      Omit<DecisionRow, "decision" | "input"> & {
        decisionJson: string;
        inputJson: string;
      }
    >;
    return rows.map(hydrateRow);
  },

  /**
   * Cursor-paginated read for the dashboard. Returns rows strictly older than
   * `beforeMs` (defaults to now). The next cursor is the oldest row's
   * `decidedAt`; null when fewer than `limit` rows came back.
   */
  range(args: { beforeMs?: number; limit?: number } = {}): {
    rows: DecisionRow[];
    nextBefore: number | null;
  } {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const before = args.beforeMs ?? Date.now() + 1;
    const raw = getDb()
      .prepare(
        `SELECT id, decided_at AS decidedAt, cycle, provider, model,
                action, confidence,
                decision_json AS decisionJson, input_json AS inputJson
         FROM decision
         WHERE decided_at < ?
         ORDER BY decided_at DESC
         LIMIT ?`,
      )
      .all(before, limit) as Array<
      Omit<DecisionRow, "decision" | "input"> & {
        decisionJson: string;
        inputJson: string;
      }
    >;
    const rows = raw.map(hydrateRow);
    const nextBefore =
      rows.length === limit ? (rows[rows.length - 1]?.decidedAt ?? null) : null;
    return { rows, nextBefore };
  },

  byId(id: number): DecisionRow | null {
    const row = getDb()
      .prepare(
        `SELECT id, decided_at AS decidedAt, cycle, provider, model,
                action, confidence,
                decision_json AS decisionJson, input_json AS inputJson
         FROM decision
         WHERE id = ?`,
      )
      .get(id) as
      | (Omit<DecisionRow, "decision" | "input"> & {
          decisionJson: string;
          inputJson: string;
        })
      | undefined;
    return row ? hydrateRow(row) : null;
  },

  /** Trim old decisions to bound DB size (default keeps 500 rows). */
  prune(keep = 500): void {
    getDb()
      .prepare(
        `DELETE FROM decision
         WHERE id NOT IN (
           SELECT id FROM decision ORDER BY decided_at DESC LIMIT ?
         )`,
      )
      .run(keep);
  },
};

// ─── indicator_reading ────────────────────────────────────────────────────────

export const indicatorReadingRepo = {
  insert(args: {
    symbol: string;
    interval: string;
    close: number;
    rsi14: number | null;
    ema20: number | null;
    bbPctB: number | null;
    macdHist: number | null;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO indicator_reading
           (symbol, interval, taken_at, close, rsi14, ema20, bb_pct_b, macd_hist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.symbol,
        args.interval,
        Date.now(),
        args.close,
        args.rsi14,
        args.ema20,
        args.bbPctB,
        args.macdHist,
      );
  },

  /** Most-recent N readings for (symbol, interval), newest first. */
  recent(symbol: string, interval: string, limit: number): PriorReading[] {
    const rows = getDb()
      .prepare(
        `SELECT taken_at, close, rsi14, ema20, bb_pct_b, macd_hist
         FROM indicator_reading
         WHERE symbol = ? AND interval = ?
         ORDER BY taken_at DESC LIMIT ?`,
      )
      .all(symbol, interval, limit) as Array<{
        taken_at: number;
        close: number;
        rsi14: number | null;
        ema20: number | null;
        bb_pct_b: number | null;
        macd_hist: number | null;
      }>;
    return rows.map((r) => ({
      takenAt: r.taken_at,
      close: r.close,
      rsi14: r.rsi14,
      ema20: r.ema20,
      bbPctB: r.bb_pct_b,
      macdHist: r.macd_hist,
    }));
  },

  /** Keep N rows per (symbol, interval). Mirrors ohlcvRepo.prune. */
  prune(keepPerInterval = 30): void {
    getDb()
      .prepare(
        `DELETE FROM indicator_reading
         WHERE id NOT IN (
           SELECT id FROM indicator_reading AS r
           WHERE (
             SELECT COUNT(*) FROM indicator_reading AS r2
             WHERE r2.symbol = r.symbol
               AND r2.interval = r.interval
               AND r2.taken_at >= r.taken_at
           ) <= ?
         )`,
      )
      .run(keepPerInterval);
  },
};
