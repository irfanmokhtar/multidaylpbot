/**
 * CLI: dump recent action cost log.
 * Usage: npm run fees
 */
import "dotenv/config";
import { actionLogRepo } from "../state/repos";
import { closeDb } from "../state/db";

const rows = actionLogRepo.recent(20);

if (rows.length === 0) {
  console.log("No actions recorded yet.");
  closeDb();
  process.exit(0);
}

console.log(`Action Cost Log (${rows.length} entries)\n${"─".repeat(60)}`);
for (const r of rows) {
  const dt = new Date(r.executedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const solFee = r.solFeesLamports / 1e9;
  const solFeeUsd = r.solPriceUsd !== null ? ` ($${(solFee * r.solPriceUsd).toFixed(4)})` : "";
  let totalCostUsd = r.solPriceUsd !== null ? solFee * r.solPriceUsd : 0;

  console.log(`\n${dt}`);
  console.log(`  Path: ${r.path} | TXs: ${r.txCount}`);
  console.log(`  TX fees: ${solFee.toFixed(7)} SOL${solFeeUsd}`);

  if (r.swapDirection && r.swapInUsd !== null && r.swapOutUsd !== null) {
    const arrow = r.swapDirection === "X_TO_Y" ? "X→Y" : "Y→X";
    const cost = r.swapInUsd - r.swapOutUsd;
    totalCostUsd += cost;
    console.log(
      `  Swap: ${arrow} $${r.swapInUsd.toFixed(2)} → $${r.swapOutUsd.toFixed(2)} (cost: $${cost.toFixed(4)})`,
    );
  }

  console.log(`  Total cost: ~$${totalCostUsd.toFixed(4)}`);
  if (r.signatures.length > 0) {
    console.log(`  Sigs: ${r.signatures.join(", ")}`);
  }
}

closeDb();
