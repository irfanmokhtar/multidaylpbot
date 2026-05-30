import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { loadConfig } from "../config";
import { logger } from "../logger";

let cached: Database.Database | null = null;

/**
 * Schema migrations, applied in order. Each item runs once (tracked via
 * the built-in `user_version` pragma — far simpler than a separate
 * migrations table for a single-writer local DB).
 *
 * Append new migrations to the end. NEVER edit existing entries — that
 * would silently skip the new statements on databases already at a
 * higher user_version.
 */
const MIGRATIONS: string[] = [
  // 1: current pool selection (autonomous mode only writes here)
  `CREATE TABLE IF NOT EXISTS current_pool (
     id              INTEGER PRIMARY KEY CHECK (id = 1),
     address         TEXT NOT NULL,
     selected_at     INTEGER NOT NULL,        -- unix ms
     selected_by     TEXT NOT NULL,           -- 'user_env' | 'sonnet_bootstrap' | 'sonnet_switch' | 'user_manual'
     previous_pool   TEXT,
     reasoning       TEXT
   );`,
  // 2: OHLCV snapshots for the analyzer's TA inputs
  `CREATE TABLE IF NOT EXISTS ohlcv_snapshot (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     symbol          TEXT NOT NULL,           -- e.g. "SOL"
     interval        TEXT NOT NULL,           -- "1H" | "4H" | "1D"
     fetched_at      INTEGER NOT NULL,        -- unix ms
     candles_json    TEXT NOT NULL            -- JSON array of {t,o,h,l,c,v}
   );
   CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_interval_time
     ON ohlcv_snapshot(symbol, interval, fetched_at DESC);`,
  // 3: LLM-emitted decisions (every analyzer cycle persists one row)
  `CREATE TABLE IF NOT EXISTS decision (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     decided_at      INTEGER NOT NULL,        -- unix ms
     mode            TEXT NOT NULL,           -- 'pinned' | 'autonomous'
     cycle           TEXT NOT NULL,           -- 'daily' | 'intraday' | 'ad_hoc' | 'bootstrap'
     provider        TEXT NOT NULL,           -- 'gemini' | 'groq' | 'anthropic'
     model           TEXT NOT NULL,
     action          TEXT NOT NULL,           -- the Decision.action enum
     confidence      REAL NOT NULL,
     decision_json   TEXT NOT NULL,           -- full Decision blob
     input_json      TEXT NOT NULL            -- full DecisionInput blob (for replay/debugging)
   );
   CREATE INDEX IF NOT EXISTS idx_decision_decided_at
     ON decision(decided_at DESC);`,
  // 4: compact indicator snapshots for delta comparison in LLM prompts
  `CREATE TABLE IF NOT EXISTS indicator_reading (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     symbol     TEXT    NOT NULL,           -- e.g. "SOL"
     interval   TEXT    NOT NULL,           -- "1H" | "4H" | "1D"
     taken_at   INTEGER NOT NULL,           -- unix ms
     close      REAL    NOT NULL,
     rsi14      REAL,
     ema20      REAL,
     bb_pct_b   REAL,
     macd_hist  REAL
   );
   CREATE INDEX IF NOT EXISTS idx_indreading_symbol_interval_time
     ON indicator_reading(symbol, interval, taken_at DESC);`,
  // 5: per-pool cost-basis baseline for the True P&L view. One row per pool.
  //    The baseline (initial deposit) is pinned ONCE — never reset on rebalance.
  //    rebalance_count is a local counter bumped on every executeRebalance.
  `CREATE TABLE IF NOT EXISTS cost_basis (
     pool                TEXT PRIMARY KEY,
     initial_capital_usd REAL,              -- USD value of first deposit
     initial_x_amount    REAL,              -- non-stable (SOL) side at first deposit
     initial_y_amount    REAL,              -- stable (USDC) side at first deposit
     sol_price_at_entry  REAL,
     opened_at           INTEGER,           -- unix ms (first deposit blockTime)
     rebalance_count     INTEGER NOT NULL DEFAULT 0,
     baseline_pinned_at  INTEGER            -- unix ms; null until seeded
   );`,
  // 6: fee offset for baseline resets. On reset we re-anchor to the current
  //    position and snapshot Meteora's cumulative totalFee here, so post-reset
  //    "fees withdrawn" counts only fees claimed AFTER the reset point.
  `ALTER TABLE cost_basis ADD COLUMN fees_withdrawn_offset REAL NOT NULL DEFAULT 0;`,
  // 7: per-action cost log. Tracks Solana tx fees (lamports) and Jupiter swap
  //    slippage for every rebalance so we can evaluate if cycles pay off.
  `CREATE TABLE IF NOT EXISTS action_log (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     executed_at         INTEGER NOT NULL,
     pool                TEXT    NOT NULL,
     path                TEXT    NOT NULL,   -- 'balanced' | 'close-reopen'
     tx_count            INTEGER NOT NULL DEFAULT 0,
     signatures_json     TEXT    NOT NULL DEFAULT '[]',
     sol_fees_lamports   INTEGER NOT NULL DEFAULT 0,
     sol_price_usd       REAL,
     swap_direction      TEXT,               -- 'X_TO_Y' | 'Y_TO_X' | null
     swap_in_usd         REAL,
     swap_out_usd        REAL
   );
   CREATE INDEX IF NOT EXISTS idx_action_log_executed_at
     ON action_log(executed_at DESC);`,
];

export function getDb(): Database.Database {
  if (cached) return cached;
  const cfg = loadConfig();

  const dbPath = path.resolve(cfg.DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i];
    if (!sql) continue;
    db.exec(sql);
    db.pragma(`user_version = ${i + 1}`);
    logger.info({ version: i + 1 }, "applied DB migration");
  }

  cached = db;
  return db;
}

/** Test/CLI helper. Closes the connection so the process can exit cleanly. */
export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}
