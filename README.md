# Meteora DLMM LP Bot

Autonomous LP manager for a single [Meteora DLMM](https://app.meteora.ag) pool. A Node.js process polls OHLCV data and on-chain position state, asks an LLM for a rebalance decision, notifies via Telegram with a countdown, then executes on-chain.

## What it does

1. **TA cycle** — fetches 1H/4H/1D OHLCV from Birdeye, computes RSI/EMA/BB/MACD/ATR, pulls BTC macro context, reads your open DLMM position, and sends everything to an LLM.
2. **Decision** — LLM returns a structured `Decision` (`hold | rebalance | claim_fees | pause`) with price bounds, strategy type, and reasoning.
3. **Execution** — on `rebalance`, the bot queues a Telegram countdown. After confirmation it closes + reopens the position (or balanced re-centers if the shift is minor), swapping via Jupiter Ultra to align composition with the target range.
4. **Dashboard** — read-only web UI at `http://127.0.0.1:3001` showing KPIs, position range, indicators, decision history, and PnL.

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
cd web && npm install && cd ..
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
COUNTDOWN_SEC=60                # seconds before executing a queued rebalance
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
npm run dev          # start bot + dashboard (live-reload via tsx watch)
npm run start        # run compiled build (npm run build first)
```

One-shot CLI tools (no bot required):

```bash
npm run status       # current pool + position state
npm run analyze      # indicator pass (no LLM)
npm run decide       # full analyzer pass including LLM decision
npm run pnl          # fees + USD PnL from Meteora indexer
```

## Dashboard

Starts automatically with `npm run dev`. Accessible at `http://127.0.0.1:3001`.

Pages: Overview · Decisions · Indicators (1H/4H/1D) · Schedule · PnL

For frontend development:

```bash
npm run dev:web      # Vite dev server at :5174, proxies /api → :3001
```

## Telegram commands

| Command | Description |
|---|---|
| `/status` | Pool snapshot + position state |
| `/analyze` | Run indicator pass + LLM decision |
| `/decide` | Run full analysis and queue rebalance if recommended |
| `/cancel` | Cancel pending rebalance countdown |
| `/pause` / `/resume` | Pause or resume scheduled jobs |
| `/sched` | Show next run times for all jobs |
| `/pnl` | Fees + USD PnL report |
| `/help` | Command reference |

## Architecture

```
src/
  index.ts          — boot: config → wallet → DLMM → bot → scheduler
  scheduler.ts      — three cron jobs: daily-ta, intraday-ta, hourly-check
  ai/               — LLM providers + analyzer + prompt builders
  dlmm/             — position snapshot, rebalance dispatcher, strategy + composition
  swap/             — Jupiter Ultra v1 swap orchestrator
  data/             — Birdeye OHLCV, Meteora API + PnL indexer, indicator compute
  telegram/         — Telegraf bot, commands, countdown executor
  web/              — Fastify API server + static SPA serving
  state/            — SQLite (better-sqlite3) schema + repos
  cli/              — one-shot entry points

web/                — Vite + React frontend
```

Full architecture details and design rationale are in `CLAUDE.md` and `PLAN.md`.

## Safety constraints

- Single `CHAT_ID` allowlist — all other Telegram users are silently ignored
- `MAX_DEPLOY_USD` — caps USD deployed on close+reopen
- `SOL_RESERVE_LAMPORTS` — 0.05 SOL always held back from redeposit
- `MODE=dryrun` — default; no on-chain execution, ever
- Rebalance execution gated to a single position (throws if `userPositions.length > 1`)

## SQLite inspection

```bash
sqlite3 ./data/bot.db "SELECT decided_at, cycle, action, confidence FROM decision ORDER BY decided_at DESC LIMIT 10"
sqlite3 ./data/bot.db "SELECT symbol, interval, datetime(taken_at/1000,'unixepoch'), close, rsi14 FROM indicator_reading ORDER BY taken_at DESC LIMIT 20"
```

## License

UNLICENSED — personal use only.
