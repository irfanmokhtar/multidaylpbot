/**
 * Immediate-execution rebalance dispatcher.
 *
 * queueRebalance() posts the proposal to Telegram and executes inline — no
 * timer, no /cancel window. Earlier versions armed a COUNTDOWN_SEC delay, but
 * the active bin drifts on volatile pools during the wait, causing bin-
 * slippage errors at submit time. Now: decide → notify → execute.
 *
 * A module-scope `executing` flag prevents overlapping scheduler ticks from
 * double-firing. A process restart drops the flag, which is fine — the
 * scheduler will re-propose on the next cycle if conditions still warrant it.
 */

import { loadConfig } from "../config";
import { logger } from "../logger";
import {
  executeRebalance,
  explainPreview,
  previewRebalance,
  type RebalanceExecution,
} from "../dlmm/rebalance";
import type { Decision } from "../ai/types";
import { buildClosePreviewText, executeCloseAndReport } from "../closeReport";
import { getBot, notify } from "./bot";

let executing: { id: string; source: string } | null = null;

// ─── approval gate (for /decide-triggered proposals) ─────────────────────────

interface PendingApproval {
  id: string;
  decision: Decision;
  source: string;
  chatId: string;
  messageId: number;
}

let pendingApproval: PendingApproval | null = null;

export function getPendingApproval(): { id: string; source: string } | null {
  if (!pendingApproval) return null;
  return { id: pendingApproval.id, source: pendingApproval.source };
}

export interface ProposeResult {
  ok: boolean;
  reason?: string;
  id?: string;
}

export async function proposeForApproval(
  decision: Decision,
  source: string,
): Promise<ProposeResult> {
  if (executing) return { ok: false, reason: "already_executing" };
  if (pendingApproval) return { ok: false, reason: "already_pending_approval" };
  if (decision.action !== "rebalance") return { ok: false, reason: "not_a_rebalance_decision" };

  const cfg = loadConfig();
  const id = String(Date.now());

  let previewBlock = "(preview unavailable)";
  try {
    const preview = await previewRebalance(decision);
    if (!preview.positionAddress) {
      return { ok: false, reason: "no_position" };
    }
    previewBlock = explainPreview(preview);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "proposeForApproval: preview failed");
  }

  const dlmmVerb = decision.dlmm?.verb ?? "ROLL";
  const head =
    `🟡 <b>Rebalance proposal</b> (source: ${escapeHtml(source)})\n` +
    `Action      ${decision.action.toUpperCase()}   DLMM: ${dlmmVerb}\n` +
    `Confidence  ${(decision.confidence * 100).toFixed(0)}%\n`;
  const headlineBlock = decision.headline ? `<b>${escapeHtml(decision.headline)}</b>\n` : "";
  const body =
    `<pre>${escapeHtml(previewBlock)}</pre>\n` +
    headlineBlock +
    `<i>${escapeHtml(decision.reasoning)}</i>\n\n` +
    `Approve to execute immediately.`;

  try {
    const bot = getBot();
    const msg = await bot.telegram.sendMessage(cfg.TELEGRAM_CHAT_ID, head + body, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `rb_approve:${id}` },
          { text: "❌ Reject",  callback_data: `rb_reject:${id}`  },
        ]],
      },
    });
    pendingApproval = { id, decision, source, chatId: String(msg.chat.id), messageId: msg.message_id };
    logger.info({ id, source }, "rebalance proposal posted — awaiting approval");
    return { ok: true, id };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "proposeForApproval: send failed");
    return { ok: false, reason: "send_failed" };
  }
}

export async function approveApproval(id: string): Promise<{ ok: boolean; reason?: string }> {
  if (!pendingApproval || pendingApproval.id !== id) {
    return { ok: false, reason: "id_mismatch" };
  }
  const { decision, source, chatId, messageId } = pendingApproval;
  pendingApproval = null;

  const bot = getBot();
  await bot.telegram
    .editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] })
    .catch(() => {});

  const result = await queueRebalance(decision, source);
  if (!result.ok) {
    await bot.telegram
      .sendMessage(chatId, `⚠️ Could not execute rebalance: ${result.reason ?? "unknown"}`)
      .catch(() => {});
  }
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

