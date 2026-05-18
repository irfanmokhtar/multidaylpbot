/**
 * Rebalance executor — Phase 5.
 *
 * Two paths, dispatched by `executeRebalance` based on how far the LLM's
 * requested width is from the position's current width:
 *
 *   1. **balanced** (width within ±WIDTH_CHANGE_TOLERANCE_BINS) — uses the
 *      SDK's balanced re-center: full withdraw + full redeposit, no top-up.
 *      Width is preserved. 1–2 txs.
 *
 *   2. **close-reopen** (width outside the tolerance band) — claim LM rewards,
 *      remove all liquidity (with `shouldClaimAndClose` so swap fees are
 *      claimed and the position is closed atomically), then open a brand-new
 *      position at the new range/strategy with whatever the wallet now holds.
 *      WSOL is auto-unwrapped by `removeLiquidity`; we keep a small SOL
 *      reserve so subsequent rent + fee txs don't run dry.
 *
 * Anything outside the happy path throws — `countdown.ts` is responsible for
 * surfacing failures to Telegram.
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  MAX_ACTIVE_BIN_SLIPPAGE,
  DEFAULT_BIN_PER_POSITION,
  MAX_RESIZE_LENGTH,
  getTokenBalance,
  wrapSOLInstruction,
  type LbPosition,
} from "@meteora-ag/dlmm";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { loadConfig } from "../config";
import { logger } from "../logger";
import { getConnection } from "../rpc";
import { loadWallet } from "../wallet";
import { resolveToken } from "../tokens";
import { swapTokensToTargetRatio, type SwapResult } from "../swap/jupiter";
import { getDlmmPool } from "./client";
import { deriveTargetXWeight, currentXWeight } from "./composition";
import { mapStrategyType, priceBoundsToWindow, type PriceBoundsWindow } from "./strategy";
import type { Decision } from "../ai/types";

export type RebalancePath = "balanced" | "close-reopen";

export interface RebalanceExecution {
  path: RebalancePath;
  signatures: string[];
  /** Active bin id observed at simulation/execution time. */
  activeBinId: number;
  /** Position address pre-rebalance. For close-reopen this is the closed one. */
  positionAddress: string;
  preWindow: { lower: number; upper: number; width: number };
  strategy: Decision["strategyType"];
  /** Lamport rental cost from the bin-array provisioning quote (balanced path only). */
  binArrayRentLamports: number;
  /**
   * Balanced path: true when LLM asked for a width inside tolerance but
   * different from existing (we kept the existing width).
   * Close-reopen path: always false (we honor the requested width).
   */
  widthMismatch: boolean;
  /** Close-reopen only — the freshly-opened position. */
  newPositionAddress?: string;
  /** Close-reopen only — the bin window the new position was opened with. */
  newWindow?: { lower: number; upper: number; width: number };
  /** Close-reopen only — true when post-close balance < pre-close value (×0.95). */
  underfunded?: boolean;
  /** Close-reopen only — Jupiter swap executed before reopen, if any. */
  swap?: SwapResult;
  /** Target X-USD weight (0..1) used to drive the swap on close-reopen. */
  targetXWeight?: number;
  /** Pre-rebalance X-USD weight (0..1) of the existing position holdings. */
  currentXWeight?: number;
}

const ZERO_BN = new BN(0);
const SOL_RESERVE_LAMPORTS = new BN(50_000_000); // 0.05 SOL — covers rent + a few txs

