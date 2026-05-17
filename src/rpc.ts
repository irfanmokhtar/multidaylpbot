import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config";

let cached: Connection | null = null;

export function getConnection(): Connection {
  if (cached) return cached;
  const { RPC_URL } = loadConfig();
  cached = new Connection(RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  return cached;
}
