import { logger } from "../logger";
import { buildPnlReport, formatPnlText } from "../pnlReport";

async function main() {
  const report = await buildPnlReport({ force: true });
  // eslint-disable-next-line no-console
  console.log(formatPnlText(report));
  logger.debug({ report }, "pnl report");
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : err },
    "pnl failed",
  );
  process.exit(1);
});
