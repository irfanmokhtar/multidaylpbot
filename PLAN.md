# Multi-Day LP Bot — Meteora DLMM SOL/USDC Manager

## Context

A bot that manages a single Meteora DLMM liquidity position, with an LLM doing the thinking. The motivating problem: actively managing a DLMM position on a volatile asset like SOL is exhausting — you have to watch price action, decide when to re-center the range, pick a bin distribution that fits the regime, and execute the rebalance on-chain. Doing it manually means you either over-trade (paying gas + IL) or under-trade (drift out of range and earn no fees).

The intended outcome: a Node.js process running on your Mac that
1. Pulls SOL/USDC OHLCV + on-chain position state on a schedule,
2. Asks an LLM for a daily strategic read and lighter intraday checks,
3. When it recommends a rebalance, sends a Telegram message with reasoning and a 60-second countdown — you can `/cancel` if you disagree, otherwise it executes,
4. Notifies you of every action and outcome.

The bot manages a single, user-configured pool. Set `POOL_ADDRESS` in `.env` and that's the pool it manages. No pool-selection, no autonomous switching.

## Confirmed decisions

- **Execution gating**: notify-then-execute. Bot posts the proposed rebalance to Telegram with reasoning, waits 60s, executes unless `/cancel` is sent.
- **Strategy selection**: LLM picks Spot / Curve / Bid-Ask per rebalance based on regime (returned in the structured decision payload).
- **Pool**: fixed via `POOL_ADDRESS` in `.env`. To change pools, edit config and restart.
- **Hosting**: local Mac. Run via `pm2` or a `launchd` plist for restart-on-reboot.
- **Data sources**: free public Solana RPC + Birdeye free tier for OHLCV + Meteora data API for pool metadata (APR/TVL). CoinGecko as price fallback.
- **Wallet**: a fresh Solana keypair. Loaded via `Keypair.fromSecretKey(bs58.decode(env.WALLET_PRIVATE_KEY))`.

## Tech stack

- **Runtime**: Node.js 20+ / TypeScript (strict mode)
- **DLMM**: `@meteora-ag/dlmm` v1.9.x + `@solana/web3.js`
- **Wallet**: `bs58` for private-key decoding
- **AI**: Gemini 2.5 Flash (default), Groq Llama 3.3 70B, Claude Sonnet (SDK), or Claude via `claude --print` CLI — all via a common `LLMProvider` interface
- **Telegram**: `telegraf` (modern, async/await native)
- **Indicators**: `technicalindicators` (RSI, EMA, Bollinger, MACD, ATR)
- **Scheduling**: `node-cron`
- **State**: `better-sqlite3` (single-file local DB)
- **Logging**: `pino` + `pino-pretty`
- **Config**: `zod` + `dotenv`

## Architecture

