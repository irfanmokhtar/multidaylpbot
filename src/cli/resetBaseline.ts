/**
 * Reset the True-P&L baseline to the current position.
 *
 *   npm run reset-baseline          # preview only (no write)
 *   npm run reset-baseline -- --yes # apply the reset
 *
 * Re-anchors initial_capital to the current in-pool value, zeroes the rebalance
 * counter, and snapshots Meteora's cumulative fees so future fees count from now.
 */

import { logger } from "../logger";
import {
  previewReset,
  resetBaselineToCurrent,
  formatResetSummary,
} from "../truePnl";

async function main() {
  const apply = process.argv.includes("--yes") || process.argv.includes("-y");
  const summary = apply ? await resetBaselineToCurrent() : await previewReset();
  // eslint-disable-next-line no-console
  console.log(formatResetSummary(summary, apply).join("\n"));
  if (!apply) {
    // eslint-disable-next-line no-console
    console.log(`\nRun with --yes to apply:  npm run reset-baseline -- --yes`);
  }
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : err },
    "reset-baseline failed",
  );
  process.exit(1);
});
