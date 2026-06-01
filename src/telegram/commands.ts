import type { Telegraf } from "telegraf";
import { logger } from "../logger";
import { buildStatusReport, renderStatusHtml } from "../report";
import { buildPnlReport, formatPnlHtml } from "../pnlReport";
import {
  previewReset,
  resetBaselineToCurrent,
  formatResetSummary,
} from "../truePnl";
import { runAnalysis, formatDecisionHtml } from "../ai/analyzer";
import {
  runIndicatorsPass,
  formatIndicatorsHtml,
} from "../indicatorsReport";
import {
  isPaused,
  setPaused,
  getSchedulerStatus,
} from "../scheduler";
import {
  approveApproval,
  cancelPending,
  cancelClose,
  confirmClose,
  getPendingApproval,
  getPendingClose,
  getPendingRebalance,
  proposeClose,
  proposeForApproval,
  rejectApproval,
} from "./countdown";
import { loadConfig } from "../config";
import { actionLogRepo, type ActionLogRow } from "../state/repos";

function formatFeesHtml(rows: ActionLogRow[]): string {
  if (rows.length === 0) return "<b>Action Cost Log</b>\n\nNo actions recorded yet.";

  const lines: string[] = ["<b>Action Cost Log</b> (last 10)\n"];
  for (const r of rows) {
    const dt = new Date(r.executedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const solFee = r.solFeesLamports / 1e9;
    const solFeeUsd =
      r.solPriceUsd !== null ? ` (<code>$${(solFee * r.solPriceUsd).toFixed(4)}</code>)` : "";
    let totalCostUsd = r.solPriceUsd !== null ? solFee * r.solPriceUsd : 0;

    const parts: string[] = [
      `<b>${dt}</b>`,
      `Path: ${r.path} | TXs: ${r.txCount}`,
      `TX fees: <code>${solFee.toFixed(7)} SOL</code>${solFeeUsd}`,
    ];

    if (r.swapDirection && r.swapInUsd !== null && r.swapOutUsd !== null) {
      const arrow = r.swapDirection === "X_TO_Y" ? "X→Y" : "Y→X";
      const cost = r.swapInUsd - r.swapOutUsd;
      totalCostUsd += cost;
      parts.push(
        `Swap: ${arrow} <code>$${r.swapInUsd.toFixed(2)} → $${r.swapOutUsd.toFixed(2)}</code> (cost: <code>$${cost.toFixed(4)}</code>)`,
      );
    }

    parts.push(`Total cost: <code>~$${totalCostUsd.toFixed(4)}</code>`);
    lines.push(parts.join("\n"));
  }
  return lines.join("\n\n");
}

const HELP_TEXT = `<b>multidaylpbot</b> — Meteora DLMM SOL/USDC manager

<b>Available commands</b>
/status   — current pool, active bin, and your position(s)
/pnl      — fees collected + total USD PnL vs cost basis (via Meteora indexer)
/fees     — Solana tx fees + swap costs for recent rebalance actions
/resetbaseline — re-anchor the True P&L baseline to the current position
/analyze  — raw indicator pass (OHLCV + RSI/EMA/BB/MACD/ATR; no LLM)
/decide   — full analyzer pass + approval prompt when rebalance recommended (MODE=live)
/close    — fully exit the position (confirm prompt) + final PnL report (MODE=live)
/cancel   — no-op (execution is immediate; kept for back-compat)
/pause    — pause the scheduler (no auto TA / health checks)
/resume   — resume the scheduler
/sched    — show scheduler state + next run times
/help     — this message`;

export function registerCommands(bot: Telegraf): void {
  bot.start(async (ctx) => {
    await ctx.reply(
      `👋 Bot is online. Send /status to see your current position, or /help for commands.`,
    );
  });

  bot.help(async (ctx) => {
    await ctx.replyWithHTML(HELP_TEXT, {
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("pnl", async (ctx) => {
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      const report = await buildPnlReport();
      await ctx.replyWithHTML(formatPnlHtml(report), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "/pnl failed",
      );
      await ctx.reply(
        `⚠️ Failed to build PnL report: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }
  });

  bot.command("fees", async (ctx) => {
    try {
      const rows = actionLogRepo.recent(10);
      await ctx.replyWithHTML(formatFeesHtml(rows), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, "/fees failed");
      await ctx.reply(`⚠️ Failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });

  bot.command("status", async (ctx) => {
    // Show "typing…" because the on-chain fetch can take a couple of seconds.
    await ctx.sendChatAction("typing").catch(() => {});

    try {
      const report = await buildStatusReport();
      await ctx.replyWithHTML(renderStatusHtml(report), {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "/status failed",
      );
      await ctx.reply(
        `⚠️ Failed to build status report: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }
  });

  // /resetbaseline — re-anchor the True-P&L baseline to the current position.
  // Shows a preview with a confirm button; the write happens on confirm.
  bot.command("resetbaseline", async (ctx) => {
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      const summary = await previewReset();
      const body = formatResetSummary(summary, false).join("\n");
      await ctx.replyWithHTML(`<pre>${body}</pre>`, {
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Confirm reset", callback_data: "tpreset_confirm" },
              { text: "✖️ Cancel", callback_data: "tpreset_cancel" },
            ],
          ],
        },
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "/resetbaseline failed",
      );
      await ctx.reply(
        `⚠️ Could not preview reset: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }
  });

  // /pause — flip the scheduler's in-memory pause flag. Cron jobs keep firing
  // but short-circuit; /resume picks up at the next natural firing.
  bot.command("pause", async (ctx) => {
    if (isPaused()) {
      await ctx.reply("⏸ Scheduler is already paused. Use /resume to re-enable.");
      return;
    }
    setPaused(true);
    await ctx.reply(
      "⏸ Scheduler paused. No automatic TA runs or health checks until /resume.",
    );
  });

  bot.command("resume", async (ctx) => {
    if (!isPaused()) {
      await ctx.reply("▶️ Scheduler is already running.");
      return;
    }
    setPaused(false);
    await ctx.reply("▶️ Scheduler resumed. Next ticks will fire on schedule.");
  });

  bot.command("sched", async (ctx) => {
    const s = getSchedulerStatus();
    const lines = [
      `⏱ Scheduler state`,
      `enabled  ${s.enabled}`,
      `paused   ${s.paused}`,
      ``,
      `Jobs:`,
      ...s.jobs.map(
        (j) => `  • ${j.name}  →  next ${j.nextRun ?? "(unknown)"}`,
      ),
    ];
    await ctx.replyWithHTML(`<pre>${lines.join("\n")}</pre>`, {
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("cancel", async (ctx) => {
    cancelPending("user /cancel");
    await ctx.reply("👌 No pending rebalance to cancel.");
  });

  // /analyze — raw indicator pass. No LLM, no on-chain reads. Mirrors the
  // `npm run analyze` CLI for sanity-checking the OHLCV + indicator pipeline.
  bot.command("analyze", async (ctx) => {
    await ctx.sendChatAction("typing").catch(() => {});
    const ack = await ctx.reply(
      "📊 Fetching OHLCV + computing indicators…",
    );
    try {
      const report = await runIndicatorsPass("SOL");
      await ctx.replyWithHTML(formatIndicatorsHtml(report), {
        link_preview_options: { is_disabled: true },
      });
      await ctx.telegram
        .deleteMessage(ack.chat.id, ack.message_id)
        .catch(() => {});
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "/analyze failed",
      );
      await ctx.reply(
        `⚠️ Analyze failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }
  });

  // /decide — full analyzer pass: indicators + position state + LLM decision.
  // No execution; mirrors `npm run decide`.
  bot.command("decide", async (ctx) => {
    await ctx.sendChatAction("typing").catch(() => {});
    // Birdeye OHLCV fetch + indicator pack + LLM call ≈ 8-15s.
    const ack = await ctx.reply(
      "🤖 Running TA pass… (fetching OHLCV, computing indicators, asking the LLM)",
    );
    try {
      const result = await runAnalysis("ad_hoc");
      await ctx.replyWithHTML(formatDecisionHtml(result), {
        link_preview_options: { is_disabled: true },
      });
      await ctx.telegram
        .deleteMessage(ack.chat.id, ack.message_id)
        .catch(() => {});

      const cfg = loadConfig();
      if (cfg.MODE === "live" && result.decision.action === "rebalance") {
        if (getPendingRebalance() || getPendingApproval()) {
          await ctx.reply("⏭ A rebalance proposal is already pending. Send /cancel to abort it.");
        } else {
          const proposed = await proposeForApproval(result.decision, "/decide");
          if (!proposed.ok) {
            await ctx.reply(`⚠️ Could not propose rebalance: ${proposed.reason ?? "unknown"}`);
          }
        }
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "/decide failed",
      );
      await ctx.reply(
        `⚠️ Decide failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }
  });

  // /close — fully exit the position. Posts a confirm prompt with a pre-close
  // PnL snapshot; execution happens on the ✅ button. Live-only.
  bot.command("close", async (ctx) => {
    const cfg = loadConfig();
    if (cfg.MODE !== "live") {
      await ctx.reply(
        `ℹ️ MODE=${cfg.MODE}: /close is a live-only action. Set MODE=live to enable it.`,
      );
      return;
    }
    if (getPendingRebalance() || getPendingApproval() || getPendingClose()) {
      await ctx.reply("⏭ An action is already pending. Resolve it before closing.");
      return;
    }
    await ctx.sendChatAction("typing").catch(() => {});
    const proposed = await proposeClose("/close");
    if (!proposed.ok) {
      await ctx.reply(`⚠️ Could not prepare close: ${proposed.reason ?? "unknown"}`);
    }
  });

  bot.action(/^close_confirm:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    await ctx.answerCbQuery("Closing…");
    const result = await confirmClose(id);
    if (!result.ok) {
      await ctx.answerCbQuery(`Failed: ${result.reason ?? "unknown"}`, { show_alert: true });
    }
  });

  bot.action(/^close_cancel:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    const result = cancelClose(id);
    if (result.ok) {
      await ctx.answerCbQuery("Cancelled.");
      await ctx.editMessageText("✖️ Close cancelled.").catch(() => {});
    } else {
      await ctx.answerCbQuery("Nothing to cancel.", { show_alert: true });
    }
  });

  // Inline keyboard callbacks for approval-gated rebalance proposals.
  bot.action(/^rb_approve:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    await ctx.answerCbQuery("Approving…");
    const result = await approveApproval(id);
    if (!result.ok) {
      await ctx.answerCbQuery(`Failed: ${result.reason ?? "unknown"}`, { show_alert: true });
    }
  });

  bot.action("tpreset_confirm", async (ctx) => {
    await ctx.answerCbQuery("Resetting…");
    try {
      const summary = await resetBaselineToCurrent();
      const body = formatResetSummary(summary, true).join("\n");
      await ctx.editMessageText(`<pre>${body}</pre>`, {
        parse_mode: "HTML",
      }).catch(() => {});
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "tpreset_confirm failed",
      );
      await ctx.answerCbQuery(
        `Failed: ${err instanceof Error ? err.message : "unknown"}`,
        { show_alert: true },
      );
    }
  });

  bot.action("tpreset_cancel", async (ctx) => {
    await ctx.answerCbQuery("Cancelled.");
    await ctx.editMessageText("✖️ Baseline reset cancelled.").catch(() => {});
  });

  bot.action(/^rb_reject:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    const result = rejectApproval(id);
    if (result.ok) {
      await ctx.answerCbQuery("Rejected.");
      await ctx.editMessageText("❌ Rebalance proposal rejected.").catch(() => {});
    } else {
      await ctx.answerCbQuery("Nothing to reject.", { show_alert: true });
    }
  });
}