export async function executeRebalance(decision: Decision): Promise<RebalanceExecution> {
  if (!decision.strategyType) {
    throw new Error("executeRebalance: decision.strategyType is required");
  }
  if (decision.lowerBoundPrice == null || decision.upperBoundPrice == null) {
    throw new Error(
      "executeRebalance: decision.lowerBoundPrice and decision.upperBoundPrice are required",
    );
  }

  const cfg = loadConfig();
  const pool = await getDlmmPool();
  const wallet = loadWallet();

  const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(
    wallet.publicKey,
  );
  if (userPositions.length === 0) {
    throw new Error(
      "executeRebalance: no position on the active pool — nothing to rebalance",
    );
  }
  if (userPositions.length > 1) {
    throw new Error(
      `executeRebalance: ${userPositions.length} positions on the active pool — ` +
        `Phase 5 only supports a single position. Resolve manually before retrying.`,
    );
  }
  const position: LbPosition = userPositions[0]!;
  const positionData = position.positionData;
  const preWidth = positionData.upperBinId - positionData.lowerBinId + 1;

  const window = priceBoundsToWindow(
    decision.lowerBoundPrice,
    decision.upperBoundPrice,
    pool.lbPair.binStep,
    activeBin.binId,
  );
  const widthDelta = Math.abs(window.width - preWidth);

  // Composition-aware dispatch: compute the planned X-USD weight for the new
  // range and compare against the existing position's current X-USD weight.
  // A large swing forces close+reopen even when the width is within tolerance,
  // because the balanced re-center path cannot change deposit composition.
  const activePriceStr = (await pool.getActiveBin()).pricePerToken;
  const activePrice = parseFloat(activePriceStr);
  const xDec = pool.tokenX.mint.decimals;
  const yDec = pool.tokenY.mint.decimals;
  const yIsStable = resolveToken(pool.tokenY.publicKey.toBase58()).isStablecoin;
  const target = deriveTargetXWeight({
    window,
    activeBinId: activeBin.binId,
    strategyType: decision.strategyType!,
  });
  const posTotalX = new BN(positionData.totalXAmount.toString()).add(positionData.feeX);
  const posTotalY = new BN(positionData.totalYAmount.toString()).add(positionData.feeY);
  const current = currentXWeight({
    balX: posTotalX,
    balY: posTotalY,
    xDec,
    yDec,
    activeBinPrice: activePrice,
    yIsStablecoin: yIsStable,
  });
  const compositionDeltaPp = Math.abs(target.xWeight - current.xWeight) * 100;
  const widthTrigger = widthDelta > cfg.WIDTH_CHANGE_TOLERANCE_BINS;
  const compositionTrigger = compositionDeltaPp > cfg.COMPOSITION_SHIFT_THRESHOLD_PCT;
  // The balanced rebalance ix processes every bin in a single
  // `rebalanceLiquidity` ix; it has no chunking. Existing positions wider
  // than DEFAULT_BIN_PER_POSITION (70) risk tx-size / CU overrun, so we
  // force the close-reopen path for them regardless of width or composition
  // delta. Close-reopen handles wide positions via init+extend+chunked
  // deposit.
  const widePositionTrigger =
    preWidth > DEFAULT_BIN_PER_POSITION.toNumber();
  const path: RebalancePath =
    widthTrigger || compositionTrigger || widePositionTrigger
      ? "close-reopen"
      : "balanced";
  const trigger = describeTrigger({
    widthTrigger,
    compositionTrigger,
    widePositionTrigger,
  });

  logger.info(
    {
      pool: pool.pubkey.toBase58(),
      position: position.publicKey.toBase58(),
      preLower: positionData.lowerBinId,
      preUpper: positionData.upperBinId,
      preWidth,
      requestedBounds: { lower: window.lowerPrice, upper: window.upperPrice },
      requestedBinRange: { min: window.minBinId, max: window.maxBinId, width: window.width },
      activeBinInside: window.activeBinInside,
      widthDelta,
      tolerance: cfg.WIDTH_CHANGE_TOLERANCE_BINS,
      targetXWeight: round3(target.xWeight),
      currentXWeight: round3(current.xWeight),
      compositionDeltaPp: round3(compositionDeltaPp),
      compositionThresholdPp: cfg.COMPOSITION_SHIFT_THRESHOLD_PCT,
      widePosition: widePositionTrigger,
      trigger,
      strategy: decision.strategyType,
      path,
    },
    "rebalance: dispatching",
  );

  if (!window.activeBinInside) {
    logger.warn(
      {
        activeBinId: activeBin.binId,
        minBinId: window.minBinId,
        maxBinId: window.maxBinId,
      },
      "rebalance: active bin OUTSIDE requested range — single-sided position; SDK will enforce deposit composition",
    );
  }

  if (path === "balanced") {
    const r = await executeBalancedRebalance(decision, position, activeBin.binId, window);
    r.targetXWeight = target.xWeight;
    r.currentXWeight = current.xWeight;
    return r;
  }
  const r = await executeCloseAndReopen(decision, position, activeBin.binId, window);
  r.targetXWeight = target.xWeight;
  r.currentXWeight = current.xWeight;
  return r;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function describeTrigger(t: {
  widthTrigger: boolean;
  compositionTrigger: boolean;
  widePositionTrigger: boolean;
}): string {
  const parts: string[] = [];
  if (t.widthTrigger) parts.push("width");
  if (t.compositionTrigger) parts.push("composition");
  if (t.widePositionTrigger) parts.push("wide-position");
  return parts.length === 0 ? "none" : parts.join("+");
}

// ─── balanced re-center (width preserved) ────────────────────────────────────

async function executeBalancedRebalance(
  decision: Decision,
  position: LbPosition,
  activeBinId: number,
  window: PriceBoundsWindow,
): Promise<RebalanceExecution> {
  const cfg = loadConfig();
  const pool = await getDlmmPool();
  const wallet = loadWallet();
  const connection = getConnection();

  const positionData = position.positionData;
  const preWidth = positionData.upperBinId - positionData.lowerBinId + 1;
  const widthMismatch = preWidth !== window.width;
  if (widthMismatch) {
    logger.warn(
      {
        existingWidth: preWidth,
        requestedWidth: window.width,
        requestedBounds: { lower: window.lowerPrice, upper: window.upperPrice },
      },
      "balanced rebalance: width within tolerance but not exact; preserving existing width",
    );
  }

  const strategy = mapStrategyType(decision.strategyType);
  const sim = await pool.simulateRebalancePositionWithBalancedStrategy(
    position.publicKey,
    positionData,
    strategy,
    ZERO_BN,
    ZERO_BN,
    ZERO_BN,
    ZERO_BN,
  );
  const binArrayRentLamports = sim.binArrayCost + sim.bitmapExtensionCost;

  const { initBinArrayInstructions, rebalancePositionInstruction } =
    await pool.rebalancePosition(
      sim,
      new BN(MAX_ACTIVE_BIN_SLIPPAGE),
      wallet.publicKey,
      cfg.REBALANCE_SLIPPAGE_PCT,
    );

  const signatures: string[] = [];
  if (initBinArrayInstructions.length > 0) {
    signatures.push(
      await sendIxBundle(
        "init-bin-arrays",
        initBinArrayInstructions,
        wallet,
        connection,
      ),
    );
  }
  signatures.push(
    await sendIxBundle(
      "rebalance",
      rebalancePositionInstruction,
      wallet,
      connection,
    ),
  );

  return {
    path: "balanced",
    signatures,
    activeBinId,
    positionAddress: position.publicKey.toBase58(),
    preWindow: {
      lower: positionData.lowerBinId,
      upper: positionData.upperBinId,
      width: preWidth,
    },
    strategy: decision.strategyType,
    binArrayRentLamports,
    widthMismatch,
  };
}

// ─── close + reopen (width changed) ──────────────────────────────────────────

async function executeCloseAndReopen(
  decision: Decision,
  position: LbPosition,
  activeBinId: number,
  _initialWindow: PriceBoundsWindow,
): Promise<RebalanceExecution> {
  const cfg = loadConfig();
  const pool = await getDlmmPool();
  const wallet = loadWallet();
  const connection = getConnection();

  const positionData = position.positionData;
  const preWidth = positionData.upperBinId - positionData.lowerBinId + 1;
  const xMint = pool.tokenX.publicKey;
  const yMint = pool.tokenY.publicKey;
  const xDec = pool.tokenX.mint.decimals;
  const yDec = pool.tokenY.mint.decimals;
  const tokenYInfo = resolveToken(yMint.toBase58());
  const activeBinPriceStr = (await pool.getActiveBin()).pricePerToken;
  const activeBinPrice = parseFloat(activeBinPriceStr);

  // Pre-close USD value (only meaningful when Y is a stablecoin).
  const preXUi = bnToUi(positionData.totalXAmount, xDec);
  const preYUi = bnToUi(positionData.totalYAmount, yDec);
  const preFeeXUi = bnToUi(positionData.feeX.toString(), xDec);
  const preFeeYUi = bnToUi(positionData.feeY.toString(), yDec);
  const preValueUsd = tokenYInfo.isStablecoin
    ? (preXUi + preFeeXUi) * activeBinPrice + (preYUi + preFeeYUi)
    : null;

  const signatures: string[] = [];

  // 1. LM rewards (no-op when pool has no farm — cheap insurance against
  //    leaving rewards stranded if the user later switches to a farmed pool).
  const claimRewardTxs = await pool.claimAllRewardsByPosition({
    owner: wallet.publicKey,
    position,
  });
  for (const tx of claimRewardTxs) {
    signatures.push(await sendBuiltTx("claim-rewards", tx, [wallet], connection));
  }

  // 2. Remove 100% liquidity + claim swap fees + close position (atomic per tx;
  //    SDK chunks across txs if the bin range exceeds compute limits).
  const removeTxs = await pool.removeLiquidity({
    user: wallet.publicKey,
    position: position.publicKey,
    fromBinId: positionData.lowerBinId,
    toBinId: positionData.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  for (const tx of removeTxs) {
    signatures.push(
      await sendBuiltTx("remove-and-close", tx, [wallet], connection),
    );
  }

  // 3. Read post-close wallet balances. For the SOL side we read native SOL
  //    (removeLiquidity unwraps WSOL) minus the 0.05 SOL reserve. For non-SOL
  //    sides we read the ATA — if the account doesn't exist yet, treat as 0.
  let balX = await readDepositableBalance(xMint, wallet.publicKey, connection);
  let balY = await readDepositableBalance(yMint, wallet.publicKey, connection);

  if (balX.isZero() && balY.isZero()) {
    throw new Error(
      "close-reopen: wallet has no token X or Y after close — refusing to open an empty position",
    );
  }

  // 4. Recompute the window against the (possibly drifted) live active bin so
  //    we honor the LLM's price bounds rather than a stale snapshot. Bounds
  //    are absolute prices — the active bin's drift does not change where
  //    they should land in bin-space.
  const liveActive = await pool.getActiveBin();
  const window = priceBoundsToWindow(
    decision.lowerBoundPrice!,
    decision.upperBoundPrice!,
    pool.lbPair.binStep,
    liveActive.binId,
  );
  const livePriceStr = liveActive.pricePerToken;
  const livePrice = parseFloat(livePriceStr);

  // 4b. Auto-derive target composition for the new range × strategy × live
  //     active bin, then swap via Jupiter Ultra to align wallet balances with
  //     the target before reopening. Skips when delta is dust (SWAP_MIN_USD)
  //     or when SWAP_ENABLED=false.
  const target = deriveTargetXWeight({
    window,
    activeBinId: liveActive.binId,
    strategyType: decision.strategyType!,
  });
  const preSwapCurrent = currentXWeight({
    balX, balY, xDec, yDec,
    activeBinPrice: livePrice,
    yIsStablecoin: tokenYInfo.isStablecoin,
  });
  logger.info(
    {
      targetXWeight: round3(target.xWeight),
      currentXWeight: round3(preSwapCurrent.xWeight),
      totalUsd: round3(preSwapCurrent.totalUsd),
      activeBinId: liveActive.binId,
      window: { min: window.minBinId, max: window.maxBinId, width: window.width },
      strategy: decision.strategyType,
    },
    "close-reopen: composition target",
  );
  const swap = await swapTokensToTargetRatio({
    balX, balY,
    xMint, yMint, xDec, yDec,
    activeBinPrice: livePrice,
    targetXWeight: target.xWeight,
    yIsStablecoin: tokenYInfo.isStablecoin,
    wallet,
    connection,
  });
  if (swap.signature) signatures.push(swap.signature);
  if (swap.direction !== "NONE" && swap.signature) {
    // Re-read deposit-ready balances (reserve-adjusted) after the swap.
    balX = await readDepositableBalance(xMint, wallet.publicKey, connection);
    balY = await readDepositableBalance(yMint, wallet.publicKey, connection);
    logger.info(
      {
        direction: swap.direction,
        signature: swap.signature,
        postBalX: balX.toString(),
        postBalY: balY.toString(),
      },
      "close-reopen: post-swap balances",
    );
  } else if (swap.skipReason) {
    logger.info({ reason: swap.skipReason }, "close-reopen: swap skipped");
  }

  // 5. Cap deployment per MAX_DEPLOY_USD. Only applies when Y is a stablecoin
  //    (we have a USD anchor); otherwise we redeploy whatever we recovered.
  let totalXAmount = balX;
  let totalYAmount = balY;
  let postValueUsd: number | null = null;
  if (tokenYInfo.isStablecoin) {
    const xUi = bnToUi(totalXAmount.toString(), xDec);
    const yUi = bnToUi(totalYAmount.toString(), yDec);
    postValueUsd = xUi * livePrice + yUi;
    if (postValueUsd > cfg.MAX_DEPLOY_USD) {
      const scale = cfg.MAX_DEPLOY_USD / postValueUsd;
      totalXAmount = scaleBn(totalXAmount, scale);
      totalYAmount = scaleBn(totalYAmount, scale);
      logger.warn(
        {
          postValueUsd,
          cap: cfg.MAX_DEPLOY_USD,
          scale,
        },
        "close-reopen: scaled deposit down to MAX_DEPLOY_USD",
      );
      postValueUsd = cfg.MAX_DEPLOY_USD;
    }
  }

  // Underfund detection: compare to pre-close value (with 5% slack for
  // slippage / unclaimed reward dust).
  const underfunded =
    preValueUsd !== null && postValueUsd !== null
      ? postValueUsd < preValueUsd * 0.95
      : false;
  if (underfunded) {
    logger.warn(
      { preValueUsd, postValueUsd },
      "close-reopen: underfunded — reopening with reduced size",
    );
  }

  // 6. Open the new position.
  //
  //   width ≤ DEFAULT_BIN_PER_POSITION (70): single tx via SDK helper. The
  //   init ix's CPI realloc fits within the 10240-byte cap, and SOL wrapping
  //   is bundled.
  //
  //   71 ≤ width ≤ MAX_RANGE_WIDTH: the helper's single-shot
  //   `initializePosition` ix overruns Solana's inner-realloc cap, so we
  //   split: (a) initializePosition2 + N×increasePositionLength2 to grow the
  //   position to the requested width in one tx, (b) wrap SOL into the WSOL
  //   ATA if X or Y is native (chunkable deposits don't auto-wrap),
  //   (c) chunked addLiquidityByStrategyChunkable txs (one per 70-bin chunk).
  const newPositionKp = Keypair.generate();
  const defaultBinsPerPosition = DEFAULT_BIN_PER_POSITION.toNumber();
  const maxResizeLength = MAX_RESIZE_LENGTH.toNumber();
  const useChunkedReopen = window.width > defaultBinsPerPosition;

  if (!useChunkedReopen) {
    const initTx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPositionKp.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId: window.minBinId,
        maxBinId: window.maxBinId,
        strategyType: mapStrategyType(decision.strategyType),
      },
      user: wallet.publicKey,
      slippage: cfg.REBALANCE_SLIPPAGE_PCT,
    });
    signatures.push(
      await sendBuiltTx(
        "open-new-position",
        initTx,
        [wallet, newPositionKp],
        connection,
      ),
    );
  } else {
    // 6a. init + extend.
    const initialWidth = Math.min(window.width, defaultBinsPerPosition);
    type AnchorMethod = (...args: unknown[]) => {
      accountsPartial: (a: Record<string, PublicKey>) => {
        instruction: () => Promise<TransactionInstruction>;
      };
    };
    const program = pool.program as unknown as {
      methods: {
        initializePosition2: AnchorMethod;
        increasePositionLength2: AnchorMethod;
      };
    };
    const initIx = await program.methods
      .initializePosition2(window.minBinId, initialWidth)
      .accountsPartial({
        payer: wallet.publicKey,
        position: newPositionKp.publicKey,
        lbPair: pool.pubkey,
        owner: wallet.publicKey,
      })
      .instruction();

    const extendIxs: TransactionInstruction[] = [];
    let currentEndBin = window.minBinId + initialWidth - 1;
    while (currentEndBin < window.maxBinId) {
      currentEndBin = Math.min(currentEndBin + maxResizeLength, window.maxBinId);
      const extIx = await program.methods
        .increasePositionLength2(currentEndBin)
        .accountsPartial({
          funder: wallet.publicKey,
          lbPair: pool.pubkey,
          position: newPositionKp.publicKey,
          owner: wallet.publicKey,
        })
        .instruction();
      extendIxs.push(extIx);
    }

    logger.info(
      {
        position: newPositionKp.publicKey.toBase58(),
        minBinId: window.minBinId,
        maxBinId: window.maxBinId,
        width: window.width,
        initialWidth,
        extendCount: extendIxs.length,
      },
      "close-reopen: init+extend position",
    );

    signatures.push(
      await sendIxBundleWithExtraSigners(
        "create-and-extend-position",
        [initIx, ...extendIxs],
        wallet,
        [newPositionKp],
        connection,
      ),
    );

    // 6b. Wrap native SOL into its WSOL ATA so the chunkable deposit ixs see
    //     a funded user token account. Chunkable creates the ATA itself
    //     (idempotent), but never transfers SOL into it.
    const wrapIxs: TransactionInstruction[] = [];
    if (xMint.equals(NATIVE_MINT) && !totalXAmount.isZero()) {
      const ataX = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
      wrapIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          ataX,
          wallet.publicKey,
          NATIVE_MINT,
        ),
        ...wrapSOLInstruction(
          wallet.publicKey,
          ataX,
          BigInt(totalXAmount.toString()),
        ),
      );
    }
    if (yMint.equals(NATIVE_MINT) && !totalYAmount.isZero()) {
      const ataY = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
      wrapIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          ataY,
          wallet.publicKey,
          NATIVE_MINT,
        ),
        ...wrapSOLInstruction(
          wallet.publicKey,
          ataY,
          BigInt(totalYAmount.toString()),
        ),
      );
    }
    if (wrapIxs.length > 0) {
      signatures.push(
        await sendIxBundle("wrap-sol", wrapIxs, wallet, connection),
      );
    }

    // 6c. Chunked add-liquidity.
    const liquidityTxs = await pool.addLiquidityByStrategyChunkable({
      positionPubKey: newPositionKp.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId: window.minBinId,
        maxBinId: window.maxBinId,
        strategyType: mapStrategyType(decision.strategyType),
      },
      user: wallet.publicKey,
      slippage: cfg.REBALANCE_SLIPPAGE_PCT,
    });
    for (let i = 0; i < liquidityTxs.length; i++) {
      signatures.push(
        await sendBuiltTx(
          `add-liquidity-chunk-${i + 1}/${liquidityTxs.length}`,
          liquidityTxs[i]!,
          [wallet],
          connection,
        ),
      );
    }
  }

  return {
    path: "close-reopen",
    signatures,
    activeBinId: liveActive.binId,
    positionAddress: position.publicKey.toBase58(),
    preWindow: {
      lower: positionData.lowerBinId,
      upper: positionData.upperBinId,
      width: preWidth,
    },
    strategy: decision.strategyType,
    binArrayRentLamports: 0,
    widthMismatch: false,
    newPositionAddress: newPositionKp.publicKey.toBase58(),
    newWindow: { lower: window.minBinId, upper: window.maxBinId, width: window.width },
    underfunded,
    swap,
  };
}

