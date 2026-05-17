/**
 * Notify-then-execute countdown for rebalance proposals.
 *
 * One pending proposal at a time. queueRebalance() posts the proposal to
 * Telegram, arms a timer for COUNTDOWN_SEC, and either executes on timeout or
 * aborts on cancelPending(). New proposals while one is in-flight are rejected
 * — the user must /cancel or wait.
 *
 * State lives in module scope (per PLAN.md "in-memory pending-action map");
 * a process restart drops any pending action, which is fine because the
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
import { getBot, notify } from "./bot";

interface PendingRebalance {
  id: string;
  decision: Decision;
  proposedAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
  /** Free-text label for the trigger (e.g. "daily-ta", "intraday-ta"). */
  source: string;
}

let pending: PendingRebalance | null = null;

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
  if (pending) return { ok: false, reason: "already_pending" };
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
    `Approve to arm a ${cfg.COUNTDOWN_SEC}s countdown.`;

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
      .sendMessage(chatId, `⚠️ Could not arm rebalance: ${result.reason ?? "unknown"}`)
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
  expiresAt: number;
  msUntilExecute: number;
} | null {
  if (!pending) return null;
  return {
    id: pending.id,
    source: pending.source,
    expiresAt: pending.expiresAt,
    msUntilExecute: Math.max(0, pending.expiresAt - Date.now()),
  };
}

export interface QueueResult {
  ok: boolean;
  /** Set when ok=false; e.g. "already_pending" or "no_position". */
  reason?: string;
  id?: string;
  expiresAt?: number;
}

export async function queueRebalance(
  decision: Decision,
  source: string,
): Promise<QueueResult> {
  if (pending) {
    return { ok: false, reason: "already_pending" };
  }
  if (decision.action !== "rebalance") {
    return { ok: false, reason: "not_a_rebalance_decision" };
  }

  const cfg = loadConfig();
  const countdownSec = cfg.COUNTDOWN_SEC;
  const id = String(Date.now());
  const proposedAt = Date.now();
  const expiresAt = proposedAt + countdownSec * 1000;

  // Pre-flight preview (read-only) so the user sees concrete numbers in the
  // proposal. If this fails we still arm the timer — the executor will surface
  // the underlying error at fire time.
  let previewBlock = "(preview unavailable)";
  try {
    const preview = await previewRebalance(decision);
    if (!preview.positionAddress) {
      logger.warn("queueRebalance: no on-chain position — refusing to queue");
      return { ok: false, reason: "no_position" };
    }
    previewBlock = explainPreview(preview);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "queueRebalance: preview failed",
    );
  }

  // Arm the timer first, then notify. If the notify throws we still want a
  // valid pending state so the user can /cancel via the next message.
  const timer = setTimeout(() => {
    void fire(id);
  }, countdownSec * 1000);

  pending = { id, decision, proposedAt, expiresAt, timer, source };

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
    `Executes in <b>${countdownSec}s</b> unless you send /cancel.`;

  try {
    await notify(head + body, { html: true });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "queueRebalance: notify failed",
    );
  }

  return { ok: true, id, expiresAt };
}

export interface CancelResult {
  ok: boolean;
  /** Reason when ok=false: "no_pending" (nothing to cancel). */
  reason?: string;
  cancelledId?: string;
}

export function cancelPending(reason = "user requested"): CancelResult {
  if (!pending) return { ok: false, reason: "no_pending" };
  const id = pending.id;
  clearTimeout(pending.timer);
  pending = null;
  logger.info({ id, reason }, "rebalance proposal cancelled");
  void notify(`🛑 Pending rebalance cancelled (${reason}).`).catch(() => {});
  return { ok: true, cancelledId: id };
}

async function fire(id: string): Promise<void> {
  // Detach pending atomically so a late /cancel can't race us.
  if (!pending || pending.id !== id) {
    logger.debug({ id }, "fire: pending mismatch, skipping");
    return;
  }
  const job = pending;
  pending = null;

  logger.info({ id }, "rebalance: countdown elapsed, executing");
  await notify("⚙️ Countdown elapsed — submitting rebalance tx now.").catch(
    () => {},
  );

  let result: RebalanceExecution;
  try {
    result = await executeRebalance(job.decision);
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
