# DLMM Bot Improvement Plan — Rails + Intelligence (Pass 1)

## Context

Deep-dive into `@meteora-ag/dlmm` v1.9.10 (installed = latest) + bot code found the bot uses ~13 SDK methods out of a much larger surface, and has structural gaps that cap win-rate:

- **No feedback loop**: `action_log` records rebalance *cost* (tx fees, swap in/out USD) but is never joined with fees earned. Neither the LLM nor the operator can tell if past rebalances paid off.
- **LLM context gaps**: `PoolRow` (`src/data/meteora_api.ts:55-73`) already parses `volume24hUsd`, `fees24hUsd`, `feeTvlRatio4hPct`, `baseFeePct`, `hasFarm`, `farmApr` — `buildDecisionInput` (`src/ai/analyzer.ts:148-156`) drops all of them. SDK's `getDynamicFee()`/`getFeeInfo()`/`getBinsAroundActiveBin()` never called. No time-in-range history exists anywhere.
- **Unguarded live execution**: scheduled rebalances auto-execute in MODE=live with no approval (`maybeQueueRebalance` → `queueRebalance` fires inline, `src/scheduler.ts:147-187`); no cooldown (PLAN.md mentions `MIN_REBALANCE_INTERVAL_HOURS`, zero code); no circuit breaker (PLAN.md Phase 6 unbuilt).
- **Dead-position latency**: out-of-range position earns zero, can sit dead 4-8h until next scheduled cycle. `inRange` is computed (`src/dlmm/positions.ts:60`) but drives nothing. `hourly-check` posts full status every hour unconditionally (`src/scheduler.ts:191-249`) despite comment saying out-of-range-only.

This pass builds safety rails first (they gate everything that increases action frequency), then the intelligence layer. Later tiers (execution quality, limit orders, resize path) are listed in the appendix as the follow-up roadmap.

## What already exists — reuse, don't rebuild

- `proposeForApproval()` ✅/❌ button flow — `src/telegram/countdown.ts:51-104`
- `setPaused()` exported from `src/scheduler.ts`; `safe()` wrapper catches job errors
- Append-only `MIGRATIONS[]` in `src/state/db.ts` (8 entries; new tables start at 9)
- Meteora portfolio endpoint cumulative `totalFee` — `src/data/meteora_pnl.ts` `getPortfolio()`
- `actionLogRepo.recent()` — `src/state/repos.ts:294-376`
- `decisionRepo.recent(1)` for ad-hoc cooldown check
- `runAnalysis("ad_hoc")` cycle type already in schema
- Balanced-sim `binArrayRentLamports` already computed in `executeRebalance` — just not logged

## Step 1 — Safety rails (all S, independent)

### 1a. Rebalance cooldown
- `src/config.ts`: add `MIN_REBALANCE_INTERVAL_HOURS` (default 4).
- `src/state/repos.ts`: add `actionLogRepo.latest()` (variant of `recent(1)`).
- `src/scheduler.ts` `maybeQueueRebalance()`: if last action_log row younger than knob → skip + notify "cooldown active, Xh remaining". Manual `/decide` approval bypasses (leave `commands.ts` path untouched).

### 1b. Approval gate for scheduled rebalances
- `src/config.ts`: `APPROVAL_REQUIRED` (default **true** — flips current unsafe auto-exec default; user can set false to restore hands-off).
- `src/scheduler.ts:147-187`: when set, route to `proposeForApproval(decision, source)` instead of `queueRebalance`.
- `src/telegram/countdown.ts`: add 30-min expiry to `pendingApproval` (setTimeout → clear + edit message). Currently proposals never expire — stale range could execute on moved prices.

### 1c. Circuit breaker
- `src/config.ts`: `CIRCUIT_BREAKER_FAILS` (default 3).
- `src/telegram/countdown.ts` `fire()` catch + `src/scheduler.ts` `safe()` catch: increment module-level consecutive-failure counter; reset on success. At threshold → `setPaused(true)` + Telegram alert "paused — /resume to re-arm". No persistence across restarts (restart = legitimate reset).