// ─── tx helpers ──────────────────────────────────────────────────────────────

async function sendIxBundle(
  label: string,
  ixs: TransactionInstruction[],
  wallet: ReturnType<typeof loadWallet>,
  connection: ReturnType<typeof getConnection>,
): Promise<string> {
  return sendIxBundleWithExtraSigners(label, ixs, wallet, [], connection);
}

async function sendIxBundleWithExtraSigners(
  label: string,
  ixs: TransactionInstruction[],
  wallet: ReturnType<typeof loadWallet>,
  extraSigners: Keypair[],
  connection: ReturnType<typeof getConnection>,
): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...ixs,
  );
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    "confirmed",
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  logger.info({ label, ixCount: ixs.length }, "tx: sending");
  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet, ...extraSigners],
    {
      commitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    },
  );
  logger.info({ label, signature: sig }, "tx: confirmed");
  return sig;
}

async function sendBuiltTx(
  label: string,
  tx: Transaction,
  signers: Array<ReturnType<typeof loadWallet> | Keypair>,
  connection: ReturnType<typeof getConnection>,
): Promise<string> {
  // SDK-built txs may already have a feePayer/blockhash; refresh both so we
  // don't ship one that's about to expire.
  tx.feePayer = signers[0]!.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    "confirmed",
  );
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  logger.info({ label }, "tx: sending");
  const sig = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
    skipPreflight: false,
    maxRetries: 3,
  });
  logger.info({ label, signature: sig }, "tx: confirmed");
  return sig;
}

