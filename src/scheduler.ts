/**
 * Phase 4.5 dry-run scheduler.
 *
 * Three cron jobs:
 *   daily    — full TA + Telegram report (always notifies)
 *   intraday — light TA (1H+4H only); notifies ONLY when action ≠ hold
 *   health   — read-only position check; alerts ONLY when out of range
 *
 * No on-chain execution happens here. If the analyzer recommends rebalance/
 * bootstrap/switch/claim_fees, the scheduler still just *reports* the decision
 * to Telegram — the executors land in Phases 5/6/7.
 *
 * A module-level `paused` flag (toggled by /pause and /resume) short-circuits
 * each tick's body; cron jobs themselves keep running so /resume picks up at
 * the next natural firing without re-registering.
 */

import cron, { type ScheduledTask } from "node-cron";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { runAnalysis, formatDecisionHtml, type AnalyzeResult } from "./ai/analyzer";
import { buildStatusReport, renderStatusHtml } from "./report";
import { resolveActivePool } from "./poolMode";
import { getConnection } from "./rpc";
import { notify } from "./telegram/bot";
import { queueRebalance, getPendingRebalance } from "./telegram/countdown";
import { loadWallet } from "./wallet";

let paused = false;
const tasks: ScheduledTask[] = [];

/**
 * Format a Date in the user's display TZ (CRON_TZ if set, else system local).
 * `Date#toISOString` is hardcoded UTC by spec, so we use `toLocaleString`
 * with an explicit timezone for /sched and boot-log readability.
 */
