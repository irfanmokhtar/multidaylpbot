# TA Prompt & Decision Contract — Bot Reference

This document describes how the bot's analyzer pipeline runs technical analysis and formats the LLM decision. It is the bot-adapted version of the original Claude Chat workflow: same analytical discipline, no visual widgets, machine-readable JSON only.

---

## 1. Overview

Every cycle (`daily`, `intraday`, `ad_hoc`) the analyzer:

1. Fetches OHLCV from Birdeye (1H + 4H for intraday; 1H + 4H + 1D for daily/ad_hoc).
2. Computes the indicator pack (RSI, EMA, BB, MACD, ATR).
3. Persists a compact 5-field snapshot to SQLite (`indicator_reading` table).
4. Loads the last 2 prior snapshots per timeframe as delta context.
5. Fetches pool metadata + on-chain position state.
6. Calls the LLM with the structured JSON payload.
7. Validates the response against the `Decision` zod schema.
8. Persists to `decision` table; notifies via Telegram.

Source of truth: `src/ai/analyzer.ts`, `src/ai/prompts.ts`, `src/ai/types.ts`.

---

## 2. Input contract (`DecisionInput`)

Defined in `src/ai/types.ts`. Serialized as JSON in the user message.

| Field | Description |
|---|---|
| `cycle` | `"daily"` / `"intraday"` / `"ad_hoc"` |
| `pool` | address, binStep, activeBinId, activeBinPrice, apr24h, feeTvlRatio24hPct, tvlUsd |
| `positions[]` | All open positions: lowerBinId, upperBinId, width, inRange, holdings, fees, valueUsd, token symbols. Empty = no position. |
| `indicators` | Full IndicatorPack per timeframe (current cycle only). See §3. |
| `priorReadings` | Last 2 compact snapshots per timeframe from SQLite. See §6. |
| `recentDecisions` | Last 5 decisions: cycle, action, confidence, reasoning, timestamp. |
| `constraints` | maxDeployUsd, minRebalanceIntervalHours. |

---

## 3. Indicator fields (full pack — current cycle)

Sent as-is from `computeIndicators()` in `src/data/indicators.ts`, with `candleCount` stripped.

| Field | Notes |
|---|---|
| `close` | Last candle close price |
| `rsi14` | RSI(14) |
| `ema20`, `ema50`, `ema200` | Exponential moving averages |
| `bb.upper`, `bb.lower`, `bb.pctB` | Bollinger Bands (20); %B = 0–1 normally, >1 above upper, <0 below lower |
| `macd.macd`, `macd.signal`, `macd.histogram` | MACD(12,26,9) |
| `atr14` | Average True Range (14) |
| `trend.bullishStacked` / `bearishStacked` | Whether 20>50>200 or 20<50<200 |

---

## 4. Output contract (`Decision`)

Defined in `src/ai/types.ts`. The LLM must return ONE JSON object matching this shape.

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | `hold\|rebalance\|claim_fees\|pause` | Always | Must match `dlmm.verb` (see §5) |
| `strategyType` | `Spot\|Curve\|BidAsk` | When rebalancing | |
| `rangeWidthBins` | integer 10–140 | When rebalancing | Centered on active bin |
| `confidence` | number 0–1 | Always | Self-reported |
| `keyLevels` | `{support, resistance}` | Optional | Key price levels |
| `headline` | string ≤200 chars | Always | 1–2 sentences, single most important development |
| `dlmm` | `{verb, detail}` | Always | DLMM verdict with 1-line detail. See §5. |
| `reasoning` | string ≤400 chars | Always | Narrative tying signals. Cite specific values. |
| `signals` | array 3–6 items | **daily/ad_hoc** | Omit on intraday to save tokens |
| `scenarios` | `{bull, base, bear}` | **daily/ad_hoc** | Probabilities must sum to 100. Omit on intraday. |

### Signal item

```json
{ "kind": "bullish|bearish|caution|structural", "title": "...", "note": "1-2 sentences" }
```

### Scenario item

