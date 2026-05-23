import "dotenv/config";
import { z } from "zod";

const Mode = z.enum(["dryrun", "live"]);
const LogLevel = z.enum(["debug", "info", "warn", "error"]);
const LlmProvider = z.enum(["gemini", "groq", "anthropic", "claudecli"]);

const Schema = z.object({
  RPC_URL: z.string().url(),
  WALLET_PRIVATE_KEY: z.string().min(32, "WALLET_PRIVATE_KEY missing or too short"),

  // POOL_ADDRESS controls the pool-selection mode:
  //   set    → "pinned" mode: bot manages this exact pool only
  //   empty  → "autonomous" mode: Sonnet picks the pool (persisted in SQLite)
  POOL_ADDRESS: z
    .string()
    .optional()
    .default("")
    .refine(
      (v) => v === "" || v.length >= 32,
      "POOL_ADDRESS must be empty or a valid base58 address",
    ),

  // SQLite database path. Defaults to ./data/bot.db (dir auto-created).
  DB_PATH: z.string().default("./data/bot.db"),

  MODE: Mode.default("dryrun"),
  LOG_LEVEL: LogLevel.default("info"),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

  // LLM provider — pick whichever you have a key for. The bot validates that
  // the matching key is set when the analyzer first runs.
  LLM_PROVIDER: LlmProvider.default("gemini"),
  LLM_MODEL: z.string().optional().default(""), // overrides provider's default

  GEMINI_API_KEY: z.string().optional().default(""),
  GROQ_API_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  // 0 = use the analyzer's per-cycle default (4096 daily/ad_hoc, 2048 intraday).
  // Bump this if you see "MAX_TOKENS" errors from the LLM provider.
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().nonnegative().default(0),

  // Scheduler — see src/scheduler.ts. Defaults match the design doc.
  SCHEDULER_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === "string" ? v.toLowerCase() !== "false" : v)),
  CRON_DAILY: z.string().default("0 8,21 * * *"),
  CRON_INTRADAY: z.string().default("0 0,4,12,16 * * *"),
  CRON_HEALTH: z.string().default("0 * * * *"),
  CRON_TZ: z.string().optional().default(""), // empty = system local

  // Single key, or comma-separated list to enable rotation on CU-exhaustion.
  // BIRDEYE_API_KEYS takes precedence when both are set.
  BIRDEYE_API_KEY: z.string().optional().default(""),
  BIRDEYE_API_KEYS: z.string().optional().default(""),

  MAX_DEPLOY_USD: z.coerce.number().positive().default(100),
  // Unused — execution is now immediate. Kept for back-compat with existing .env files.
  COUNTDOWN_SEC: z.coerce.number().int().positive().default(60),
  // Slippage tolerance applied to rebalance tx (active-bin slippage + add-liquidity slippage).
  REBALANCE_SLIPPAGE_PCT: z.coerce.number().positive().max(50).default(1.0),
  // Base bin-count tolerance for active-bin drift between simulation and on-chain
  // execution of the balanced rebalance path. SDK default is 3; raised to 15 to
  // absorb drift on volatile pools. Retries escalate this value (×2, ×3, capped
  // at 50) so the second/third attempt widens the on-chain check.
  MAX_BIN_SLIPPAGE: z.coerce.number().int().positive().max(50).default(15),
  // Retry attempts on the balanced rebalance path when the on-chain ix rejects with
  // ExceededBinSlippageTolerance (6004). Each retry sleeps briefly, re-simulates
  // against a fresh active bin, and rebuilds the ix with a widened slippage. 0 =
  // no retry; default 2 = 2 retries after the initial attempt.
  REBALANCE_MAX_RETRIES: z.coerce.number().int().nonnegative().max(5).default(2),
  // |requestedWidth − currentWidth| ≤ this value → balanced rebalance (re-center, fast).
  // Outside this band → close + reopen at the new width (3+ txs). 0 = always close+reopen.
  WIDTH_CHANGE_TOLERANCE_BINS: z.coerce.number().int().nonnegative().default(5),

  // Jupiter Ultra swap layer (Phase 9). Runs inside close+reopen path to align
  // wallet composition with the auto-derived target ratio for the new range.
  SWAP_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === "string" ? v.toLowerCase() !== "false" : v)),
  JUPITER_API_KEY: z.string().optional().default(""),
  SWAP_SLIPPAGE_BPS: z.coerce.number().int().positive().max(10_000).default(100),
  SWAP_MIN_USD: z.coerce.number().positive().default(1),
  // |targetXWeight − currentXWeight| in percentage points above which the
  // dispatcher forces close+reopen even when width is within tolerance.
  COMPOSITION_SHIFT_THRESHOLD_PCT: z.coerce.number().positive().max(100).default(10),

  // Read-only web dashboard (Phase 8). Bound to 127.0.0.1.
  DASHBOARD_ENABLED: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => (typeof v === "string" ? v.toLowerCase() !== "false" : v)),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3001),

});

export type Config = z.infer<typeof Schema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  cached = parsed.data;
  // Honor CRON_TZ for all subsequent Date ops + pino-pretty's SYS token, so
  // terminal logs and Telegram /sched render in the user's timezone instead
  // of UTC. Must run before logger.ts constructs pino().
  if (cached.CRON_TZ) {
    process.env.TZ = cached.CRON_TZ;
  }
  return cached;
}
