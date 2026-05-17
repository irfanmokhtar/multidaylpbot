import { Telegraf } from "telegraf";
import { loadConfig } from "../config";
import { logger } from "../logger";
import { registerCommands } from "./commands";

let cached: Telegraf | null = null;

export function getBot(): Telegraf {
  if (cached) return cached;

  const cfg = loadConfig();
  if (!cfg.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to start the Telegram bot");
  }
  if (!cfg.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID is required to start the Telegram bot");
  }

  const bot = new Telegraf(cfg.TELEGRAM_BOT_TOKEN, {
    handlerTimeout: Infinity,
  });
  const allowedChatId = cfg.TELEGRAM_CHAT_ID;

  // Single-chat auth guard. Anything from a chat that isn't ours
  // is silently dropped — and logged at debug only, so we don't fill the
  // logs if a stranger pings the bot.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== allowedChatId) {
      logger.debug(
        { chatId, from: ctx.from?.id, text: ctx.text?.slice(0, 40) },
        "dropping message from non-allowlisted chat",
      );
      return;
    }
    await next();
  });

  // Surface errors to logs but keep the bot running.
  bot.catch((err, ctx) => {
    logger.error(
      {
        err: err instanceof Error ? err.message : err,
        update: ctx.updateType,
      },
      "telegram handler threw",
    );
  });

  registerCommands(bot);

  cached = bot;
  return bot;
}

/**
 * Send a one-off message to the configured chat. Used by proactive notifications
 * (boot announcement, scheduler reports, rebalance proposals — Phase 4+).
 */
export async function notify(text: string, opts?: { html?: boolean }): Promise<void> {
  const bot = getBot();
  const cfg = loadConfig();
  await bot.telegram.sendMessage(cfg.TELEGRAM_CHAT_ID, text, {
    parse_mode: opts?.html ? "HTML" : undefined,
    link_preview_options: { is_disabled: true },
  });
}
