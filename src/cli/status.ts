import { logger } from "../logger";
import { buildStatusReport, renderStatusText } from "../report";

async function main() {
  const report = await buildStatusReport();
  // Plain-text rendering for humans
  // eslint-disable-next-line no-console
  console.log(renderStatusText(report));
  // Structured copy for log aggregation / debugging
  logger.debug({ report }, "status report");
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : err },
    "status failed",
  );
  process.exit(1);
});
