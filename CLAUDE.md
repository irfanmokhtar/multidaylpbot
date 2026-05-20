# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Meteora DLMM LP manager for a single configured pool. A Node.js process polls OHLCV data + on-chain position state, asks an LLM (Gemini 2.5 Flash by default) for a decision, then notifies via Telegram with a countdown before executing on-chain. Full design rationale and phased build plan are in `PLAN.md`.

**Current build phase: 8** — read-only web dashboard live at `http://127.0.0.1:3001` (default). Fastify server embedded in bot process. Vite+React frontend with IBM Plex typography, custom CSS design system, light/dark mode. All prior phases complete.

## Commands

```bash
npm run dev          # start bot with live-reload (tsx watch); dashboard at :3001
npm run build        # compile TypeScript + build Vite frontend → dist/
npm run build:web    # build frontend only (web/ → dist/web/)
npm run typecheck    # type-check bot TypeScript
npm run typecheck:web # type-check web frontend
npm run start        # run compiled dist/index.js
npm run dev:web      # Vite dev server at :5174 (proxies /api → :3001)

# One-shot CLI tools (no bot required)
npm run status       # dump current pool + position state
npm run analyze      # raw indicator pass (OHLCV + RSI/EMA/BB/MACD/ATR; no LLM)
npm run decide       # full analyzer pass including LLM decision
npm run pnl          # fees collected + USD PnL via Meteora indexer
```

SQLite inspection:
```bash
sqlite3 ./data/bot.db "SELECT decided_at, cycle, action, confidence FROM decision ORDER BY decided_at DESC LIMIT 10"

# Prior indicator readings (delta cache)
sqlite3 ./data/bot.db "SELECT symbol, interval, datetime(taken_at/1000,'unixepoch'), close, rsi14, ema20, bb_pct_b, macd_hist FROM indicator_reading ORDER BY taken_at DESC LIMIT 20"
```

## Architecture

