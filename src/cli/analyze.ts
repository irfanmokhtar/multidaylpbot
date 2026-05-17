/**
 * `npm run analyze` — fetch SOL OHLCV from Birdeye, compute the indicator
 * pack across 1H / 4H / 1D timeframes, persist the snapshots to SQLite, and
 * print a compact human-readable summary.
 *
 * No LLM call here — see `npm run decide` for the full analyzer pass.
 */

import { runIndicatorsPass, formatIndicatorsText } from "../indicatorsReport";
import { logger } from "../logger";

async function main() {
  const report = await runIndicatorsPass("SOL");
  // eslint-disable-next-line no-console
  console.log(formatIndicatorsText(report));
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : err },
    "analyze CLI failed",
  );
  process.exit(1);
});