### 1d. Hourly-check noise fix
- `src/config.ts`: `HEALTH_STATUS_EVERY_N` (default 6).
- `src/scheduler.ts` `hourlyCheckJob`: always log + write `range_check` row (step 2), but notify Telegram only when (a) out of range, (b) low SOL, or (c) every Nth tick.

## Step 2 — Time-in-range history (prereq for 3 & 5)

- `src/state/db.ts` migration 9: `range_check (id, checked_at, pool, in_range INTEGER, active_bin_id, bins_to_lower, bins_to_upper)`.
- `src/state/repos.ts`: `rangeCheckRepo` — `insert`, `recentStats(hours)` → `{pctInRange24h, pctInRange7d, consecutiveOutOfRange}`, `prune`.
- Written from `hourlyCheckJob` (status report already computes `inRange` + bin distances per position).

## Step 3 — Out-of-range reactive ad-hoc cycle

- `src/config.ts`: `OOR_TRIGGER_CHECKS` (default 2), `OOR_COOLDOWN_HOURS` (default 3).
- `src/scheduler.ts` `hourlyCheckJob`: after writing range_check row, if `consecutiveOutOfRange >= OOR_TRIGGER_CHECKS` and no `ad_hoc` decision in last `OOR_COOLDOWN_HOURS` → `runAnalysis("ad_hoc")` → notify → `maybeQueueRebalance(result, "oor-reactive")` (flows through cooldown 1a + approval 1b).
- Win: cuts dead-position time from hours to ~1-2h; out-of-range earns zero fees.

## Step 4 — Per-rebalance profitability ledger

- `src/state/db.ts` migration 10: add nullable columns to `action_log`: `meteora_total_fee_usd REAL`, `position_value_usd REAL`, `bin_array_rent_lamports INTEGER`.
- `src/dlmm/rebalance.ts` `logActionCost()` (~:927) + `executeClose()` (~:875): snapshot cumulative `totalFee` from `getPortfolio()` + current position USD value at execution. Non-fatal on fetch failure (nullable).
- New `src/rebalanceLedger.ts`: `buildEpisodes(limit)` — join consecutive action_log rows → per-episode `{startedAt, durationH, path, costUsd, feesEarnedUsd (Δ totalFee), netUsd, paidOff}` where `costUsd = solFees×solPrice + max(0, swapInUsd−swapOutUsd) + binArrayRent`. Aggregate `{episodes, totalCost, totalFees, netUsd, payoffRate}`.
- Surface in `/fees` output: `src/cli/fees.ts` + `src/telegram/commands.ts`.
- Caveat to encode in prompt text: fees-between-actions is directional signal, not strict attribution; first episode has no prior snapshot.

## Step 5 — LLM context enrichment

All in `DecisionInput` (`src/ai/types.ts`) + `buildDecisionInput` (`src/ai/analyzer.ts`) + interpretation guidance paragraph in `src/ai/prompts.ts`:

1. **Pool economics** (free — stop dropping PoolRow fields): `volume24hUsd`, `fees24hUsd`, `feeTvlRatio4hPct` (vs 24h = fee momentum), `baseFeePct`, `hasFarm`/`farmApr`.
2. **Dynamic fee** (SDK, helper in `src/dlmm/client.ts`): `pool.getDynamicFee()` + `pool.getFeeInfo()` → `{currentFeePct, baseFeePct, maxFeePct}`. Elevated dynamic fee = volatility surcharge active = high fee income now → informs hold-vs-roll timing.
3. **Bin liquidity depth** (SDK, daily/ad_hoc only): `pool.getBinsAroundActiveBin(20, 20)` compressed to `{binsBelowLiqUsd, binsAboveLiqUsd, activeBinLiqUsd, liquiditySkew}` — never dump 40 raw bins into prompt. Implement last within this step (nice-to-have).
4. **Time-in-range stats** from step 2 (`rangeCheckRepo.recentStats`).
5. **Ledger summary** from step 4 (`buildEpisodes(5)` compact form) + prompt guidance: "recent episodes net negative → raise your bar for ROLL/OPEN".
6. **Single-sided BidAsk prompt paragraph** (from roadmap 4.3, prompt-only): teach range-fully-below-active BidAsk = laddered dip-buy, fully-above = ladder out. `deriveTargetXWeight` already returns 100%/0% for out-of-range windows — machinery exists.