```
src/
  config.ts          — zod-validated env; single loadConfig() call, cached
  poolMode.ts        — resolveActivePool() — returns POOL_ADDRESS or null
  wallet.ts          — Keypair load from WALLET_PRIVATE_KEY (base58)
  rpc.ts             — Connection singleton
  logger.ts          — pino instance
  tokens.ts          — token metadata helpers (isStablecoin, symbol)
  report.ts          — buildStatusReport() + text/HTML renderers (shared by CLI + Telegram);
                       text renderer optionally embeds renderBinChart() per position
  indicatorsReport.ts — runIndicatorsPass() + formatIndicatorsText/Html() (shared by CLI + /analyze)
  scheduler.ts       — three node-cron jobs: daily-ta, intraday-ta, position-health
  pnlReport.ts       — buildPnlReport() + formatPnlText/Html() (Meteora-indexed PnL view)
  index.ts           — boot: config → wallet → DLMM → bot → scheduler

  dlmm/
    client.ts        — getDlmmPool() singleton, getActiveBinSummary()
    positions.ts     — getPortfolioSnapshot() → PortfolioSnapshot
    rebalance.ts     — executeRebalance() dispatcher; balanced + close-reopen paths
                       previewRebalance() / explainPreview() for Telegram proposals
    strategy.ts      — priceToBinId(), priceBoundsToWindow(), mapStrategyType();
                       MIN_RANGE_WIDTH=5 / MAX_RANGE_WIDTH=343 constants
    composition.ts   — deriveTargetXWeight() + currentXWeight() for swap sizing
    binChart.ts      — renderBinChart(): unicode-block per-bin liquidity sparkline
                       embedded in /status text output

  swap/
    jupiter.ts       — Jupiter Ultra v1 client; swapTokensToTargetRatio() orchestrator

  data/
    birdeye.ts       — fetchOhlcv({ interval, candles }); 1.1s throttle, 429 retry,
                       multi-key rotation on CU/quota exhaustion (BIRDEYE_API_KEYS)
    indicators.ts    — computeIndicators(candles) → RSI, EMA, BB, MACD, ATR
    meteora_api.ts   — getPool(address); base URL https://dlmm.datapi.meteora.ag
    meteora_pnl.ts   — portfolio/PnL/total_claims/historical fetchers (same host)

  ai/
    types.ts         — Decision schema (zod) + Signal, Scenario, DlmmSuggestion,
                       CycleType, PriorReading, DecisionInput, LLMProvider
    prompts.ts       — buildSystemPrompt(), buildUserMessage(), DECISION_JSON_SCHEMA
    analyzer.ts      — runAnalysis(cycle) → AnalyzeResult; formatDecisionText/Html()
    llm.ts           — getLlmProvider() — returns cached LLMProvider by cfg.LLM_PROVIDER
    providers/
      gemini.ts      — Gemini 2.5 Flash; thinkingBudget=1024, finishReason check
      groq.ts        — Llama 3.3 70B via Groq
      anthropic.ts   — Claude Sonnet via Anthropic SDK
      claudecli.ts   — Claude via `claude --print` CLI (subscription; no API key)

  state/
    db.ts            — better-sqlite3 init + sequential migrations via user_version pragma
    repos.ts         — decisionRepo, ohlcvRepo, indicatorReadingRepo

  telegram/
    bot.ts           — Telegraf init, single-chat auth guard, notify()
    commands.ts      — /status /pnl /analyze /decide /cancel /pause /resume /sched /help
    countdown.ts     — queueRebalance(), cancelPending(), fire() with countdown timer

  web/
    server.ts        — Fastify init; registers routes; serves dist/web/ as SPA
    routes/
      status.ts      — GET /api/status → PortfolioSnapshot + mode + wallet
      health.ts      — GET /api/health → uptime, db size, mode, paused flag
      decisions.ts   — GET /api/decisions?limit&before, GET /api/decisions/:id
      indicators.ts  — GET /api/indicators → last IndicatorPack per timeframe
      ohlcv.ts       — GET /api/ohlcv?interval=1H|4H|1D → cached OhlcvSnapshot
      pool.ts        — GET /api/pool → Meteora API pool metadata
      scheduler.ts   — GET /api/scheduler → job list + enabled/paused state
      pnl.ts         — GET /api/pnl, GET /api/pnl/history?positionAddress=…

  cli/
    status.ts / analyze.ts / decide.ts / pnl.ts

web/                 — Vite+React frontend (separate package)
  src/
    App.tsx          — grid layout: Sidebar + Topbar + routed page
    styles.css       — design tokens (dark default + body.light override), layout primitives
    components/
      Sidebar.tsx    — nav + brand mark + wallet foot
      Topbar.tsx     — pair chip, mode badge, theme toggle, live/paused status
      atoms.tsx      — ActionPill, ConfBar, AddressChip, KpiTile
      BinRangeViz.tsx — per-bin liquidity chart (curve/spot/bid-ask; in/out-of-range)
      Charts.tsx     — CandleChart, RsiChart, MacdChart (inline SVG)
      icons.tsx      — small SVG icon set
    pages/
      Overview.tsx   — KPI tiles, position range, last decision, pool vitals, 4H candles
      Decisions.tsx  — filterable table + detail drawer with raw LLM input
      Indicators.tsx — 1H/4H/1D panels: candles + EMA/BB + RSI + MACD
      Schedule.tsx   — cron job table, paused banner, Telegram command reference
      Pnl.tsx        — fees + USD PnL view, sourced from Meteora indexer
    lib/
      api.ts         — fetch wrappers for all /api/* routes
      queries.ts     — @tanstack/react-query hooks (useStatus, useDecisions, useOhlcv, …)
      schemas.ts     — frontend mirrors of backend response shapes
      types.ts       — shared types (Candle, IndicatorBundle, Action, CycleType, …)
      format.ts      — fmt helpers (usd, num, pct, addr)
      mocks.ts       — static mock data + indicator compute functions (fallback when API offline)
```

## Pool configuration

Set `POOL_ADDRESS` in `.env` to the Meteora DLMM pair address. The bot manages that pool only. Without `POOL_ADDRESS` the bot boots but cannot fetch position state or run TA.

## LLM provider selection

Set `LLM_PROVIDER=gemini|groq|anthropic|claudecli` and the matching `*_API_KEY`. Provider is cached after first call. `LLM_MODEL` overrides the provider's default. `LLM_MAX_OUTPUT_TOKENS=0` uses per-cycle defaults (4096 daily, 2048 intraday).

**claudecli**: no API key needed — shells out to `claude --print` using your active Claude Code subscription. No structured tool-use; JSON extracted from stdout. Requires `claude` CLI on PATH and an authenticated session.

