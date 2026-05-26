/**
 * Birdeye public API client for OHLCV candles.
 *
 *   Base URL: https://public-api.birdeye.so
 *   Auth:     X-API-KEY header (free tier; sign up at birdeye.so/developers)
 *   Endpoint: /defi/v3/ohlcv
 *
 * Used to feed the indicator pack (RSI/EMA/BB/MACD/ATR) into Sonnet's TA.
 */

import { loadConfig } from "../config";
import { logger } from "../logger";
import type { Candle } from "../state/repos";

const BASE = "https://public-api.birdeye.so";
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Birdeye Standard (free) tier is 1 request per second, account-wide.
 * Pace requests with a small safety margin to avoid 429s under any clock
 * skew or burstiness. See https://docs.birdeye.so/docs/rate-limiting
 *
 * Tighter spacing is safe — the throttle is intentionally conservative.
 * If you upgrade to a paid plan, drop this to 0 (or e.g. 80ms for Lite/Starter at 15 RPS).
 */
const MIN_REQUEST_SPACING_MS = 1_100;
const MAX_429_RETRIES = 2;
const DEFAULT_429_BACKOFF_MS = 2_000;

let lastRequestAt = 0;

// API key rotation. Free Standard tier shares a CU budget per key; rotating
// across keys multiplies effective budget. State is module-scoped so all
// callers share the cursor and exhausted-set within a process lifetime.
let keyPool: string[] | null = null;
let keyCursor = 0;
const exhaustedKeys = new Set<string>();

function loadKeyPool(): string[] {
  if (keyPool !== null) return keyPool;
  const cfg = loadConfig();
  const list = (cfg.BIRDEYE_API_KEYS || cfg.BIRDEYE_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  keyPool = list;
  return list;
}

function currentKey(): string | null {
  const pool = loadKeyPool();
  if (pool.length === 0) return null;
  for (let i = 0; i < pool.length; i++) {
    const idx = (keyCursor + i) % pool.length;
    const k = pool[idx];
    if (k && !exhaustedKeys.has(k)) {
      keyCursor = idx;
      return k;
    }
  }
  // All exhausted — reset and try again. Free CU buckets refill periodically,
  // so a previously exhausted key may have recovered.
  exhaustedKeys.clear();
  return pool[keyCursor % pool.length] ?? null;
}

function markExhausted(key: string): void {
  exhaustedKeys.add(key);
  const pool = loadKeyPool();
  keyCursor = (keyCursor + 1) % Math.max(pool.length, 1);
}

function isCuExhaustionBody(status: number, body: string): boolean {
  const b = body.toLowerCase();
  return (
    status === 429 ||
    b.includes("compute unit") ||
    b.includes("cu limit") ||
    b.includes("rate limit") ||
    b.includes("quota") ||
    b.includes("upgrade your plan")
  );
}

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  const wait = MIN_REQUEST_SPACING_MS - elapsed;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// Wrapped SOL — what Birdeye uses as "SOL" on Solana.
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Wormhole wrapped BTC on Solana — used for BTC macro context.
export const BTC_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";

/**
 * Birdeye-supported intervals we use. The full list is much wider; these are
 * the ones that match the indicator pack's needs.
 */
export type Interval = "1H" | "4H" | "1D";

const SECONDS_PER_INTERVAL: Record<Interval, number> = {
  "1H": 3_600,
  "4H": 4 * 3_600,
  "1D": 24 * 3_600,
};

interface RawCandle {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface RawOhlcvResponse {
  success: boolean;
  data?: { items: RawCandle[] };
  message?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const pool = loadKeyPool();
  if (pool.length === 0) {
    throw new Error(
      "No Birdeye API key configured. Set BIRDEYE_API_KEY (single) or " +
        "BIRDEYE_API_KEYS (comma-separated for CU rotation). " +
        "Sign up at https://birdeye.so/developers.",
    );
  }

  // Two layers of retry:
  //   - 429 backoff per key (MAX_429_RETRIES)
  //   - rotate key on CU-exhaustion 4xx, up to pool.length attempts
  const maxKeyAttempts = pool.length;
  let lastErr: Error | null = null;

  for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
    const key = currentKey();
    if (!key) break;

    let rotate = false;

    for (let attempt = 0; ; attempt++) {
      await throttle();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            "X-API-KEY": key,
            "x-chain": "solana",
            accept: "application/json",
          },
        });

        // 429 → short backoff on same key. Exhaust retries before rotating.
        if (res.status === 429 && attempt < MAX_429_RETRIES) {
          const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : DEFAULT_429_BACKOFF_MS * (attempt + 1);
          logger.warn(
            { attempt: attempt + 1, waitMs, url, key: maskKey(key) },
            "Birdeye 429 — backing off",
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "<no body>");
          const snippet = body.slice(0, 300);
          if (isCuExhaustionBody(res.status, body) && pool.length > 1) {
            logger.warn(
              { key: maskKey(key), status: res.status, snippet },
              "Birdeye CU/quota hit — rotating key",
            );
            markExhausted(key);
            rotate = true;
          }
          lastErr = new Error(
            `Birdeye ${res.status} ${res.statusText} on ${url} — ${snippet}`,
          );
          break;
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    }

    if (!rotate) break;
  }

  throw lastErr ?? new Error(`Birdeye request failed on ${url}`);
}

function maskKey(k: string): string {
  if (k.length <= 8) return "***";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export interface FetchOhlcvOptions {
  /** Token mint address. Defaults to wrapped SOL. */
  address?: string;
  interval: Interval;
  /** How many of the most recent candles to fetch. Defaults to 200. */
  candles?: number;
}

/**
 * Fetch the last N candles ending at "now" for the given token+interval.
 * Returns candles in chronological order (oldest first), suitable for direct
 * use by the `technicalindicators` package.
 */
export async function fetchOhlcv(opts: FetchOhlcvOptions): Promise<Candle[]> {
  const address = opts.address ?? SOL_MINT;
  const candles = opts.candles ?? 200;
  const sec = SECONDS_PER_INTERVAL[opts.interval];

  const now = Math.floor(Date.now() / 1000);
  // +1 candle of slack — Birdeye sometimes drops the partial in-flight candle.
  const timeFrom = now - (candles + 1) * sec;
  const timeTo = now;

  const params = new URLSearchParams({
    address,
    type: opts.interval,
    time_from: String(timeFrom),
    time_to: String(timeTo),
    currency: "usd",
  });
  const url = `${BASE}/defi/v3/ohlcv?${params}`;

  const res = await getJson<RawOhlcvResponse>(url);
  if (!res.success || !res.data) {
    throw new Error(
      `Birdeye OHLCV unsuccessful: ${res.message ?? "no data field"}`,
    );
  }

  // Normalize to Candle (renaming unixTime → t) and sort ascending.
  const out: Candle[] = res.data.items
    .map(
      (r): Candle => ({
        t: r.unixTime,
        o: r.o,
        h: r.h,
        l: r.l,
        c: r.c,
        v: r.v,
      }),
    )
    .sort((a, b) => a.t - b.t);

  logger.debug(
    {
      address,
      interval: opts.interval,
      requested: candles,
      received: out.length,
      latest: out[out.length - 1]?.c,
    },
    "fetched OHLCV",
  );

  return out;
}
