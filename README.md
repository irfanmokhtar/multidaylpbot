# Meteora DLMM LP Bot

Autonomous LP manager for a single [Meteora DLMM](https://app.meteora.ag) pool. A Node.js process polls OHLCV data and on-chain position state, asks an LLM for a rebalance decision, sends the proposal to Telegram for approval, then executes on-chain. Backend-only: Telegram control plane + CLI tools, no web dashboard.

## What it does

1. **TA cycle** — fetches 1H/4H/1D OHLCV from Birdeye, computes RSI/EMA/BB/MACD/ATR + volume, pulls BTC macro context, reads your open DLMM position, and sends everything to an LLM.
2. **Decision** — LLM returns a structured `Decision` (`hold | rebalance | claim_fees | pause`) with price bounds, strategy type, and reasoning.
3. **Execution** — on `rebalance` (MODE=live), the bot sends an approval prompt to Telegram. After you approve it closes + reopens the position (or balanced re-centers if the shift is minor), swapping via Jupiter Ultra to align composition with the target range. Each rebalance's tx fees + swap cost are logged.
4. **Reporting** — Meteora-indexed USD PnL plus a local cost-basis "True P&L" baseline, surfaced over Telegram (`/pnl`, `/fees`) and CLI (`npm run pnl`, `npm run fees`).

## Requirements

- Node.js ≥ 20
- A Solana wallet with SOL + the pool's tokens
- A [Meteora DLMM](https://app.meteora.ag) pool address
- A Telegram bot token + chat ID
- At least one LLM API key (Gemini free tier is sufficient)
- A [Birdeye](https://birdeye.so/developers) API key (free Standard tier works)

## Setup

```bash
git clone <repo>
cd multidaylpbot
npm install
cp .env.example .env
# edit .env — see Configuration below
```

## Configuration

Minimum required `.env`:

```env
RPC_URL=https://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=<base58-encoded-secret-key>
POOL_ADDRESS=<meteora-dlmm-pair-address>
TELEGRAM_BOT_TOKEN=<token-from-@BotFather>
TELEGRAM_CHAT_ID=<your-chat-id>
```

### LLM provider

Set `LLM_PROVIDER` to one of:

| Value | Model | Cost |
|---|---|---|
| `gemini` (default) | Gemini 2.5 Flash | Free tier: 1,500 RPD |
| `groq` | Llama 3.3 70B | Free tier: 1,000 RPD |
| `anthropic` | Claude Sonnet | Paid (~$3–5/month) |
| `claudecli` | Claude via `claude --print` | Uses your Claude Code subscription |

Set the matching key (`GEMINI_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`). `claudecli` needs no key — shells out to the `claude` CLI.

### Mode

```env
MODE=dryrun   # default — no on-chain execution; full TA + Telegram notifications work
MODE=live     # enables on-chain rebalance after Telegram countdown
```

### Key knobs

```env
MAX_DEPLOY_USD=100              # cap on USD deployed per close+reopen
REBALANCE_SLIPPAGE_PCT=1.0      # slippage tolerance on rebalance txs
WIDTH_CHANGE_TOLERANCE_BINS=5   # bin-width delta below which re-center is used instead of close+reopen
SWAP_ENABLED=true               # swap via Jupiter Ultra to align composition before reopening
SWAP_SLIPPAGE_BPS=100           # 1% slippage tolerance on Jupiter swaps
COMPOSITION_SHIFT_THRESHOLD_PCT=10  # composition delta (pp) that forces close+reopen
```

### Scheduler

```env
CRON_DAILY=0 8,21 * * *         # full TA + Telegram report (always notifies)
CRON_INTRADAY=0 0,4,12,16 * * * # light TA (notifies only when action != hold)
CRON_HEALTH=0 * * * *           # hourly: SOL balance + status + out-of-range alert
CRON_TZ=Asia/Kuala_Lumpur       # empty = system local time
```

## Running

```bash
npm run dev          # start bot (live-reload via tsx watch)
npm run start        # run compiled build (npm run build first)
```

One-shot CLI tools (no bot required):

```bash
npm run status         # current pool + position state
npm run analyze        # indicator pass (no LLM)
npm run decide         # full analyzer pass including LLM decision
npm run pnl            # fees + USD PnL (Meteora indexer) + True P&L cost-basis view
npm run fees           # recent rebalance costs (tx fees + swap slippage)
npm run reset-baseline # re-anchor the True P&L baseline to the current position
```

## Telegram commands

| Command | Description |
|---|---|
| `/status` | Pool snapshot + position state |
| `/analyze` | Run indicator pass + LLM decision |
| `/decide` | Run full analysis; send approval prompt if rebalance recommended (MODE=live) |
| `/pnl` | Fees + USD PnL + True P&L (cost-basis) report |
| `/fees` | Recent rebalance costs — tx fees + Jupiter swap slippage |
| `/resetbaseline` | Re-anchor the True P&L baseline to the current position |
| `/cancel` | Legacy no-op (execution is immediate once approved) |
| `/pause` / `/resume` | Pause or resume scheduled jobs |
| `/sched` | Show scheduler state + next run times |
| `/help` | Command reference |

## Architecture

```
src/
  index.ts          — boot: config → wallet → DLMM → bot → scheduler
  scheduler.ts      — three cron jobs: daily-ta, intraday-ta, hourly-check
  pnlReport.ts      — Meteora-indexed PnL report
  truePnl.ts        — cost-basis baseline + True P&L report + reset
  ai/               — LLM providers + analyzer + prompt builders
  dlmm/             — position snapshot, rebalance dispatcher, strategy + composition
  swap/             — Jupiter Ultra v1 swap orchestrator
  data/             — Birdeye OHLCV, Meteora API + PnL indexer, indicator compute
  telegram/         — Telegraf bot, commands, approval executor
  state/            — SQLite (better-sqlite3) schema + repos
  cli/              — one-shot entry points
```

Full architecture details and design rationale are in `CLAUDE.md` and `PLAN.md`.

## Safety constraints

- Single `CHAT_ID` allowlist — all other Telegram users are silently ignored
- `MAX_DEPLOY_USD` — caps USD deployed on close+reopen
- `SOL_RESERVE_LAMPORTS` — 0.05 SOL always held back from redeposit
- `MODE=dryrun` — default; no on-chain execution, ever
- `/decide` proposals require explicit Telegram approval (✅/❌ buttons) before executing
- Rebalance execution gated to a single position (throws if `userPositions.length > 1`)

## SQLite inspection

```bash
sqlite3 ./data/bot.db "SELECT decided_at, cycle, action, confidence FROM decision ORDER BY decided_at DESC LIMIT 10"
sqlite3 ./data/bot.db "SELECT symbol, interval, datetime(taken_at/1000,'unixepoch'), close, rsi14 FROM indicator_reading ORDER BY taken_at DESC LIMIT 20"

# Rebalance cost ledger
sqlite3 ./data/bot.db "SELECT datetime(executed_at/1000,'unixepoch'), path, tx_count, sol_fees_lamports FROM action_log ORDER BY executed_at DESC LIMIT 10"
```

## License

UNLICENSED — personal use only.