**Gemini gotcha**: thinking tokens count against `maxOutputTokens`. If you see `"Gemini hit MAX_TOKENS"` or JSON parse errors with truncated output, bump `LLM_MAX_OUTPUT_TOKENS`.

## Decision flow

`runAnalysis(cycle)` in `src/ai/analyzer.ts`:
1. Fetch OHLCV from Birdeye (1H+4H for intraday; 1H+4H+1D for daily)
2. Compute indicator pack; persist compact 5-field snapshot to `indicator_reading` table
3. Load last 5 prior indicator readings per timeframe as delta context (fetches 6, skips the just-inserted current)
4. Fetch current pool snapshot from Meteora API (APR/TVL/fee metrics)
5. Fetch position state from DLMM SDK (all open positions as array)
6. Pull last 1 decision from SQLite; fetch BTC 1D candles for macro trend context (EMA20/EMA50)
7. Send to LLM as structured JSON; validate response against `Decision` zod schema
8. Persist to `decision` table, prune old rows

## Decision schema

`Decision` zod schema in `src/ai/types.ts`. Key fields:

| Field | Notes |
|---|---|
| `action` | `hold\|rebalance\|claim_fees\|pause` — execution signal |
| `strategyType` | `Spot\|Curve\|BidAsk` — required when rebalancing. Curve=ranging/mean-reversion, Spot=high vol/breakout, BidAsk=falling knife/catch edges |
| `lowerBoundPrice` / `upperBoundPrice` | absolute USD floats — required when rebalancing. Executor converts to bin range; derived width must be ∈ [5, 343] or decision is rejected |
| `confidence` | 0–1 |
| `keyLevels` | `{support, resistance}` — optional absolute USD price levels |
| `headline` | 1–2 sentences, top-line development this cycle |
| `dlmm` | `{verb, detail}` — always required; verb: `HOLD\|ROLL\|OPEN\|CLOSE` |
| `reasoning` | ≤1500 chars narrative |
| `signals` | 3–6 labelled signals (bullish/bearish/caution/structural) — daily/ad_hoc only |
| `scenarios` | bull/base/bear with priceTarget + probabilityPct summing to 100 — daily/ad_hoc only |

**DLMM verb mapping**: `HOLD→hold`, `ROLL→rebalance` (balanced path), `OPEN→rebalance` (close+reopen), `CLOSE→pause`.

**Price-bound guidance**: system prompt (`buildSystemPrompt()` in `src/ai/prompts.ts`) generates pool-specific price-band exemplars (`$lo – $hi` per width tier) from `binStep` + `activeBinPrice`, plus derived bin counts so the LLM sees tick resolution. The LLM emits `lowerBoundPrice`/`upperBoundPrice` (absolute USD); `priceBoundsToWindow()` in `src/dlmm/strategy.ts` first normalizes UI price to raw price via `price * 10^(yDec − xDec)`, then calls `DLMM.getBinIdFromPrice` (floors lower, ceils upper) — required for non-9-decimal token pairs. Enforces width ∈ [`MIN_RANGE_WIDTH`=5, `MAX_RANGE_WIDTH`=343] — no silent clamping, decision is rejected on violation. Cap derived from `DEFAULT_BIN_PER_POSITION` (70) + 3 × `MAX_RESIZE_LENGTH` (91) — Solana tx-size + realloc-CPI ceiling.

## Rebalance execution paths

Dispatcher in `executeRebalance()` derives `requestedWidth` from price bounds via `priceBoundsToWindow()`, then checks two triggers:

1. `|requestedWidth − currentWidth| > WIDTH_CHANGE_TOLERANCE_BINS` (default 5)
2. `|targetXWeight − currentXWeight| > COMPOSITION_SHIFT_THRESHOLD_PCT` (default 10pp) — auto-derived from the new range × strategy × active bin (see Swap layer)

If either trigger fires, dispatch close+reopen; otherwise balanced re-center.