```
src/
  config.ts                # zod-validated env: RPC_URL, WALLET_PRIVATE_KEY,
                           # POOL_ADDRESS, MODE, TELEGRAM_*, LLM_*, BIRDEYE_API_KEY,
                           # MAX_DEPLOY_USD, COUNTDOWN_SEC, MIN_REBALANCE_INTERVAL_HOURS,
                           # REBALANCE_SLIPPAGE_PCT, WIDTH_CHANGE_TOLERANCE_BINS
  poolMode.ts              # resolveActivePool() — returns POOL_ADDRESS or null
  wallet.ts                # Keypair load + signing helpers
  rpc.ts                   # Connection singleton
  dlmm/
    client.ts              # getDlmmPool() singleton, getActiveBinSummary()
    positions.ts           # getPortfolioSnapshot() → PortfolioSnapshot
    rebalance.ts           # executeRebalance() dispatcher (balanced | close-reopen)
                           # previewRebalance() / explainPreview() for proposals
                           # sendIxBundle() / sendBuiltTx() tx helpers
                           # readDepositableBalance() — SOL: wallet balance − reserve;
                           #   SPL: ATA balance
    strategy.ts            # centerWindow(), clampWidth(), mapStrategyType()
  data/
    birdeye.ts             # OHLCV fetch (1H/4H/1D) with throttle + 429 retry
    indicators.ts          # RSI, EMA, BB, MACD, ATR
    meteora_api.ts         # getPool(address) — single pool metadata snapshot
  indicatorsReport.ts      # runIndicatorsPass() + formatIndicatorsText/Html() (no LLM)
  ai/
    types.ts               # Decision (zod) + Signal, Scenario, DlmmSuggestion,
                           # CycleType, PriorReading, DecisionInput, LLMProvider
    prompts.ts             # buildSystemPrompt(), buildUserMessage(), DECISION_JSON_SCHEMA
    analyzer.ts            # runAnalysis(cycle) → AnalyzeResult
    llm.ts                 # getLlmProvider() — cached by cfg.LLM_PROVIDER
    providers/
      gemini.ts            # Gemini 2.5 Flash; thinkingBudget=1024, finishReason check
      groq.ts              # Llama 3.3 70B via Groq
      anthropic.ts         # Claude Sonnet via Anthropic SDK
      claudecli.ts         # Claude via `claude --print` CLI (subscription; no API key)
  telegram/
    bot.ts                 # Telegraf init, single-chat auth guard, notify()
    commands.ts            # /status /analyze /decide /cancel /pause /resume /sched /help
    countdown.ts           # queueRebalance(), cancelPending(), fire() with countdown
  state/
    db.ts                  # better-sqlite3 init + append-only migrations
    repos.ts               # decisionRepo, ohlcvRepo, indicatorReadingRepo
  scheduler.ts             # three node-cron jobs: daily-ta, intraday-ta, position-health
  index.ts                 # boot: config → wallet → DLMM → bot → scheduler
  cli/
    status.ts              # npm run status
    analyze.ts             # npm run analyze
    decide.ts              # npm run decide
```

### Decision flow (one cycle)

1. Scheduler fires (daily or intraday).
2. Fetch OHLCV from Birdeye (1H+4H for intraday; 1H+4H+1D for daily).
3. Fetch pool metadata from Meteora API (APR/TVL/fee metrics).
4. Fetch position state from DLMM SDK.
5. Compute indicator pack (RSI, EMA stack, BB, MACD, ATR).
6. Pull last 1 decision from SQLite.
5a. Persist compact 5-field indicator snapshot to `indicator_reading` table; load last 7 priors per timeframe as delta context (8 fetched, current skipped).
7. Send LLM a compact JSON payload: pool snapshot + positions[] + indicators (current) + priorReadings (7 prior snapshots per tf) + recent decisions + constraints.
8. LLM returns `Decision` via structured output. Validate against zod schema. Persist.
9. If `action === "hold"`: log + (daily) send Telegram summary.
10. If `action === "rebalance"`: post Telegram proposal with preview + 60s countdown. On timeout: execute. On `/cancel`: abort.
11. If `action === "claim_fees"`: execute immediately, notify on completion.
12. If `action === "pause"`: flip flag, notify, no auto-action until `/resume`.

### Rebalance execution

Dispatcher in `executeRebalance()` selects path based on `|requestedWidth − currentWidth|` vs `WIDTH_CHANGE_TOLERANCE_BINS`:

**Balanced path** (`delta ≤ tolerance`, 1–2 txs):
1. `simulateRebalancePositionWithBalancedStrategy(...)` — validates new range.
2. `rebalancePosition(...)` — re-centers existing position around active bin; width preserved.

**Close+reopen path** (`delta > tolerance`, 3+ txs):
1. `claimAllRewardsByPosition(...)` — LM rewards (no-op if no farm).
2. `removeLiquidity({shouldClaimAndClose: true})` — claims swap fees + closes position in one shot. SOL auto-unwraps.
3. Read post-close wallet balances:
   - SOL side: `connection.getBalance(wallet)` − `SOL_RESERVE_LAMPORTS` (0.05 SOL).
   - SPL side: `getAssociatedTokenAddressSync` + `getTokenBalance`.
4. `centerWindow(activeBinId, rangeWidthBins)` → new `{minBinId, maxBinId}`.
5. Scale down if post-close value exceeds `MAX_DEPLOY_USD`.
6. `initializePositionAndAddLiquidityByStrategy(...)` with fresh `Keypair`.
7. Notify Telegram: path, new range, signatures, Solscan links. Warn if underfunded.

