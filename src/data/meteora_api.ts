/**
 * Client for the public Meteora DLMM data API.
 *
 *   Base URL: https://dlmm.datapi.meteora.ag
 *   Auth:     none
 *
 * Used to enrich the TA report with the current pool's APR/fee/TVL metrics.
 */

import { logger } from "../logger";

const BASE = "https://dlmm.datapi.meteora.ag";
const FETCH_TIMEOUT_MS = 12_000;

// ─── Raw response types ──────────────────────────────────────────────────────
// Modeled from a live response sample on 2026-05-08. Fields not consumed by
// the bot are typed loosely to avoid breakage if the API adds metadata.

interface RawPoolConfig {
  bin_step: number;
  base_fee_pct: number;
  max_fee_pct: number;
  protocol_fee_pct: number;
}

interface RawTimeWindowed {
  "30m"?: number;
  "1h"?: number;
  "2h"?: number;
  "4h"?: number;
  "12h"?: number;
  "24h"?: number;
}

interface RawPool {
  address: string;
  name: string;
  token_x: { symbol: string; address: string; decimals: number };
  token_y: { symbol: string; address: string; decimals: number };
  current_price: number;
  tvl: number;
  apr: number;
  apy: number;
  has_farm: boolean;
  farm_apr: number;
  pool_config: RawPoolConfig;
  volume: RawTimeWindowed;
  fees: RawTimeWindowed;
  fee_tvl_ratio: RawTimeWindowed;
  is_blacklisted: boolean;
}

// ─── Public types (what the rest of the bot sees) ────────────────────────────

export interface PoolRow {
  address: string;
  name: string;
  binStep: number;
  baseFeePct: number;
  tokenX: { symbol: string; address: string };
  tokenY: { symbol: string; address: string };
  currentPrice: number;
  tvlUsd: number;
  apr: number;
  apy: number;
  volume24hUsd: number;
  fees24hUsd: number;
  /** % — already a percentage (e.g. 0.32 means 0.32%, the raw value from the API). */
  feeTvlRatio24hPct: number;
  feeTvlRatio4hPct: number;
  hasFarm: boolean;
  farmApr: number;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapPool(p: RawPool): PoolRow {
  return {
    address: p.address,
    name: p.name,
    binStep: p.pool_config.bin_step,
    baseFeePct: p.pool_config.base_fee_pct,
    tokenX: { symbol: p.token_x.symbol, address: p.token_x.address },
    tokenY: { symbol: p.token_y.symbol, address: p.token_y.address },
    currentPrice: p.current_price,
    tvlUsd: p.tvl,
    apr: p.apr,
    apy: p.apy,
    volume24hUsd: p.volume["24h"] ?? 0,
    fees24hUsd: p.fees["24h"] ?? 0,
    feeTvlRatio24hPct: p.fee_tvl_ratio["24h"] ?? 0,
    feeTvlRatio4hPct: p.fee_tvl_ratio["4h"] ?? 0,
    hasFarm: p.has_farm,
    farmApr: p.farm_apr,
  };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function get<T>(pathAndQuery: string): Promise<T> {
  const url = `${BASE}${pathAndQuery}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Meteora API ${res.status} ${res.statusText} on ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getPool(address: string): Promise<PoolRow | null> {
  // The /pools/<address> endpoint returns a single pool object directly.
  // If the address is unknown the API returns 404; surface that as null.
  try {
    const raw = await get<RawPool>(`/pools/${encodeURIComponent(address)}`);
    return mapPool(raw);
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}