// ─── balance helpers ─────────────────────────────────────────────────────────

async function readDepositableBalance(
  mint: PublicKey,
  wallet: PublicKey,
  connection: ReturnType<typeof getConnection>,
): Promise<BN> {
  if (mint.equals(NATIVE_MINT)) {
    const lamports = await connection.getBalance(wallet, "confirmed");
    const available = new BN(lamports).sub(SOL_RESERVE_LAMPORTS);
    return BN.max(available, ZERO_BN);
  }
  const ata = getAssociatedTokenAddressSync(mint, wallet);
  try {
    const balance = await getTokenBalance(connection, ata);
    return new BN(balance.toString());
  } catch (err) {
    logger.debug(
      { mint: mint.toBase58(), err: err instanceof Error ? err.message : err },
      "ATA read failed (likely uninitialized) — treating as 0",
    );
    return ZERO_BN;
  }
}

function bnToUi(raw: BN | string, decimals: number): number {
  const v = typeof raw === "string" ? raw : raw.toString();
  return Number(v) / 10 ** decimals;
}

function scaleBn(amount: BN, scale: number): BN {
  // Scale ∈ (0, 1]. Multiply via integer math to avoid Number precision loss
  // on large amounts. 6-decimal scale precision is plenty for cap-down.
  const num = Math.floor(scale * 1_000_000);
  return amount.muln(num).divn(1_000_000);
}