Bin range math lives in `dlmm/strategy.ts`:
- `centerWindow(activeBinId, widthBins)` → `{minBinId, maxBinId, width}`, symmetric, clamped to [5, 2000].
- `mapStrategyType(str)` maps `"Spot" | "Curve" | "BidAsk"` → SDK `StrategyType` enum.

### Safety guards

- Single Telegram chat ID hard-allowlisted — all other senders silently ignored.
- `MAX_DEPLOY_USD` cap — bot scales down deposit rather than abort if exceeded.
- `REBALANCE_SLIPPAGE_PCT` — applied to both paths (default 1%).
- `WIDTH_CHANGE_TOLERANCE_BINS` — prevents churning close+reopen for minor width drift (default 5 bins).
- `SOL_RESERVE_LAMPORTS` (50,000,000 = 0.05 SOL) — held back from SOL deposit to cover tx fees and rent.
- `MIN_REBALANCE_INTERVAL_HOURS` — passed to LLM as a constraint in live mode; 0 in dryrun so analysis is honest.
- Private key read once at boot; never logged, never serialized into prompts or messages.
- `MODE=dryrun` (default) — no on-chain execution; proposals notify-only.

## Schedule (default cron)

| Job | Cadence | What it does |
|---|---|---|
| `daily-ta` | `0 9 * * *` | Full TA (1H+4H+1D) + LLM decision + Telegram report; always notifies |
| `intraday-ta` | `0 */4 * * *` | Light TA (1H+4H); notifies only if `action ≠ hold` |
| `position-health` | `0 * * * *` | Read active bin + range; Telegram alert if out of range |

## Phased build

1. **Foundation** ✅ — project scaffold, config + wallet, RPC, DLMM read-only, CLI `npm run status`.
2. **Telegram skeleton** ✅ — Telegraf bot with `/status`. No analysis.
3. **Data + indicators** ✅ — Birdeye client, indicator pack, SQLite. `npm run analyze` CLI.
4. **LLM analyzer (dry-run)** ✅ — prompts + structured-output decisions; execution stubbed — logs + Telegram-reports what it *would* do. `npm run decide` CLI.
4.5. **Dry-run scheduler** ✅ — three cron jobs; `/pause` / `/resume` commands; Gemini MAX_TOKENS fix (`thinkingBudget=1024`, `finishReason` check, per-cycle token budgets).
5. **Rebalance execution** ✅ — `countdown.ts` (notify-then-execute), `rebalance.ts` (balanced + close+reopen), `/cancel` command. `WIDTH_CHANGE_TOLERANCE_BINS` config. In `MODE=dryrun` proposals are notify-only; `MODE=live` arms the timer.
6. **Safety guards** — rebalance cooldown enforcement (currently advisory via LLM prompt), circuit breaker (3 consecutive failed txs → auto-pause), fee sweep when accrued > $1.
7. **P&L tracking** ✅ — `/pnl` Telegram command + `npm run pnl` CLI + `/api/pnl` dashboard route. Sourced from Meteora indexer (`portfolio` + `positions/{pool}/pnl` + `total_claims`); `pnlUsd` = (withdrawals + currentValue + unclaimedFees) − deposits, rolling in IL, fees, and Jupiter swap slippage. 60s in-memory cache. Renderers in `src/pnlReport.ts`.
8. **Web dashboard** ✅ — read-only localhost dashboard. See section below.

## SDK references

`@meteora-ag/dlmm` (v1.9.x):
- `DLMM.create(connection, poolAddress)` — instantiate
- `dlmmPool.getActiveBin()` — current bin + price
- `DLMM.getPositionsByUserAndLbPair(connection, user, pair)` — positions
- `dlmmPool.simulateRebalancePositionWithBalancedStrategy(...)` — dry-run balanced rebalance
- `dlmmPool.rebalancePosition(...)` — execute balanced rebalance
- `dlmmPool.claimAllRewardsByPosition({owner, position})` — LM rewards
- `dlmmPool.removeLiquidity({user, position, fromBinId, toBinId, bps, shouldClaimAndClose})` — withdraw + close
- `dlmmPool.initializePositionAndAddLiquidityByStrategy({positionPubKey, totalXAmount, totalYAmount, strategy, user, slippage})` — open new position
- `dlmmPool.getTokenBalance(conn, tokenAccount)` — SPL token balance

