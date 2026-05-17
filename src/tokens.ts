/**
 * Mainnet mint → display symbol. Hardcoded for the assets this bot deals with.
 * Phase 3 will replace this with on-the-fly resolution via the Meteora data API
 * (which already returns `token_x.symbol`) — for now the static map keeps the
 * bot zero-dep and zero-RPC for symbol resolution.
 */

export interface TokenInfo {
  symbol: string;
  isStablecoin: boolean;
}

const KNOWN: Record<string, TokenInfo> = {
  // Wrapped SOL — used as token X in every SOL pool
  So11111111111111111111111111111111111111112: { symbol: "SOL", isStablecoin: false },
  // Circle USDC
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", isStablecoin: true },
  // Tether USDT
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", isStablecoin: true },
};

export function resolveToken(mint: string): TokenInfo {
  const known = KNOWN[mint];
  if (known) return known;
  return {
    symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`,
    isStablecoin: false,
  };
}