Intraday cycles get items 1/2/4/5 (skip bin-depth RPC); daily/ad_hoc get all.

## New config knobs (this pass)

`MIN_REBALANCE_INTERVAL_HOURS=4`, `APPROVAL_REQUIRED=true`, `CIRCUIT_BREAKER_FAILS=3`, `HEALTH_STATUS_EVERY_N=6`, `OOR_TRIGGER_CHECKS=2`, `OOR_COOLDOWN_HOURS=3`. Update `.env.example` + CLAUDE.md.

## Verification

- `npm run typecheck` + `npm run build` after each step.
- Rails: MODE=dryrun — run `npm run decide`, confirm scheduler path routes to approval proposal (mock by invoking `maybeQueueRebalance` with a rebalance decision); force 3 job failures → confirm auto-pause + alert.
- Migration: run bot once, then `sqlite3 ./data/bot.db "PRAGMA user_version"` → 10; insert fake range_check rows, verify `recentStats` math via `npm run status` path.
- Ledger: `sqlite3` insert two fake action_log rows with fee snapshots → `npm run fees` shows episode with correct netUsd.
- LLM context: `npm run decide` — inspect logged prompt JSON contains new fields; confirm token size stays sane for intraday (no bin dump).
- OOR cycle: temporarily set `OOR_TRIGGER_CHECKS=1` in dryrun, simulate out-of-range (or stub `inRange=false`), confirm ad_hoc analysis fires once then respects cooldown.

## Appendix — follow-up roadmap (not this pass)

Ordered, from the full research:

| # | Item | Size | Notes |
|---|---|---|---|
| 6 | Dynamic priority fee | S | `getRecentPrioritizationFees` 75th pctile, clamp, cache 30s; replace hardcoded 10k microlamports at `rebalance.ts:996-997`. Fixed CU limit 600k fine; fixed *price* is congestion risk. |
| 7 | Close+reopen checkpoint + `/recover` | M | Migration 11 `reopen_checkpoint` stage table; Telegram-confirmed resume of remaining steps; Jupiter retry 3× + non-fatal swap skip. Full auto-resume saga = over-engineering. |
| 8 | Soft cost gate | M | Extend `previewRebalance()` with projected cost (rent via `quoteCreatePosition`, tx fees, swap spread from realized action_log) vs expected fee gain; annotate + force approval when edge poor. Ship soft only; model too crude to hard-block. |
| 9 | Wire CLOSE verb → `proposeClose()` | S | confidence ≥ 0.8 gate; never auto-confirm. Today correct "get out" call degrades to pause and bleeds IL. |
| 10 | In-pool swap venue | M | `swapQuote`/`swap` vs Jupiter, pick better outAmount; gate `priceImpact > 0.5%` (also add gate to Jupiter leg — currently logged only). Modest edge (5-20bps). |
| 11 | Position resize path | M | `increase/decreasePositionLength` instead of close+reopen for pure width changes — needs verification spike (shrink-with-liquidity semantics; if unsupported, widen-only still valuable). |
| 12 | Limit orders | L | Execute existing `LIMIT_ORDERS_DESIGN.md`. Hard gate: check `isSupportLimitOrder(pool.lbPair)` on configured pool BEFORE writing code. Cut its use-case #2 (composition via resting order). |
| cut | Fee sweep job | — | Fees claimed on every close/reopen anyway; unclaimed fees not at risk, not compounding. |
| cut | Code-side volatility width engine | — | Already in prompt (`prompts.ts:206-218,268,291-298`); code formula would fight LLM. |
| cut | TWAP oracle, token2022 fee fields, generic `simulateRebalancePosition`, `getEmissionRate` on-chain reads | — | Irrelevant for SOL/USDC or marginal edge. |
