import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "./config";

let cached: Keypair | null = null;

export function loadWallet(): Keypair {
  if (cached) return cached;
  const { WALLET_PRIVATE_KEY } = loadConfig();
  let secret: Uint8Array;
  try {
    secret = bs58.decode(WALLET_PRIVATE_KEY);
  } catch {
    throw new Error("WALLET_PRIVATE_KEY is not valid base58");
  }
  if (secret.length !== 64) {
    throw new Error(
      `WALLET_PRIVATE_KEY decoded to ${secret.length} bytes; expected 64`,
    );
  }
  cached = Keypair.fromSecretKey(secret);
  return cached;
}
