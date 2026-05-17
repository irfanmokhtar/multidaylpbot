import { PublicKey } from "@solana/web3.js";
import { loadWallet } from "../wallet";
import { resolveToken, type TokenInfo } from "../tokens";
import { getDlmmPool } from "./client";

export interface PositionBin {
  binId: number;
  x: number;
  y: number;
}

export interface PositionSummary {
  publicKey: string;
  lowerBinId: number;
  upperBinId: number;
  width: number;
  totalX: number;
  totalY: number;
  feeX: number;
  feeY: number;
  inRange: boolean;
  bins: PositionBin[];
}

export interface TokenSide extends TokenInfo {
  mint: string;
  decimals: number;
}

export interface PortfolioSnapshot {
  user: string;
  pool: string;
  activeBinId: number;
  /** Decimal-adjusted active-bin price (Y per X in human units). */
  activeBinPrice: string;
  binStep: number;
  tokenX: TokenSide;
  tokenY: TokenSide;
  positions: PositionSummary[];
}

function toUiAmount(raw: string | bigint, decimals: number): number {
  const denom = 10 ** decimals;
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
  return n / denom;
}

export async function getPortfolioSnapshot(
  userPubKey?: PublicKey,
): Promise<PortfolioSnapshot> {
  const pool = await getDlmmPool();
  const owner = userPubKey ?? loadWallet().publicKey;
  const xDecimals = pool.tokenX.mint.decimals;
  const yDecimals = pool.tokenY.mint.decimals;

  const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(owner);

  const positions: PositionSummary[] = userPositions.map((p) => {
    const d = p.positionData;
    const inRange =
      activeBin.binId >= d.lowerBinId && activeBin.binId <= d.upperBinId;
    return {
      publicKey: p.publicKey.toBase58(),
      lowerBinId: d.lowerBinId,
      upperBinId: d.upperBinId,
      width: d.upperBinId - d.lowerBinId + 1,
      totalX: toUiAmount(d.totalXAmount, xDecimals),
      totalY: toUiAmount(d.totalYAmount, yDecimals),
      feeX: toUiAmount(BigInt(d.feeX.toString()), xDecimals),
      feeY: toUiAmount(BigInt(d.feeY.toString()), yDecimals),
      inRange,
      bins: d.positionBinData.map((b) => ({
        binId: b.binId,
        x: toUiAmount(BigInt(b.positionXAmount), xDecimals),
        y: toUiAmount(BigInt(b.positionYAmount), yDecimals),
      })),
    };
  });

  const xMint = pool.tokenX.publicKey.toBase58();
  const yMint = pool.tokenY.publicKey.toBase58();

  return {
    user: owner.toBase58(),
    pool: pool.pubkey.toBase58(),
    activeBinId: activeBin.binId,
    activeBinPrice: activeBin.pricePerToken,
    binStep: pool.lbPair.binStep,
    tokenX: { mint: xMint, decimals: xDecimals, ...resolveToken(xMint) },
    tokenY: { mint: yMint, decimals: yDecimals, ...resolveToken(yMint) },
    positions,
  };
}