export function rejectApproval(id: string): { ok: boolean; reason?: string } {
  if (!pendingApproval || pendingApproval.id !== id) {
    return { ok: false, reason: "id_mismatch" };
  }
  const { chatId, messageId } = pendingApproval;
  pendingApproval = null;
  logger.info({ id }, "rebalance proposal rejected by user");
  const bot = getBot();
  void bot.telegram
    .editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] })
    .catch(() => {});
  return { ok: true };
}

export function getPendingRebalance(): {
  id: string;
  source: string;
} | null {
  return executing ? { id: executing.id, source: executing.source } : null;
}

// ─── close gate (for /close-triggered exits) ─────────────────────────────────

interface PendingClose {
  id: string;
  chatId: string;
  messageId: number;
}

let pendingClose: PendingClose | null = null;

export function getPendingClose(): { id: string } | null {
  return pendingClose ? { id: pendingClose.id } : null;
}

/** Post a /close confirmation prompt (pre-close snapshot + ✅/❌ buttons). */
export async function proposeClose(source: string): Promise<ProposeResult> {
  if (executing) return { ok: false, reason: "already_executing" };
  if (pendingClose) return { ok: false, reason: "already_pending_close" };
  if (pendingApproval) return { ok: false, reason: "already_pending_approval" };

  const cfg = loadConfig();
  const id = String(Date.now());

  let previewBlock: string;
  try {
    previewBlock = await buildClosePreviewText();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "proposeClose: preview failed",
    );
    return { ok: false, reason: "preview_failed" };
  }

  const body =
    `🔴 <b>Close position</b> (source: ${escapeHtml(source)})\n` +
    `<pre>${escapeHtml(previewBlock)}</pre>\n` +
    `Confirm to fully exit — claims fees, removes all liquidity, closes the position.`;

  try {
    const bot = getBot();
    const msg = await bot.telegram.sendMessage(cfg.TELEGRAM_CHAT_ID, body, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Confirm close", callback_data: `close_confirm:${id}` },
          { text: "❌ Cancel",        callback_data: `close_cancel:${id}`  },
        ]],
      },
    });
    pendingClose = { id, chatId: String(msg.chat.id), messageId: msg.message_id };
    logger.info({ id, source }, "close proposal posted — awaiting confirm");
    return { ok: true, id };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "proposeClose: send failed",
    );
    return { ok: false, reason: "send_failed" };
  }
}

export async function confirmClose(id: string): Promise<{ ok: boolean; reason?: string }> {
  if (!pendingClose || pendingClose.id !== id) {
    return { ok: false, reason: "id_mismatch" };
  }
  if (executing) return { ok: false, reason: "already_executing" };
  const { chatId, messageId } = pendingClose;
  pendingClose = null;

  const bot = getBot();
  await bot.telegram
    .editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] })
    .catch(() => {});

  executing = { id, source: "/close" };
  await notify("⚙️ Closing position now.").catch(() => {});
  try {
    const report = await executeCloseAndReport();
    await notify(`<pre>${escapeHtml(report)}</pre>`, { html: true }).catch(() => {});
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, err: msg }, "close execution failed");
    await notify(
      `❌ <b>Close failed</b>\n<pre>${escapeHtml(msg)}</pre>\n` +
        `Position state may be partially modified — verify with /status before retrying.`,
      { html: true },
    ).catch(() => {});
    return { ok: false, reason: "execution_failed" };
  } finally {
    executing = null;
  }
}

export function cancelClose(id: string): { ok: boolean; reason?: string } {
  if (!pendingClose || pendingClose.id !== id) {
    return { ok: false, reason: "id_mismatch" };
  }
  const { chatId, messageId } = pendingClose;
  pendingClose = null;
  logger.info({ id }, "close proposal cancelled by user");
  const bot = getBot();
  void bot.telegram
    .editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] })
    .catch(() => {});
  return { ok: true };
}

export interface QueueResult {
  ok: boolean;
  /** Set when ok=false; e.g. "already_executing" or "no_position". */
  reason?: string;
  id?: string;
}