function fmtLocal(d: Date | null | undefined): string | null {
  if (!d) return null;
  const cfg = loadConfig();
  return d.toLocaleString("en-GB", {
    timeZone: cfg.CRON_TZ || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function isPaused(): boolean {
  return paused;
}

export function setPaused(value: boolean): void {
  paused = value;
  logger.info({ paused }, "scheduler pause state changed");
}

export interface SchedulerStatus {
  enabled: boolean;
  paused: boolean;
  jobs: Array<{ name: string; cron: string; nextRun: string | null }>;
}

export function getSchedulerStatus(): SchedulerStatus {
  const cfg = loadConfig();
  return {
    enabled: cfg.SCHEDULER_ENABLED && tasks.length > 0,
    paused,
    jobs: tasks.map((t) => ({
      name: t.name ?? t.id,
      cron: "(see config)",
      nextRun: fmtLocal(t.getNextRun()),
    })),
  };
}

// ─── job bodies ──────────────────────────────────────────────────────────────

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (paused) {
    logger.debug({ job: label }, "scheduler paused, skipping");
    return null;
  }
  try {
    return await fn();
  } catch (err) {
    logger.error(
      { job: label, err: err instanceof Error ? err.message : err },
      "scheduled job failed",
    );
    await notify(
      `⚠️ Scheduled job <b>${label}</b> failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      { html: true },
    ).catch(() => {});
    return null;
  }
}

async function dailyJob(): Promise<void> {
  await safe("daily", async () => {
    const result = await runAnalysis("daily");
    await notify(formatDecisionHtml(result), { html: true });
    await maybeQueueRebalance(result, "daily-ta");
  });
}

async function intradayJob(): Promise<void> {
  await safe("intraday", async () => {
    const result = await runAnalysis("intraday");
    if (result.decision.action === "hold") {
      logger.info(
        {
          confidence: result.decision.confidence,
          headline: result.decision.headline,
          dlmm: `${result.decision.dlmm.verb}: ${result.decision.dlmm.detail}`,
          reasoning: result.decision.reasoning,
        },
        "intraday hold — not notifying",
      );
      return;
    }
    await notify(formatDecisionHtml(result), { html: true });
    await maybeQueueRebalance(result, "intraday-ta");
  });
}

/**
 * Phase 5 hook: when the analyzer says rebalance, in live mode arm the
 * countdown executor. In dryrun we already posted the formatted decision —
 * just log that we *would* have rebalanced.
 */
async function maybeQueueRebalance(
  result: AnalyzeResult,
  source: string,
): Promise<void> {
  if (result.decision.action !== "rebalance") return;

  const cfg = loadConfig();
  if (cfg.MODE !== "live") {
    logger.info(
      { mode: cfg.MODE, source },
      "rebalance recommended but MODE!=live — skipping execution",
    );
    await notify(
      `ℹ️ <i>MODE=${cfg.MODE}</i>: would have queued a rebalance from <b>${source}</b>. ` +
        `Set <code>MODE=live</code> to enable execution.`,
      { html: true },
    ).catch(() => {});
    return;
  }

  const existing = getPendingRebalance();
  if (existing) {
    logger.warn(
      { existingId: existing.id, source },
      "rebalance recommended but one is already executing — skipping",
    );
    await notify(
      `⏭ Skipping new rebalance proposal — one is already executing.`,
    ).catch(() => {});
    return;
  }

  const queued = await queueRebalance(result.decision, source);
  if (!queued.ok) {
    logger.warn({ reason: queued.reason, source }, "queueRebalance refused");
    await notify(
      `⚠️ Could not queue rebalance: <code>${queued.reason ?? "unknown"}</code>`,
      { html: true },
    ).catch(() => {});
  }
}

const SOL_LOW_THRESHOLD_LAMPORTS = 100_000_000; // 0.1 SOL

async function hourlyCheckJob(): Promise<void> {
  await safe("hourly-check", async () => {
    const wallet = loadWallet().publicKey;
    const connection = getConnection();

    // ── wallet balances ──────────────────────────────────────────────────────
    const lamports = await connection.getBalance(wallet, "confirmed");
    const sol = lamports / 1e9;

    let tokenLines = "";
    let statusHtml = "";

    if (resolveActivePool()) {
      const report = await buildStatusReport();
      const snap = report.snapshot;
      const xSym = snap.tokenX.symbol;
      const ySym = snap.tokenY.symbol;
      const xDec = snap.tokenX.decimals;
      const yDec = snap.tokenY.decimals;

      const readSpl = async (mintStr: string, dec: number) => {
        const mint = new PublicKey(mintStr);
        if (mint.equals(NATIVE_MINT)) return sol;
        const ata = getAssociatedTokenAddressSync(mint, wallet);
        try {
          const { value } = await connection.getTokenAccountBalance(ata);
          return Number(value.amount) / 10 ** dec;
        } catch {
          return 0;
        }
      };

      const balX = await readSpl(snap.tokenX.mint, xDec);
      const balY = await readSpl(snap.tokenY.mint, yDec);
      tokenLines = `  ${xSym}: ${balX.toFixed(4)}  ${ySym}: ${balY.toFixed(4)}`;

      statusHtml = renderStatusHtml(report, { withChart: true });
    }

    logger.info(
      { sol, wallet: wallet.toBase58() },
      `hourly check — SOL: ${sol.toFixed(4)}${tokenLines}`,
    );

    if (lamports < SOL_LOW_THRESHOLD_LAMPORTS) {
      await notify(
        `⚠️ <b>Low SOL balance</b>\n` +
          `Wallet <code>${wallet.toBase58().slice(0, 8)}…</code> ` +
          `has only <b>${sol.toFixed(4)} SOL</b> — below 0.1 SOL threshold.\n` +
          `Top up to cover tx fees and the 0.05 SOL reserve.`,
        { html: true },
      );
    }

    if (statusHtml) {
      await notify(statusHtml, { html: true });
    }
  });
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

export function startScheduler(): SchedulerStatus {
  const cfg = loadConfig();
  if (!cfg.SCHEDULER_ENABLED) {
    logger.info("SCHEDULER_ENABLED=false — scheduler not started");
    return getSchedulerStatus();
  }
  if (tasks.length > 0) {
    logger.warn("scheduler already started — ignoring duplicate startScheduler() call");
    return getSchedulerStatus();
  }

  const tz = cfg.CRON_TZ || undefined;
  const opts = (name: string) => ({
    name,
    noOverlap: true,
    ...(tz ? { timezone: tz } : {}),
  });

  tasks.push(cron.schedule(cfg.CRON_DAILY, dailyJob, opts("daily-ta")));
  tasks.push(cron.schedule(cfg.CRON_INTRADAY, intradayJob, opts("intraday-ta")));
  tasks.push(cron.schedule(cfg.CRON_HEALTH, hourlyCheckJob, opts("hourly-check")));

  logger.info(
    {
      daily: cfg.CRON_DAILY,
      intraday: cfg.CRON_INTRADAY,
      health: cfg.CRON_HEALTH,
      tz: tz ?? "(system local)",
      nextDaily: fmtLocal(tasks[0]?.getNextRun()),
      nextIntraday: fmtLocal(tasks[1]?.getNextRun()),
      nextHourly: fmtLocal(tasks[2]?.getNextRun()),
    },
    "scheduler started",
  );

  return getSchedulerStatus();
}

export async function stopScheduler(): Promise<void> {
  for (const t of tasks) {
    try {
      await t.stop();
    } catch (err) {
      logger.warn(
        { name: t.name, err: err instanceof Error ? err.message : err },
        "task stop failed",
      );
    }
  }
  tasks.length = 0;
  logger.info("scheduler stopped");
}
