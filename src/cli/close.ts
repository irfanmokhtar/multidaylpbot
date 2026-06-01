/**
 * Fully close the active position and print a final PnL report.
 *
 *   npm run close          # preview only (no on-chain action)
 *   npm run close -- --yes # execute the close
 *
 * Live-only: refuses unless MODE=live to avoid a surprise on-chain exit.
 */

import { logger } from "../logger";
import { loadConfig } from "../config";
import { buildClosePreviewText, executeCloseAndReport } from "../closeReport";

async function main() {
  const apply = process.argv.includes("--yes") || process.argv.includes("-y");

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log(await buildClosePreviewText());
    // eslint-disable-next-line no-console
    console.log(`\nRun with --yes to execute:  npm run close -- --yes`);
    return;
  }

  const cfg = loadConfig();
  if (cfg.MODE !== "live") {
    // eslint-disable-next-line no-console
    console.error(
      `Refusing to close: MODE=${cfg.MODE}. Set MODE=live to execute an on-chain close.`,
    );
    process.exit(2);
  }

  // eslint-disable-next-line no-console
  console.log(await executeCloseAndReport());
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : err },
    "close failed",
  );
  process.exit(1);
});
