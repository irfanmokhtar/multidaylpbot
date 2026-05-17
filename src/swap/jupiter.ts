/**
 * Jupiter Ultra v1 client.
 *
 * Two-step flow:
 *   1. GET  /ultra/v1/order    → returns base64 v0 VersionedTransaction + requestId
 *   2. POST /ultra/v1/execute  → submit signed tx + requestId
 *
 * Free tier uses `lite-api.jup.ag` (no key required, ~1 req/s). When
 * JUPITER_API_KEY is set we switch to `api.jup.ag` and send `x-api-key`.
 *
 * The orchestrator `swapTokensToTargetRatio` is the only function the
 * rebalance flow calls — it computes direction, atomic amount, and executes
 * one swap (or skips when the delta is dust).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getTokenBalance } from "@meteora-ag/dlmm";

import { loadConfig } from "../config";
import { logger } from "../logger";

const LITE_BASE = "https://lite-api.jup.ag";
const PRO_BASE = "https://api.jup.ag";

function baseUrl(): string {
  const cfg = loadConfig();
  return cfg.JUPITER_API_KEY ? PRO_BASE : LITE_BASE;
}

function authHeaders(): Record<string, string> {
  const cfg = loadConfig();
  return cfg.JUPITER_API_KEY ? { "x-api-key": cfg.JUPITER_API_KEY } : {};
}

export interface JupOrder {
  transaction: string;
  requestId: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  slippageBps?: number;
}

export async function getOrder(args: {
  inputMint: string;
  outputMint: string;
  amount: BN;
  slippageBps: number;
  taker: PublicKey;
}): Promise<JupOrder> {
  const params = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount.toString(),
    slippageBps: String(args.slippageBps),
    taker: args.taker.toBase58(),
  });
  const url = `${baseUrl()}/ultra/v1/order?${params.toString()}`;

  const res = await fetchWithRetry(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter /order ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as JupOrder & { error?: string };
  if (json.error) throw new Error(`Jupiter /order error: ${json.error}`);
  if (!json.transaction || !json.requestId) {
    throw new Error(`Jupiter /order: missing transaction/requestId in response`);
  }
  return json;
}

export interface JupExecuteResult {
  signature: string;
  status: string;
}

export async function executeOrder(
  order: JupOrder,
  wallet: Keypair,
): Promise<JupExecuteResult> {
  const txBytes = Buffer.from(order.transaction, "base64");
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([wallet]);
  const signedBase64 = Buffer.from(tx.serialize()).toString("base64");

  const res = await fetchWithRetry(`${baseUrl()}/ultra/v1/execute`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      signedTransaction: signedBase64,
      requestId: order.requestId,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter /execute ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    signature?: string;
    txSignature?: string;
    status?: string;
    error?: string;
    code?: number;
  };
  if (json.error) {
    throw new Error(`Jupiter /execute error: ${json.error} (code ${json.code})`);
  }
  const signature = json.signature ?? json.txSignature;
  if (!signature) {
    throw new Error(`Jupiter /execute: missing signature in response`);
  }
  return { signature, status: json.status ?? "unknown" };
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export type SwapDirection = "X_TO_Y" | "Y_TO_X" | "NONE";

export interface SwapResult {
  direction: SwapDirection;
  /** Atomic amount of the input token. Zero when direction=NONE. */
  inAmount: BN;
  /** Expected atomic amount of the output token (per Jupiter quote). Zero when NONE. */
  outAmount: BN;
  signature: string | null;
  postBalX: BN;
  postBalY: BN;
  /** Why we skipped, when direction=NONE. */
  skipReason?: string;
}