## Verification

1. **Read-only** — `npm run dev` with `MODE=dryrun`. `/status` shows position + indicators match Birdeye.
2. **LLM quality** — run dryrun 24-48h. Eyeball reasoning: does it pick Curve in tight ranges, Spot in choppy ones? Does confidence track signal clarity?
3. **Balanced rebalance** — `MODE=live`, small capital. Force `/decide` until `rebalance` decision within `WIDTH_CHANGE_TOLERANCE_BINS` of current width. Confirm Telegram shows `path: balanced`; verify Solscan shows 1–2 txs. Verify `/cancel` aborts cleanly.
4. **Close+reopen** — temporarily set `WIDTH_CHANGE_TOLERANCE_BINS=0`. Force `/decide`. Confirm Telegram shows `path: close+reopen` and new window. Solscan: claim-rewards tx(s) + removeLiquidity tx(s) + initialize tx. `/status` after shows new position pubkey + new range.
5. **Failure paths** — kill RPC mid-run (should surface error via Telegram); `/cancel` during countdown; send command from non-allowlisted Telegram account (should be ignored).

## Phase 8 — Read-only web dashboard ✅

A localhost-only observability UI at `http://127.0.0.1:3001`. Telegram remains the sole control surface; the dashboard exists to visualize state that chat messages can't render densely.

**What it shows**:
- Live position state, range vs active bin, USD value (Overview)
- LLM decision history with full reasoning, confidence, action pill, raw LLM input (Decisions)
- OHLCV + indicator timeseries — 1H/4H/1D, EMA20/EMA50/BB/RSI/MACD (Indicators)
- Scheduler/job status, paused flag, next-run timestamps, Telegram command reference (Schedule)
- P&L view: fees claimed, unclaimed, USD PnL vs cost basis, per-position history drawer (Phase 7)

**Architecture**: Fastify embedded in the existing Node process. Reuses `loadConfig()`, `getDb()`, `getDlmmPool()` singletons — no IPC. Bound to `127.0.0.1` only; no auth.

**Stack**:
- Backend: Fastify 5 + `@fastify/static`. Seven read-only GET routes. No SSE (polling via react-query).
- Frontend: Vite 6 + React 18 + `@tanstack/react-query`. No Tailwind, no component library. Custom CSS design system (`web/src/styles.css`) with IBM Plex Sans/Mono, warm-paper light mode (`body.light`), full dark/light CSS variable set. All charts are inline SVG.
- Light/dark: `ThemeToggle` component in topbar. Persisted to `localStorage`.

**Endpoints (read-only, all GET)**:
`/api/status`, `/api/decisions?limit&before`, `/api/decisions/:id`, `/api/indicators`, `/api/ohlcv?interval=1H|4H|1D`, `/api/pool`, `/api/scheduler`, `/api/health`, `/api/pnl`, `/api/pnl/history?positionAddress=…`

**Build wiring**: `npm run build` runs `tsc` then `cd web && npm run build` (outputs to `dist/web/`). Dev: `npm run dev` runs the bot at `:3001`; `npm run dev:web` runs Vite at `:5174` proxying `/api` to `:3001`.

**Config additions**: `DASHBOARD_ENABLED` (default true), `DASHBOARD_PORT` (default 3001), `DASHBOARD_HOST` (default 127.0.0.1).

## Out of scope (deliberate)

- Pool switching or autonomous pool selection — bot manages one configured pool only
- Multiple pairs simultaneously
- Auto-compounding fees back into liquidity
- IL hedging via perps
- Mutations from the dashboard (pause/cancel/decide) — Telegram only
- Public hosting of the dashboard (Tailscale tunnel possible later, would need token auth)
- Multi-wallet support
