import { loadConfig } from "./config";
import { loadWallet } from "./wallet";
import { getDlmmPool } from "./dlmm/client";
import { getBot, notify } from "./telegram/bot";
import { resolveActivePool } from "./poolMode";
import { getDb } from "./state/db";
import { startScheduler, stopScheduler } from "./scheduler";
import { logger } from "./logger";

async function main() {
  const cfg = loadConfig();
  const wallet = loadWallet();

  // Initialize SQLite (runs migrations on first boot).
  getDb();

  const activePool = resolveActivePool();

  logger.info(
    {
      mode: cfg.MODE,
      pool: activePool ?? "(unset — set POOL_ADDRESS in .env)",
      wallet: wallet.publicKey.toBase58(),
    },
    "booting multidaylpbot",
  );

  if (activePool) {
    await getDlmmPool();
    logger.info("DLMM pool initialized");
  } else {
    logger.warn("POOL_ADDRESS not set — bot will start but cannot fetch position or run TA");
  }

  const bot = getBot();

  // Register a small set of commands shown in Telegram's command menu.
  // (Other commands still work but won't appear in the suggestions popup.)
  await bot.telegram.setMyCommands([
    { command: "status", description: "Show current pool + position" },
    { command: "analyze", description: "Run an ad-hoc TA pass (no LLM)" },
    { command: "decide", description: "Full TA + LLM decision" },
    { command: "cancel", description: "Abort a pending rebalance" },
    { command: "pause", description: "Pause the scheduler" },
    { command: "resume", description: "Resume the scheduler" },
    { command: "sched", description: "Show scheduler state + next runs" },
    { command: "help", description: "List available commands" },
  ]);

  // Graceful shutdown so Telegram drops the long-poll cleanly when we Ctrl+C.
  const shutdown = async (sig: NodeJS.Signals) => {
    logger.info({ sig }, "shutting down");
    await stopScheduler().catch(() => {});
    bot.stop(sig);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Telegraf 4.x footgun: bot.launch() resolves on STOP, not on start.
  // Use the onLaunch callback for "we're now polling" side-effects, then
  // keep awaiting launch() so the process stays alive until shutdown.
  const launchPromise = bot.launch({ dropPendingUpdates: true }, () => {
    logger.info("telegram bot listening");

    // Start the dry-run scheduler now that Telegram is live (so notifications
    // from cron jobs land in the chat, not the void).
    const status = startScheduler();

    notify(
      `🟢 Bot online (${cfg.MODE}). ` +
        (status.enabled
          ? `Scheduler running (${status.jobs.length} jobs). `
          : `Scheduler disabled. `) +
        `Send /status to verify it can see your position, or /sched to see when the next TA pass fires.`,
    ).catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        "boot notification failed",
      ),
    );
  });

  await launchPromise;
  logger.info("bot stopped");
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.stack ?? err.message : err },
    "boot failed",
  );
  process.exit(1);
});