export async function swapTokensToTargetRatio(args: {
  balX: BN;
  balY: BN;
  xMint: PublicKey;
  yMint: PublicKey;
  xDec: number;
  yDec: number;
  /** Y-per-X price (Meteora's pool.getActiveBin().pricePerToken). */
  activeBinPrice: number;
  /** 0..1 — X share of total USD value the new range expects. */
  targetXWeight: number;
  yIsStablecoin: boolean;
  wallet: Keypair;
  connection: Connection;
}): Promise<SwapResult> {
  const cfg = loadConfig();
  const { balX, balY, xMint, yMint, xDec, yDec, activeBinPrice } = args;

  const xUi = Number(balX.toString()) / 10 ** xDec;
  const yUi = Number(balY.toString()) / 10 ** yDec;
  // USD-relative basis: Y = $1 anchor (true when stablecoin; otherwise still a
  // valid relative unit since both sides are scaled the same way).
  const xPriceUsd = activeBinPrice;
  const yPriceUsd = 1;
  const xUsd = xUi * xPriceUsd;
  const yUsd = yUi * yPriceUsd;
  const totalUsd = xUsd + yUsd;

  if (totalUsd <= 0) {
    return {
      direction: "NONE",
      inAmount: new BN(0),
      outAmount: new BN(0),
      signature: null,
      postBalX: balX,
      postBalY: balY,
      skipReason: "wallet has no X or Y",
    };
  }

  const targetXUsd = totalUsd * args.targetXWeight;
  const deltaUsd = xUsd - targetXUsd; // >0 → too much X, swap X→Y; <0 → swap Y→X

  if (Math.abs(deltaUsd) < cfg.SWAP_MIN_USD) {
    return {
      direction: "NONE",
      inAmount: new BN(0),
      outAmount: new BN(0),
      signature: null,
      postBalX: balX,
      postBalY: balY,
      skipReason: `delta $${deltaUsd.toFixed(4)} below SWAP_MIN_USD $${cfg.SWAP_MIN_USD}`,
    };
  }

  // Half-correction: swapping `deltaUsd` of the heavy side fully closes the gap.
  // We want target X to gain `(targetXUsd - xUsd)` USD; that comes from selling
  // |deltaUsd| of the heavy side. The output side gains roughly the same USD
  // (minus slippage/fees).
  let direction: SwapDirection;
  let inputMint: PublicKey;
  let outputMint: PublicKey;
  let inAtomic: BN;
  if (deltaUsd > 0) {
    direction = "X_TO_Y";
    inputMint = xMint;
    outputMint = yMint;
    const inUi = deltaUsd / xPriceUsd;
    inAtomic = uiToAtomic(inUi, xDec);
    if (inAtomic.gt(balX)) inAtomic = balX;
  } else {
    direction = "Y_TO_X";
    inputMint = yMint;
    outputMint = xMint;
    const inUi = -deltaUsd / yPriceUsd;
    inAtomic = uiToAtomic(inUi, yDec);
    if (inAtomic.gt(balY)) inAtomic = balY;
  }

  if (inAtomic.lten(0)) {
    return {
      direction: "NONE",
      inAmount: new BN(0),
      outAmount: new BN(0),
      signature: null,
      postBalX: balX,
      postBalY: balY,
      skipReason: "computed swap amount rounded to zero",
    };
  }

  if (!cfg.SWAP_ENABLED) {
    logger.info(
      {
        direction,
        inAtomic: inAtomic.toString(),
        deltaUsd,
        targetXUsd,
        currentXUsd: xUsd,
      },
      "swap: SWAP_ENABLED=false — skipping (would swap)",
    );
    return {
      direction: "NONE",
      inAmount: inAtomic,
      outAmount: new BN(0),
      signature: null,
      postBalX: balX,
      postBalY: balY,
      skipReason: "SWAP_ENABLED=false",
    };
  }

  logger.info(
    {
      direction,
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      inAtomic: inAtomic.toString(),
      deltaUsd: deltaUsd.toFixed(4),
      slippageBps: cfg.SWAP_SLIPPAGE_BPS,
    },
    "swap: requesting Jupiter order",
  );

  const order = await getOrder({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: inAtomic,
    slippageBps: cfg.SWAP_SLIPPAGE_BPS,
    taker: args.wallet.publicKey,
  });

  const exec = await executeOrder(order, args.wallet);
  logger.info(
    {
      signature: exec.signature,
      status: exec.status,
      inAmount: order.inAmount,
      outAmount: order.outAmount,
      priceImpactPct: order.priceImpactPct,
    },
    "swap: Jupiter execute confirmed",
  );

  const postBalX = await readWalletBalance(xMint, args.wallet.publicKey, args.connection);
  const postBalY = await readWalletBalance(yMint, args.wallet.publicKey, args.connection);

  return {
    direction,
    inAmount: new BN(order.inAmount),
    outAmount: new BN(order.outAmount),
    signature: exec.signature,
    postBalX,
    postBalY,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function uiToAtomic(ui: number, decimals: number): BN {
  if (!isFinite(ui) || ui <= 0) return new BN(0);
  // Avoid Number precision loss: split into integer and fractional via string.
  const fixed = ui.toFixed(decimals);
  const [intPart, fracPart = ""] = fixed.split(".");
  const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const raw = (intPart + padded).replace(/^0+(?=\d)/, "");
  return new BN(raw === "" ? "0" : raw);
}

/**
 * Raw wallet balance for re-reading after a swap. SOL is returned as the full
 * native balance (no SOL_RESERVE_LAMPORTS subtraction — the reserve enforcement
 * happens in rebalance.ts via readDepositableBalance for the deposit step).
 */
async function readWalletBalance(
  mint: PublicKey,
  wallet: PublicKey,
  connection: Connection,
): Promise<BN> {
  if (mint.equals(NATIVE_MINT)) {
    const lamports = await connection.getBalance(wallet, "confirmed");
    return new BN(lamports);
  }
  const ata = getAssociatedTokenAddressSync(mint, wallet);
  try {
    const balance = await getTokenBalance(connection, ata);
    return new BN(balance.toString());
  } catch {
    return new BN(0);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempt = 0,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt === 0) {
    const wait = Number(res.headers.get("retry-after") ?? "2") * 1000;
    logger.warn({ url, wait }, "jupiter: 429, retrying once");
    await new Promise((r) => setTimeout(r, wait));
    return fetchWithRetry(url, init, attempt + 1);
  }
  return res;
}