export async function queueRebalance(
  decision: Decision,
  source: string,
): Promise<QueueResult> {
  if (executing) {
    return { ok: false, reason: "already_executing" };
  }
  if (decision.action !== "rebalance") {
    return { ok: false, reason: "not_a_rebalance_decision" };
  }

  const id = String(Date.now());

  // Pre-flight preview (read-only) so the user sees concrete numbers before
  // the tx submits. If preview fails we still proceed — the executor will
  // surface the underlying error.
  let previewBlock = "(preview unavailable)";
  try {
    const preview = await previewRebalance(decision);
    if (!preview.positionAddress) {
      logger.warn("queueRebalance: no on-chain position — refusing to execute");
      return { ok: false, reason: "no_position" };
    }
    previewBlock = explainPreview(preview);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "queueRebalance: preview failed",
    );
  }

  executing = { id, source };

  const dlmmVerb = decision.dlmm?.verb ?? "ROLL";
  const head =
    `🟡 <b>Rebalance proposal</b> (source: ${escapeHtml(source)})\n` +
    `Action      ${decision.action.toUpperCase()}   DLMM: ${dlmmVerb}\n` +
    `Confidence  ${(decision.confidence * 100).toFixed(0)}%\n`;
  const headlineBlock = decision.headline
    ? `<b>${escapeHtml(decision.headline)}</b>\n`
    : "";
  const body =
    `<pre>${escapeHtml(previewBlock)}</pre>\n` +
    headlineBlock +
    `<i>${escapeHtml(decision.reasoning)}</i>\n\n` +
    `Executing now.`;

  try {
    await notify(head + body, { html: true });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "queueRebalance: notify failed",
    );
  }

  try {
    await fire(decision, id);
  } finally {
    executing = null;
  }

  return { ok: true, id };
}

export interface CancelResult {
  ok: boolean;
  /** Reason when ok=false: "no_pending" (nothing to cancel). */
  reason?: string;
  cancelledId?: string;
}

/**
 * Back-compat no-op. Execution is now synchronous, so by the time /cancel
 * lands the tx is already in flight or done. The export remains so callers
 * compile, but it always returns no_pending.
 */
export function cancelPending(_reason = "user requested"): CancelResult {
  return { ok: false, reason: "no_pending" };
}

async function fire(decision: Decision, id: string): Promise<void> {
  logger.info({ id }, "rebalance: submitting tx");
  await notify("⚙️ Submitting rebalance tx now.").catch(() => {});

  let result: RebalanceExecution;
  try {
    result = await executeRebalance(decision);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ id, err: msg }, "rebalance execution failed");
    await notify(
      `❌ <b>Rebalance failed</b>\n<pre>${escapeHtml(msg)}</pre>\n` +
        `Position state may be partially modified — verify with /status before retrying.`,
      { html: true },
    ).catch(() => {});
    return;
  }

  const lines = [
    `✅ <b>Rebalance complete</b>`,
    `Path       ${result.path}`,
    `Strategy   ${escapeHtml(result.strategy ?? "—")}`,
    `Position   ${result.positionAddress.slice(0, 12)}…`,
  ];
  if (result.path === "close-reopen") {
    if (result.newPositionAddress) {
      lines.push(`New pos    ${result.newPositionAddress.slice(0, 12)}…`);
    }
    if (result.newWindow) {
      lines.push(
        `New range  bins ${result.newWindow.lower}..${result.newWindow.upper} ` +
          `(width ${result.newWindow.width})`,
      );
    }
  }
  lines.push(`Signatures ${result.signatures.length}`);
  for (const s of result.signatures) {
    lines.push(`  • https://solscan.io/tx/${s}`);
  }
  if (result.binArrayRentLamports > 0) {
    lines.push(
      `Bin-array rent  ${(result.binArrayRentLamports / 1e9).toFixed(6)} SOL`,
    );
  }
  if (result.widthMismatch) {
    lines.push(
      `⚠ width preserved (${result.preWindow.width}) — LLM asked for a different width within tolerance`,
    );
  }
  if (result.underfunded) {
    lines.push(
      `⚠ underfunded — reopened with reduced size (post-close balance below pre-close value)`,
    );
  }
  await notify(lines.join("\n"), { html: true }).catch(() => {});
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
