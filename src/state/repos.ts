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

// ─── action_log ──────────────────────────────────────────────────────────────

export interface ActionLogRow {
  id: number;
  executedAt: number;
  pool: string;
  path: "balanced" | "close-reopen";
  txCount: number;
  signatures: string[];
  solFeesLamports: number;
  solPriceUsd: number | null;
  swapDirection: string | null;
  swapInUsd: number | null;
  swapOutUsd: number | null;
}

export const actionLogRepo = {
  insert(args: {
    pool: string;
    path: "balanced" | "close-reopen";
    signatures: string[];
    solFeesLamports: number;
    solPriceUsd: number | null;
    swapDirection: string | null;
    swapInUsd: number | null;
    swapOutUsd: number | null;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO action_log
           (executed_at, pool, path, tx_count, signatures_json,
            sol_fees_lamports, sol_price_usd, swap_direction, swap_in_usd, swap_out_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        args.pool,
        args.path,
        args.signatures.length,
        JSON.stringify(args.signatures),
        args.solFeesLamports,
        args.solPriceUsd,
        args.swapDirection,
        args.swapInUsd,
        args.swapOutUsd,
      );
  },

  recent(limit = 10): ActionLogRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, executed_at, pool, path, tx_count, signatures_json,
                sol_fees_lamports, sol_price_usd, swap_direction, swap_in_usd, swap_out_usd
         FROM action_log
         ORDER BY executed_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      executed_at: number;
      pool: string;
      path: "balanced" | "close-reopen";
      tx_count: number;
      signatures_json: string;
      sol_fees_lamports: number;
      sol_price_usd: number | null;
      swap_direction: string | null;
      swap_in_usd: number | null;
      swap_out_usd: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      executedAt: r.executed_at,
      pool: r.pool,
      path: r.path,
      txCount: r.tx_count,
      signatures: JSON.parse(r.signatures_json) as string[],
      solFeesLamports: r.sol_fees_lamports,
      solPriceUsd: r.sol_price_usd,
      swapDirection: r.swap_direction,
      swapInUsd: r.swap_in_usd,
      swapOutUsd: r.swap_out_usd,
    }));
  },
};

// ─── cost_basis ──────────────────────────────────────────────────────────────

export interface CostBasisRow {
  pool: string;
  initialCapitalUsd: number | null;
  initialXAmount: number | null;
  initialYAmount: number | null;
  solPriceAtEntry: number | null;
  openedAt: number | null;
  rebalanceCount: number;
  baselinePinnedAt: number | null;
  /** Meteora cumulative totalFee at last reset; subtracted from withdrawn fees. */
  feesWithdrawnOffset: number;
}

export const costBasisRepo = {
  get(pool: string): CostBasisRow | null {
    const row = getDb()
      .prepare(
        `SELECT pool,
                initial_capital_usd AS initialCapitalUsd,
                initial_x_amount    AS initialXAmount,
                initial_y_amount    AS initialYAmount,
                sol_price_at_entry  AS solPriceAtEntry,
                opened_at           AS openedAt,
                rebalance_count     AS rebalanceCount,
                baseline_pinned_at  AS baselinePinnedAt,
                fees_withdrawn_offset AS feesWithdrawnOffset
         FROM cost_basis WHERE pool = ?`,
      )
      .get(pool) as CostBasisRow | undefined;
    return row ?? null;
  },

  /**
   * Pin the baseline (first-deposit cost basis). Idempotent on the baseline
   * columns. `seedRebalanceCount` only applies when the row is new — we never
   * clobber a counter that has already advanced via incrementRebalance().
   */
  pinBaseline(args: {
    pool: string;
    initialCapitalUsd: number;
    initialXAmount: number;
    initialYAmount: number;
    solPriceAtEntry: number;
    openedAt: number | null;
    seedRebalanceCount: number;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO cost_basis
           (pool, initial_capital_usd, initial_x_amount, initial_y_amount,
            sol_price_at_entry, opened_at, rebalance_count, baseline_pinned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pool) DO UPDATE SET
           initial_capital_usd = excluded.initial_capital_usd,
           initial_x_amount    = excluded.initial_x_amount,
           initial_y_amount    = excluded.initial_y_amount,
           sol_price_at_entry  = excluded.sol_price_at_entry,
           opened_at           = excluded.opened_at,
           baseline_pinned_at  = excluded.baseline_pinned_at`,
      )
      .run(
        args.pool,
        args.initialCapitalUsd,
        args.initialXAmount,
        args.initialYAmount,
        args.solPriceAtEntry,
        args.openedAt,
        args.seedRebalanceCount,
        Date.now(),
      );
  },

  /**
   * Re-anchor the baseline to the current position. Resets opened_at to now,
   * zeroes the rebalance counter, and records `feesWithdrawnOffset` (Meteora
   * cumulative totalFee at this instant) so post-reset fees start from zero.
   */
  resetBaseline(args: {
    pool: string;
    initialCapitalUsd: number;
    initialXAmount: number;
    initialYAmount: number;
    solPriceAtEntry: number;
    feesWithdrawnOffset: number;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO cost_basis
           (pool, initial_capital_usd, initial_x_amount, initial_y_amount,
            sol_price_at_entry, opened_at, rebalance_count, baseline_pinned_at,
            fees_withdrawn_offset)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(pool) DO UPDATE SET
           initial_capital_usd   = excluded.initial_capital_usd,
           initial_x_amount      = excluded.initial_x_amount,
           initial_y_amount      = excluded.initial_y_amount,
           sol_price_at_entry    = excluded.sol_price_at_entry,
           opened_at             = excluded.opened_at,
           rebalance_count       = 0,
           baseline_pinned_at    = excluded.baseline_pinned_at,
           fees_withdrawn_offset = excluded.fees_withdrawn_offset`,
      )
      .run(
        args.pool,
        args.initialCapitalUsd,
        args.initialXAmount,
        args.initialYAmount,
        args.solPriceAtEntry,
        Date.now(),
        Date.now(),
        args.feesWithdrawnOffset,
      );
  },

  /** Bump the local rebalance counter; creates a counter-only row if absent. */
  incrementRebalance(pool: string): void {
    getDb()
      .prepare(
        `INSERT INTO cost_basis (pool, rebalance_count)
         VALUES (?, 1)
         ON CONFLICT(pool) DO UPDATE SET
           rebalance_count = rebalance_count + 1`,
      )
      .run(pool);
  },
};