```json
{ "priceTarget": 195.00, "trigger": "...", "probabilityPct": 45 }
```

`bull.probabilityPct + base.probabilityPct + bear.probabilityPct` must equal 100.

---

## 5. DLMM verb semantics

| Verb | Meaning | Maps to `action` |
|---|---|---|
| `HOLD` | No change to position | `hold` |
| `ROLL` | Re-center existing position (balanced path; width ±tolerance) | `rebalance` |
| `OPEN` | Close current + open at new width (close+reopen path) | `rebalance` |
| `CLOSE` | Exit position; no auto-close path exists — operator handles | `pause` |

`strategyType` and `rangeWidthBins` are required when verb is `ROLL` or `OPEN`.

---

## 6. SQLite caching — prior readings

**Table:** `indicator_reading` — 5 delta-relevant fields per (symbol, interval, time):

| Column | Type | Notes |
|---|---|---|
| `symbol` | TEXT | e.g. `"SOL"` |
| `interval` | TEXT | `"1H"` / `"4H"` / `"1D"` |
| `taken_at` | INTEGER | unix ms |
| `close` | REAL | |
| `rsi14` | REAL | nullable |
| `ema20` | REAL | nullable |
| `bb_pct_b` | REAL | nullable |
| `macd_hist` | REAL | nullable |

**Why only 5 fields:** These are the exact fields the guide's delta table tracks (RSI, BB %B, MACD histogram, EMA20, close). The full IndicatorPack travels for the current cycle only.

**Eviction:** `indicatorReadingRepo.prune(30)` — keeps 30 most recent per (symbol, interval). Runs after every analyzer cycle.

**Delta context sent to LLM:** Last 2 prior readings per timeframe (`priorReadings` in `DecisionInput`). Empty arrays on first run — LLM reasons without prior context.

---

## 7. System prompt

Full text lives in `src/ai/prompts.ts` (`BASE_SYSTEM_PROMPT` + cycle branching in `buildSystemPrompt()`).

Key rules injected by the prompt:

- **Analyst persona** — professional crypto TA analyst, ONE JSON object per response, no prose outside JSON.
- **Analysis tasks** — delta vs priors, dominant signal per tf, EMA crossovers, BB state, MACD direction, 3–6 signals, bull/base/bear scenarios.
- **Cycle branching** — `daily`/`ad_hoc`: signals + scenarios required. `intraday`: omit both, lead with headline + dlmm + reasoning.
- **DLMM verdict mandatory** — always set `dlmm.verb` and `action` consistently.
- **Hard constraints** — maxDeployUsd, minRebalanceIntervalHours (0 in dryrun mode).

---

## 8. Invariants

- `signals`: 3–6 items, classified as bullish / bearish / caution / structural.
- `scenarios.bull.probabilityPct + base + bear` = 100 exactly.
- `action` and `dlmm.verb` must agree (see §5 mapping table).
- `strategyType` + `rangeWidthBins` present whenever `action = "rebalance"`.
- No prose outside the JSON object. No markdown fences.
- Decimals: 4 places for MACD/hist, 2 for price, 0 for RSI (convention for consistency).

---

## 9. CLI output format

`npm run decide` prints `formatDecisionText()` from `src/ai/analyzer.ts`. Layout:

```
🤖 Decision (daily, anthropic/claude-sonnet-4-6)

Headline     <headline>

Action       REBALANCE        DLMM: ROLL
Confidence   84%
Strategy     BidAsk   width=42 bins
Key levels   support=185   resistance=205

DLMM         Roll to 182-224, BidAsk, 42 bins

Signals
  • bullish       4H EMA20 crossed above EMA50
    <note>
  • caution       BB squeeze on 1D
    <note>
  ...

Scenarios
  bull   $215  (40%)  <trigger>
  base   $192  (45%)  <trigger>
  bear   $172  (15%)  <trigger>

Reasoning
  <reasoning>

(8342ms)
```

Telegram `formatDecisionHtml()` wraps this in `<pre>` for monospace rendering.