// Helper used by Telegram proposals to render the upcoming rebalance.
// Read-only; safe in dryrun.
export interface RebalancePreview {
  positionAddress: string | null;
  existingWindow: { lower: number; upper: number; width: number } | null;
  activeBinId: number | null;
  strategy: Decision["strategyType"];
  requestedBounds: {
    lower: number;
    upper: number;
    minBinId: number;
    maxBinId: number;
    width: number;
    activeBinInside: boolean;
  } | null;
  widthDelta: number | null;
  path: RebalancePath | null;
  /** Set when bounds were provided but priceBoundsToWindow rejected them. */
  boundsError: string | null;
  /** Auto-derived target X-USD share for the new range × strategy. */
  targetXWeight: number | null;
  /** Existing position's current X-USD share (from totalX/Y + fees). */
  currentXWeight: number | null;
  /** |target − current| in percentage points. */
  compositionDeltaPp: number | null;
  /**
   * Plus-joined trigger names that picked the path
   * (e.g. "width", "width+composition", "wide-position"), "none", or null.
   */
  pathTrigger: string | null;
  /** True when existing position width > DEFAULT_BIN_PER_POSITION (70). */
  widePosition: boolean | null;
}

export async function previewRebalance(decision: Decision): Promise<RebalancePreview> {
  const cfg = loadConfig();
  const pool = await getDlmmPool();
  const wallet = loadWallet();
  const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(
    wallet.publicKey,
  );

  let requestedBounds: RebalancePreview["requestedBounds"] = null;
  let boundsError: string | null = null;
  let parsedWindow: PriceBoundsWindow | null = null;
  if (decision.lowerBoundPrice != null && decision.upperBoundPrice != null) {
    try {
      parsedWindow = priceBoundsToWindow(
        decision.lowerBoundPrice,
        decision.upperBoundPrice,
        pool.lbPair.binStep,
        activeBin.binId,
      );
      requestedBounds = {
        lower: parsedWindow.lowerPrice,
        upper: parsedWindow.upperPrice,
        minBinId: parsedWindow.minBinId,
        maxBinId: parsedWindow.maxBinId,
        width: parsedWindow.width,
        activeBinInside: parsedWindow.activeBinInside,
      };
    } catch (err) {
      boundsError = err instanceof Error ? err.message : String(err);
    }
  }

  // Composition preview (best-effort — only when bounds parsed + strategy set).
  let targetXWeight: number | null = null;
  let currentXWeightVal: number | null = null;
  let compositionDeltaPp: number | null = null;
  if (parsedWindow && decision.strategyType) {
    const t = deriveTargetXWeight({
      window: parsedWindow,
      activeBinId: activeBin.binId,
      strategyType: decision.strategyType,
    });
    targetXWeight = t.xWeight;
    if (userPositions.length > 0) {
      const d = userPositions[0]!.positionData;
      const xDec = pool.tokenX.mint.decimals;
      const yDec = pool.tokenY.mint.decimals;
      const yIsStable = resolveToken(pool.tokenY.publicKey.toBase58()).isStablecoin;
      const activePrice = parseFloat((await pool.getActiveBin()).pricePerToken);
      const posTotalX = new BN(d.totalXAmount.toString()).add(d.feeX);
      const posTotalY = new BN(d.totalYAmount.toString()).add(d.feeY);
      const c = currentXWeight({
        balX: posTotalX,
        balY: posTotalY,
        xDec,
        yDec,
        activeBinPrice: activePrice,
        yIsStablecoin: yIsStable,
      });
      currentXWeightVal = c.xWeight;
      compositionDeltaPp = Math.abs(t.xWeight - c.xWeight) * 100;
    }
  }

  if (userPositions.length === 0) {
    return {
      positionAddress: null,
      existingWindow: null,
      activeBinId: activeBin.binId,
      strategy: decision.strategyType,
      requestedBounds,
      widthDelta: null,
      path: null,
      boundsError,
      targetXWeight,
      currentXWeight: null,
      compositionDeltaPp: null,
      pathTrigger: null,
      widePosition: null,
    };
  }
  const p = userPositions[0]!;
  const d = p.positionData;
  const existingWidth = d.upperBinId - d.lowerBinId + 1;
  const widePositionTrigger = existingWidth > DEFAULT_BIN_PER_POSITION.toNumber();
  const widthDelta = requestedBounds
    ? Math.abs(requestedBounds.width - existingWidth)
    : null;
  let path: RebalancePath | null = null;
  let pathTrigger: RebalancePreview["pathTrigger"] = null;
  if (widthDelta !== null) {
    const widthTrigger = widthDelta > cfg.WIDTH_CHANGE_TOLERANCE_BINS;
    const compositionTrigger =
      compositionDeltaPp !== null &&
      compositionDeltaPp > cfg.COMPOSITION_SHIFT_THRESHOLD_PCT;
    path = widthTrigger || compositionTrigger || widePositionTrigger
      ? "close-reopen"
      : "balanced";
    pathTrigger = describeTrigger({
      widthTrigger,
      compositionTrigger,
      widePositionTrigger,
    });
  }
  return {
    positionAddress: p.publicKey.toBase58(),
    existingWindow: {
      lower: d.lowerBinId,
      upper: d.upperBinId,
      width: existingWidth,
    },
    activeBinId: activeBin.binId,
    strategy: decision.strategyType,
    requestedBounds,
    widthDelta,
    path,
    boundsError,
    targetXWeight,
    currentXWeight: currentXWeightVal,
    compositionDeltaPp,
    pathTrigger,
    widePosition: widePositionTrigger,
  };
}