- **Balanced** (no trigger): `simulateRebalancePositionWithBalancedStrategy` + `rebalancePosition` — re-centers existing position without closing it (1–2 txs). LLM verb: `ROLL`. Cannot change deposit composition.
- **Close + reopen** (trigger fires): `claimAllRewardsByPosition` → `removeLiquidity(shouldClaimAndClose:true)` → read post-close balances → **Jupiter Ultra swap to target X:Y ratio** → re-read balances → reopen at the LLM's price-bound-derived `{minBinId, maxBinId}`. LLM verb: `OPEN`. Reopen has two sub-paths gated on `window.width`:
  - `width ≤ 70` (`DEFAULT_BIN_PER_POSITION`): single-shot `initializePositionAndAddLiquidityByStrategy` (1 tx, SOL wrap bundled).
  - `width > 70`: `initializePosition2` + N×`increasePositionLength2` in one create-and-extend tx (each chunk ≤ `MAX_RESIZE_LENGTH`=91 bins), then manual SOL wrap if native, then chunked `addLiquidityByStrategyChunkable` txs (one per 70-bin chunk). Necessary because the single-shot init ix's CPI realloc overruns Solana's 10240-byte inner-realloc cap. Before the wrap step, native deposit amounts (`totalXAmount` / `totalYAmount`) are re-clamped to `readDepositableBalance` so the post-create-and-extend rent deduction (~28M lamports for a 94-bin position) does not cause the wrap-SOL transfer to overdraw and fail simulation with `Transfer: insufficient lamports`.

  Window is recomputed against the live active bin at execution time so bound-to-bin mapping is current.

`previewRebalance()` runs the read-only check before queuing; surfaces `path`, `widthDelta`, derived bin range, `activeBinInside` flag, `targetXWeight`, `currentXWeight`, `compositionDeltaPp`, `pathTrigger`, and any `boundsError`.

**Note**: execution is gated to a single position — throws if `userPositions.length > 1`. All positions are visible to the LLM (sent as array), but only one can be acted on per cycle.

## Swap layer (Jupiter Ultra)

`src/swap/jupiter.ts` wraps Jupiter Ultra v1 (`/ultra/v1/order` + `/ultra/v1/execute`). Free tier uses `lite-api.jup.ag`; setting `JUPITER_API_KEY` switches to `api.jup.ag` with `x-api-key`.

Composition derivation in `src/dlmm/composition.ts`:
- `deriveTargetXWeight({window, activeBinId, strategyType})` — USD-share basis. Active bin OUTSIDE the range → 100% one side. Inside the range, per-bin weights: Spot=uniform, Curve=triangular peak at active bin, BidAsk=inverse (peaks at edges). Bins above the active hold X; bins at-or-below hold Y. Summing weights on each side gives the USD-share split.
- `currentXWeight({balX, balY, ...})` — current X-USD share from a (balX, balY) pair; Y treated as $1 anchor when stablecoin.

Orchestrator `swapTokensToTargetRatio` runs inside the close+reopen path between `removeLiquidity` and `initializePositionAndAddLiquidityByStrategy`. Computes `deltaUsd = currentXUsd − targetXUsd`, swaps the heavy side via Jupiter, re-reads balances. Skips when `|deltaUsd| < SWAP_MIN_USD` (default $1) or when `SWAP_ENABLED=false`. Slippage tolerance controlled by `SWAP_SLIPPAGE_BPS` (default 100 = 1%).

## PnL layer (Meteora indexer)

`src/pnlReport.ts` builds the wallet's fees + USD-PnL view by stitching three Meteora data-API endpoints together (fetchers in `src/data/meteora_pnl.ts`):

- `GET /positions/{pool}/pnl?user={wallet}` — per-position deposits / withdrawals / fees / unrealized PnL.
- `GET /portfolio?user={wallet}` — pool-level aggregate (used as the headline since it covers closed positions even after their indexed row drops out of the per-position list).
- `GET /wallets/{wallet}/pools/{pool}/total_claims` — fee-claim counts + last-claim timestamp.

Meteora's `pnlUsd` = (allTimeWithdrawals + currentValue + unclaimedFees) − allTimeDeposits, priced with historical per-event USD oracles. This is exactly the "vs cost-basis" frame — IL, fees, and Jupiter swap slippage are all rolled in (swaps appear as the USD gap between consecutive close-withdrawal and reopen-deposit events). No on-chain ledger needed.

`buildPnlReport({force?})` caches results 60s per (wallet,pool) key. Renderers: `formatPnlText` (CLI + Telegram), `formatPnlHtml` (Telegram wrapper). The dashboard hits `/api/pnl` (60s `staleTime`) and `/api/pnl/history?positionAddress=…` (lazy, on drawer open). Telegram exposes `/pnl`; CLI exposes `npm run pnl`.

