/**
 * `npm run decide [-- daily|intraday|ad_hoc]` — run one analyzer pass and
 * print the structured Decision. No on-chain execution (Phase 4 dry run).
 *
 * Useful for sanity-checking prompts/models before relying on the scheduler.
 */

import { execSync } from "child_process";
import { runAnalysis, formatDecisionText } from "../ai/analyzer";
import type { CycleType } from "../ai/types";
import { logger } from "../logger";

function parseCycle(): CycleType {
  const arg = process.argv[2];
  if (!arg) return "ad_hoc";
  if (arg === "daily" || arg === "intraday" || arg === "ad_hoc") {
    return arg;
  }
  console.error(
    `Unknown cycle "${arg}". Use one of: daily | intraday | ad_hoc`,
  );
  process.exit(2);
}

async function main() {
  const cycle = parseCycle();
  const result = await runAnalysis(cycle);
  // eslint-disable-next-line no-console
  console.log("\n" + formatDecisionText(result));

  try {
    const json = JSON.stringify(result.input, null, 2);
    execSync("pbcopy", { input: json });
    // eslint-disable-next-line no-console
    console.log("\n[LLM input copied to clipboard]");
  } catch {
    // pbcopy not available (non-macOS) — silently skip
  }
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.stack ?? err.message : err },
    "decide CLI failed",
  );
  process.exit(1);
});