export function explainPreview(p: RebalancePreview): string {
  const lines: string[] = [];
  lines.push(`active bin   ${p.activeBinId ?? "—"}`);
  if (p.existingWindow) {
    lines.push(
      `position     bins ${p.existingWindow.lower}..${p.existingWindow.upper} ` +
        `(width ${p.existingWindow.width})`,
    );
  } else {
    lines.push(`position     (none — nothing to rebalance)`);
  }
  lines.push(`strategy     ${p.strategy ?? "—"}`);
  if (p.requestedBounds) {
    const b = p.requestedBounds;
    lines.push(
      `bounds       $${b.lower.toFixed(2)} – $${b.upper.toFixed(2)} ` +
        `(bins ${b.minBinId}..${b.maxBinId}, width ${b.width})`,
    );
    lines.push(
      `active inside ${b.activeBinInside ? "YES" : "NO (single-sided)"}` +
        (p.widthDelta !== null ? `   widthDelta=${p.widthDelta}` : ""),
    );
  } else if (p.boundsError) {
    lines.push(`bounds       REJECTED — ${p.boundsError}`);
  }
  if (p.targetXWeight !== null) {
    const tx = Math.round(p.targetXWeight * 100);
    const ty = 100 - tx;
    if (p.currentXWeight !== null && p.compositionDeltaPp !== null) {
      const cx = Math.round(p.currentXWeight * 100);
      const cy = 100 - cx;
      const triggers = p.pathTrigger?.includes("composition")
        ? "  *forces close+reopen*"
        : "";
      lines.push(
        `composition  target ${tx}% X / ${ty}% Y  ` +
          `(current ${cx}/${cy}, Δ${p.compositionDeltaPp.toFixed(1)}pp)${triggers}`,
      );
    } else {
      lines.push(`composition  target ${tx}% X / ${ty}% Y`);
    }
  }
  if (p.path) {
    const trigger = p.pathTrigger && p.pathTrigger !== "none"
      ? ` (trigger: ${p.pathTrigger})`
      : "";
    lines.push(
      p.path === "close-reopen"
        ? `path         CLOSE + REOPEN${trigger}`
        : `path         balanced re-center (within tolerance)`,
    );
  }
  return lines.join("\n");
}
