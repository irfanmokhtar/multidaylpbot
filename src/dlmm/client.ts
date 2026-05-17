import DLMM from "@meteora-ag/dlmm";
import { PublicKey } from "@solana/web3.js";
import { resolveActivePool } from "../poolMode";
import { getConnection } from "../rpc";

let cached: DLMM | null = null;
let cachedFor: string | null = null;

export async function getDlmmPool(): Promise<DLMM> {
  const address = resolveActivePool();
  if (!address) {
    throw new Error(
      `No active pool — set POOL_ADDRESS in .env and restart.`,
    );
  }

  // Invalidate cache if the active-pool address changed (e.g. after a switch).
  if (cached && cachedFor === address) return cached;

  const connection = getConnection();
  cached = await DLMM.create(connection, new PublicKey(address));
  cachedFor = address;
  return cached;
}

/** Test/diagnostic helper. Forces a fresh DLMM.create on next get. */
export function resetDlmmPoolCache(): void {
  cached = null;
  cachedFor = null;
}

export interface ActiveBinSummary {
  binId: number;
  /** Decimal-adjusted price (Y per X in human units, e.g. USDC per SOL). */
  pricePerToken: string;
  /**
   * Raw lamport-ratio price (Y_raw / X_raw). Useful for SDK math but NOT
   * human-readable — for SOL/USDC this is ~0.092 instead of ~92.
   */
  rawPrice: string;
  binStep: number;
}

export async function getActiveBinSummary(): Promise<ActiveBinSummary> {
  const pool = await getDlmmPool();
  const bin = await pool.getActiveBin();
  return {
    binId: bin.binId,
    pricePerToken: bin.pricePerToken,
    rawPrice: bin.price,
    binStep: pool.lbPair.binStep,
  };
}
