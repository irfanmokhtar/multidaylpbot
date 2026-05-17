# Bot Commands Reference

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Greeting — confirms bot is online |
| `/status` | Current pool, active bin, and position(s) with value breakdown |
| `/analyze` | Raw indicator pass — OHLCV + RSI/EMA/BB/MACD/ATR across 1H/4H/1D (no LLM) |
| `/decide` | Full analyzer pass — indicators + position state + LLM decision (no execution) |
| `/cancel` | Abort a pending rebalance during its countdown timer |
| `/pause` | Pause the scheduler — stops automatic TA runs and health checks |
| `/resume` | Resume the scheduler after a pause |
| `/sched` | Show scheduler state (enabled/paused) and next run times for each job |
| `/help` | List all available commands |

### Scheduler Jobs (auto-fired, no command needed)

| Job | Default schedule | Behavior |
|-----|-----------------|----------|
| `daily-ta` | `0 9 * * *` (9 AM daily) | Full TA pass + Telegram report; always notifies |
| `intraday-ta` | `0 */4 * * *` (every 4h) | Light TA; notifies only if decision ≠ hold |
| `hourly-check` | `0 * * * *` (every hour) | Wallet balance + position status report; low-SOL alert if below 0.1 SOL |

Configure schedule with `CRON_DAILY`, `CRON_INTRADAY`, `CRON_HEALTH`, and `CRON_TZ` in `.env`.

---

## npm Scripts

```bash
npm run dev          # Start bot with live-reload (tsx watch) — use for development
npm run build        # Compile TypeScript → dist/
npm run typecheck    # Type-check without emitting (CI-safe)
npm run start        # Run compiled dist/index.js — use for production
```

### One-shot CLI Tools (no bot process required)

```bash
npm run status       # Dump current pool + position state to stdout
npm run analyze      # Run full indicator pass — raw OHLCV + computed indicators, no LLM
npm run decide       # Run full analyzer pass including LLM decision
```

---

## SQLite Inspection

```bash
# Last 10 LLM decisions
sqlite3 ./data/bot.db "SELECT decided_at, cycle, action, confidence FROM decision ORDER BY decided_at DESC LIMIT 10"

# Full decision JSON for most recent entry
sqlite3 ./data/bot.db "SELECT input_json, decision_json FROM decision ORDER BY decided_at DESC LIMIT 1"

# Reset — wipe all past decisions (LLM starts fresh with no prior context)
sqlite3 ./data/bot.db "DELETE FROM decision"

# Reset — keep only the most recent N decisions (e.g. keep last 3)
sqlite3 ./data/bot.db "DELETE FROM decision WHERE id NOT IN (SELECT id FROM decision ORDER BY decided_at DESC LIMIT 3)"
```

---

## Rebalance Flow (MODE=live only)

1. Scheduler or `/decide` produces a `rebalance` decision
2. Bot posts a **Telegram proposal** with preview (estimated path, new range, confidence)
3. **60-second countdown** starts (configurable via `COUNTDOWN_SEC`)
4. Send `/cancel` to abort — otherwise the rebalance executes automatically
5. On execution: Telegram posts result with Solscan tx links

Two execution paths:
- **Balanced** — re-center around active bin, width preserved (1–2 txs)
- **Close + reopen** — close existing position, reopen at new width (3+ txs); triggered when `|requestedWidth − currentWidth| > WIDTH_CHANGE_TOLERANCE_BINS`

---

## Running Multiple Wallets

No multi-wallet support in code. Run separate bot processes, each with its own env file:

```bash
# create per-wallet env files (must differ: WALLET_PRIVATE_KEY, POOL_ADDRESS, DB_PATH, DASHBOARD_PORT)
cp .env .env.wallet2
# edit .env.wallet2 ...

# run each in its own terminal
env $(grep -v '^#' .env         | xargs) npm run start
env $(grep -v '^#' .env.wallet2 | xargs) npm run start

# or with pm2
pm2 start "npm run start" --name bot-w1 -- --env .env
pm2 start "npm run start" --name bot-w2 -- --env .env.wallet2
```

Required unique per-process: `WALLET_PRIVATE_KEY`, `POOL_ADDRESS`, `DB_PATH`, `DASHBOARD_PORT`.
Optional: separate `TELEGRAM_BOT_TOKEN` per wallet to distinguish notifications.

---

## Upcoming Commands (not yet implemented)

| Command | Phase | Description |
|---------|-------|-------------|
| `/pnl` | Phase 7 | Show realized + unrealized P&L summary |
