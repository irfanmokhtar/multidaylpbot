/**
 * Reader for the local BTC_DAILY_RESEARCH.md brief.
 *
 * The file is refreshed daily (~07:30 +08) with a dated reading covering BTC
 * sentiment, catalysts, technical analysis, and an Elliott Wave count. Newest
 * reading first; we hand the single newest block to the LLM as macro regime /
 * sentiment / event-risk context (daily/ad_hoc cycles only).
 *
 * Degrades gracefully: a missing/unreadable file returns null (never throws),
 * mirroring the "BTC context fetch failed → skip" posture in the analyzer.
 */

import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config";
import { logger } from "../logger";

export interface BtcResearch {
  /** ISO date (YYYY-MM-DD) parsed from the newest "## YYYY-MM-DD (..)" header. */
  dateIso: string;
  /** Whole days between the header date and today (local). */
  ageDays: number;
  /** True when the newest reading predates today. */
  stale: boolean;
  /** The full newest block (header + body), trimmed and length-capped. */
  text: string;
}

// Generous cap — a full reading (sentiment + catalysts + TA + Elliott Wave) runs
// ~8-9K chars after the Sources line is stripped. Keeps the actionable bias call
// and invalidation levels, not just the early sentiment paragraph.
const MAX_TEXT_CHARS = 9000;

/** Whole-day diff (a − b), date-only, local time. */
function dayDiff(a: Date, b: Date): number {
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da - db) / 86_400_000);
}

export function getLatestResearch(): BtcResearch | null {
  const cfg = loadConfig();
  const filePath = path.resolve(cfg.BTC_RESEARCH_PATH);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, path: filePath },
      "BTC research file unreadable — skipping",
    );
    return null;
  }

  // Newest reading is the first "## " dated header (prose above the
  // <!-- READINGS --> marker has no "## " date header).
  const blocks = raw.split(/^## /m).slice(1);
  const newest = blocks[0]?.trim();
  if (!newest) {
    logger.warn({ path: filePath }, "BTC research file has no dated readings — skipping");
    return null;
  }

  const dateMatch = newest.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) {
    logger.warn({ path: filePath }, "BTC research newest block has no parseable date — skipping");
    return null;
  }
  const dateIso = dateMatch[1]!;

  const ageDays = dayDiff(new Date(), new Date(`${dateIso}T00:00:00`));
  const stale = ageDays >= 1;

  // Drop the trailing "**Sources:**" line — long URLs are pure token waste with
  // no analytical value. Re-prefix the stripped "## " for a natural header.
  const body = newest.replace(/\n+\*\*Sources:\*\*[\s\S]*$/m, "").trimEnd();
  let text = `## ${body}`;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  return { dateIso, ageDays, stale, text };
}