`MODE=dryrun` doesn't affect PnL — Meteora reflects on-chain reality regardless of bot mode.

## SQLite schema

Migrations append-only in `src/state/db.ts` — never edit existing entries.

| Table | Purpose |
|---|---|
| `current_pool` | Legacy table (no longer written; kept for schema continuity) |
| `ohlcv_snapshot` | Cached raw OHLCV candles |
| `decision` | Every LLM decision with full input/output JSON for replay |
| `indicator_reading` | Compact 5-field snapshots per (symbol, interval) for LLM delta context |

## Scheduler jobs

| Job name | Default cron | Behavior |
|---|---|---|
| `daily-ta` | `0 8,21 * * *` | Full TA + LLM decision + Telegram report (always notifies) |
| `intraday-ta` | `0 0,4,12,16 * * *` | Light TA; notifies only if `action ≠ hold`. On hold, logs full `reasoning` + `headline` + `dlmm` verb/detail at info level (no truncation) |
| `hourly-check` | `0 * * * *` | Checks SOL balance (alerts below 0.1 SOL), sends full status report if pool set, alerts if any position is out of range |

Pause/resume via `/pause` and `/resume` Telegram commands, or `setPaused()` from `src/scheduler.ts`. Cron jobs keep ticking but short-circuit when paused.

## Safety constraints (enforced in code, not just config)

- Single Telegram `CHAT_ID` allowlist in `src/telegram/bot.ts`
- `MAX_DEPLOY_USD` cap on close+reopen path — scales down deposit if post-close balance would exceed it
- `REBALANCE_SLIPPAGE_PCT` — slippage tolerance on rebalance txs (default 1%)
- `WIDTH_CHANGE_TOLERANCE_BINS` — controls balanced vs close+reopen dispatch (default 5)
- `SOL_RESERVE_LAMPORTS` (50_000_000 = 0.05 SOL) — always held back from SOL balance before redeposit

## Web dashboard

Dashboard starts automatically with `npm run dev` / `npm run start`. Bound to `127.0.0.1` — not reachable remotely without a tunnel.

- API endpoints: all `GET /api/*`, read-only, no auth.
- Frontend build output: `dist/web/` (SPA, served by Fastify's static plugin).
- Dev mode: `npm run dev:web` starts Vite at `:5174`; it proxies `/api` to `:3001`.
- Light/dark: `ThemeToggle` in topbar flips `body.light`; persisted in `localStorage` as `waza.theme`.
- Indicators page computes EMA/RSI/BB/MACD client-side from OHLCV candles; falls back to mock data if API returns 404.

## Key env vars

See `.env.example` for full list. Minimum to start the bot:
```
RPC_URL, WALLET_PRIVATE_KEY, POOL_ADDRESS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```
Optional dashboard config: `DASHBOARD_ENABLED` (default true), `DASHBOARD_PORT` (default 3001). Host is hardcoded to `127.0.0.1`.

Swap layer: `SWAP_ENABLED` (default true), `JUPITER_API_KEY` (optional — free tier works without), `SWAP_SLIPPAGE_BPS` (default 100), `SWAP_MIN_USD` (default 1), `COMPOSITION_SHIFT_THRESHOLD_PCT` (default 10).

Scheduler: `CRON_DAILY` (default `0 8,21 * * *`), `CRON_INTRADAY` (default `0 0,4,12,16 * * *`), `CRON_HEALTH` (default `0 * * * *`), `CRON_TZ` (empty = system local, e.g. `Asia/Kuala_Lumpur`), `SCHEDULER_ENABLED` (default true). Note: `CRON_TZ` is also assigned to `process.env.TZ` at config-load so all subsequent `Date` ops + pino-pretty timestamps render in that zone.

Birdeye OHLCV: `BIRDEYE_API_KEY` (single) or `BIRDEYE_API_KEYS` (comma-separated). When multiple keys are set, the client auto-rotates on 429 or 4xx bodies matching `compute unit | cu limit | rate limit | quota | upgrade your plan` — useful for stretching the free Standard tier's per-key CU budget. `BIRDEYE_API_KEYS` takes precedence.

Set `MODE=dryrun` (default) for safe testing — no on-chain execution.
