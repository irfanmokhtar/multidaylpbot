/**
 * System + user prompt builders for the analyzer.
 *
 * The system prompt teaches the model the DLMM domain + TA analyst role.
 * The user message carries the dynamic data for this cycle.
 */

import type { DecisionInput } from "./types";

// JSON Schema for the Decision shape. Required by provider structured-output
// features. signals + scenarios are not in `required` — cycle branching in the
// system prompt handles the conditional obligation.
// Property order is deliberate: reasoning/analysis fields come FIRST, execution
// fields (action + bounds) LAST. Most models generate keys in declared order, so
// this forces reason-before-decide rather than decide-then-justify.
export const DECISION_JSON_SCHEMA = {
  type: "object",
  required: ["headline", "reasoning", "dlmm", "action", "confidence", "lowerBoundPrice", "upperBoundPrice"],
  properties: {
    headline: {
      type: "string",
      description: "1–2 sentences, max 300 characters. The single most important development this cycle.",
    },
    signals: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      description: "3–6 key signals ranked by importance. Required on daily/ad_hoc cycles.",
      items: {
        type: "object",
        required: ["kind", "title", "note"],
        properties: {
          kind: { type: "string", enum: ["bullish", "bearish", "caution", "structural"] },
          title: { type: "string" },
          note: { type: "string", description: "1–2 sentences citing specific indicator values." },
        },
      },
    },
    scenarios: {
      type: "object",
      description: "Bull/base/bear scenarios. probabilityPct values MUST sum to 100. Required on daily/ad_hoc cycles.",
      required: ["bull", "base", "bear"],
      properties: {
        bull: { $ref: "#/$defs/Scenario" },
        base: { $ref: "#/$defs/Scenario" },
        bear: { $ref: "#/$defs/Scenario" },
      },
    },
    keyLevels: {
      type: "object",
      description:
        "Market-structure support/resistance for the base token in absolute USD. " +
        "Derive from TA ONLY — swing highs/lows, EMA levels, prior pivots, BB edges, " +
        "round numbers. These are where price reacts, NOT your deployed range. " +
        "Do NOT copy the position's lowerPriceUsd/upperPriceUsd — they are an output " +
        "of past S/R, not a source. support < current price < resistance normally.",
      properties: {
        support: { type: ["number", "null"] },
        resistance: { type: ["number", "null"] },
      },
    },
    reasoning: {
      type: "string",
      description: "HARD LIMIT: ≤1500 chars (enforced; longer responses are rejected). Be terse and dense — drop filler, hedging, restated obvious facts. Keep every critical signal value, regime call, and the why behind the action, but cut prose. Aim for ~1000 chars; never exceed 1500.",
    },
    dlmm: {
      type: "object",
      required: ["verb", "detail"],
      properties: {
        verb: {
          type: "string",
          enum: ["HOLD", "ROLL", "OPEN", "CLOSE"],
          description: "HOLD=no change; ROLL=re-center existing range; OPEN=close+reopen at new bounds; CLOSE=exit position.",
        },
        detail: {
          type: "string",
          description: "1-line action description with exact bounds, e.g. 'Roll to $185–$215, BidAsk'.",
        },
      },
    },
    strategyType: {
      type: "string",
      enum: ["Spot", "Curve", "BidAsk"],
      description:
        "Required when action='rebalance'. Curve=ranging/mean-reversion, " +
        "Spot=high vol/breakout/undecided, BidAsk=falling-knife/catch-edges.",
    },
    lowerBoundPrice: {
      type: ["number", "null"],
      description:
        "Absolute USD price of the LOWER bound — pin to a real TA level (support, EMA, swing low). " +
        "Set to a positive number when action='rebalance'; set null otherwise.",
    },
    upperBoundPrice: {
      type: ["number", "null"],
      description:
        "Absolute USD price of the UPPER bound — pin to a real TA level (resistance, EMA, swing high). " +
        "Must exceed lowerBoundPrice when action='rebalance'; set null otherwise.",
    },
    action: {
      type: "string",
      enum: ["hold", "rebalance", "pause"],
      description:
        "Execution action. Must match dlmm.verb: HOLD→hold, ROLL/OPEN→rebalance, CLOSE→pause.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Self-reported confidence (0=guess, 1=certain).",
    },
  },
  $defs: {
    Scenario: {
      type: "object",
      required: ["priceTarget", "trigger", "probabilityPct"],
      properties: {
        priceTarget: { type: "number" },
        trigger: { type: "string" },
        probabilityPct: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
  },
} as const;

// ─── System prompt ───────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `\
You are an elite crypto quantitative analyst and DeFi liquidity strategist \
embedded in a Meteora DLMM liquidity-management bot on Solana. You think in \
regimes and probabilities. You cite numbers, never vibes. You produce ONE \
JSON object per cycle — no prose outside the JSON, no markdown fences.

TIMEFRAME HIERARCHY:
  1D = macro regime (trend, BTC tailwind/headwind, structural S/R).
  4H = mid-term structure (swing highs/lows, EMA stack, range definition).
  1H = execution timing (RSI/MACD/BB squeeze, immediate vol regime).
  A 1H signal contradicting the 1D regime is noise unless 4H confirms.

TRAJECTORY RULE (priorReadings):
  A reading is not a state, it is a vector. Compare current values to \
priorReadings on every cycle. RSI 55 *falling from 72* is bearish; RSI 55 \
*rising from 28* is bullish — same value, opposite trade. Apply the same \
logic to MACD histogram (accelerating vs exhausting), %B (drifting toward \
band edge vs reverting), EMA stack (expanding vs compressing).

BTC MACRO FRAMING (btcContext):
  Tailwind/headwind, not a tiebreaker. When 1D BTC is sharply bearish \
(price < EMA50 with MACD histogram deeply negative), it CAN override a \
constructive local SOL signal — SOL rarely fights a bleeding BTC tape. \
Conversely a constructive BTC tape lets you sit through SOL noise.
  btcShortTerm = LIVE 4H BTC momentum (price, 24h change%, RSI, MACD hist, \
ATR%) — the freshest BTC read. A sharp move here (large |changePct24h|, RSI \
extreme, atrPct jump) OVERRIDES the slower 1D btcContext trend and the daily \
btcResearch brief for near-term risk: a BTC spike/dump drags SOL regardless of \
the morning narrative. Especially decisive on intraday cycles.

BTC RESEARCH (btcResearch — daily/ad_hoc only, may be null):
  A curated daily BTC sentiment + TA + Elliott-Wave brief. Treat it as a \
regime / risk-on-off + sentiment proxy for SOL via beta — NOT as direct SOL \
price levels (its support/resistance numbers are BTC, not SOL). Use it to:
  - Set strategy bias: ranging/mean-revert regime → Curve; breakout/high-vol → \
Spot; falling-knife / capitulation → BidAsk.
  - Gate event risk: if it flags a dated near-term catalyst (e.g. FOMC \
dot-plot, treaty signing), prefer a wider range or HOLD over churning a tight \
range into the event.
  - Read sentiment divergence (e.g. price up while Fear & Greed pinned in \
Extreme Fear) as context, not a trigger.
  If stale=true (ageDays ≥ 1), discount it as dated.

ANALYSIS TASKS (every cycle):
1. Map dominant signal on each timeframe (1H, 4H, 1D) — bullish / bearish / neutral.
2. Map EMA stack per timeframe; flag imminent or completed crossovers.
3. Bollinger Band state: squeeze, expansion, %B overextension, mean reversion.
4. MACD histogram direction + zero-line crossovers per timeframe.
5. Volume confirmation: compare volume to volumeSma20. A breakout or trend move on \
sub-average volume is a fade, not conviction — favor mean-reversion (Curve) there. \
Above-average volume validates breakouts → Spot/BidAsk. Use this to gate strategy choice.
6. (daily/ad_hoc only) Surface 3–6 key signals classified bullish / bearish / caution / structural.
7. (daily/ad_hoc only) Three scenarios (bull / base / bear) with probabilities summing to 100.

STRATEGY MAPPING (use these definitions, not generic intuition):
  Curve   = ranging / mean-reversion regime (low ATR, BB squeeze, RSI \
mean-reverting around 50). Concentrate in the middle.
  Spot    = high volatility / breakout / direction undecided. Uniform \
distribution — concentrated middle is too risky when wicks are wide.
  BidAsk  = falling knife / catch-the-edge. Deploy liquidity at the edges \
when you want the wicks to do the buying/selling for you.

DLMM VERDICT (mandatory, every cycle):
Always set the "dlmm" field with a verb and one-line detail. Set "action" \
consistently with the verb:
  HOLD  → action="hold"
  ROLL  → action="rebalance", set strategyType + lowerBoundPrice + upperBoundPrice
  OPEN  → action="rebalance" (close+reopen path), set strategyType + lowerBoundPrice + upperBoundPrice
  CLOSE → action="pause" (no auto-close path exists; operator handles)

DLMM mechanics:
  - Bins are discrete price increments. Fees accrue ONLY when the active bin \
is INSIDE the position range.
  - Bounds are absolute USD prices — pin them to real TA levels, not deltas \
from the current price. Asymmetric bounds (bullish/bearish skew) are encouraged.
  - The executor converts your prices to bins and enforces width ∈ [5, 343]. \
If your bounds derive a width outside that band the decision is REJECTED.

RANGE WIDTH ECONOMICS (the core fee-farming tradeoff):
  - Fees accrue ONLY when the active bin is inside the range, and per-bin fee \
density is HIGHER the narrower the range (same liquidity over fewer bins). So \
narrow = more fees/hour BUT shorter time-in-range before price exits and fees stop.
  - Wide = fewer fees/hour but survives volatility without going out of range. \
Pick width to match volatility: scale it to atrPct (ATR as % of price). High atrPct \
or expanding BB → widen; low atrPct / BB squeeze → tighten and farm the chop.
  - Every rebalance costs real SOL tx fees + (on close+reopen) Jupiter swap \
slippage, so do not churn on noise — ROLL/OPEN on a genuine positioning change \
(edge breach, regime shift, volatility-regime change), not a one-candle wiggle. \
Maximize fee capture by keeping the active bin inside a well-centered range: a \
range the price has left earns ZERO. Do NOT veto a needed re-center just because \
this pool's headline APR is low — staying positioned is what earns fees here.
  - Honor your own recent decisions (recentDecisions) — do not flip-flop range on \
noise; it just bleeds fees + slippage.

Position drift is PRE-COMPUTED for you per position: activeBinOffsetPct \
(0=lower edge, 1=upper edge), binsToLowerEdge / binsToUpperEdge, and lowerPriceUsd \
/ upperPriceUsd (your current range in USD). Read these directly — do not re-derive \
from bin IDs.

Hold vs rebalance heuristics:
  - In-range + no regime flip → HOLD. Rebalancing has real on-chain cost.
  - activeBinOffsetPct near 0 or 1 (active bin hugging an edge) OR volatility \
regime shift (ATR/atrPct jump, BB expansion) → ROLL with new bounds straddling the \
new center.
  - Tight range + breakout signal confirmed by volume → OPEN (wider bounds, BidAsk).
  - Heavy signal conflict or thesis broken → CLOSE / pause.`;

/**
 * Generate pool-specific price-bound exemplars so the LLM picks bounds that
 * derive a sane bin width (∈ [5, 343]) for THIS pool's bin step. Shows
 * symmetric bands; the LLM is free to skew bounds asymmetrically.
 */
function buildPriceBoundExamples(
  binStep: number | null,
  activeBinPrice: number | null,
): string {
  if (!binStep || !activeBinPrice) {
    return (
      `Price-bound guidance: pick lowerBoundPrice + upperBoundPrice to span a ` +
      `sensible % range given the pool's bin step (pool.binStep, bps). ` +
      `Narrow ≈ 1–3%, medium ≈ 5–15%, wide ≈ 15–40%. Derived bin width must be in [5, 343].`
    );
  }
  const stepFrac = binStep / 10000; // bps → fraction
  const tiers: Array<{ pct: number; label: string }> = [
    { pct: 0.02, label: "narrow  (low-vol Curve)" },
    { pct: 0.05, label: "medium  (mixed Spot)" },
    { pct: 0.15, label: "wide    (breakout BidAsk)" },
    { pct: 0.30, label: "v.wide  (catch-edge BidAsk)" },
  ];
  const lines = tiers.map(({ pct, label }) => {
    const lo = activeBinPrice * (1 - pct / 2);
    const hi = activeBinPrice * (1 + pct / 2);
    // Width via log-ratio gives the correct bin count for compounding bin steps.
    const bins = Math.round(Math.log(hi / lo) / Math.log(1 + stepFrac));
    return `  $${lo.toFixed(2).padStart(7)} – $${hi.toFixed(2).padEnd(7)}  ${String(bins).padStart(5)} bins  (~${(pct * 100).toFixed(0)}%)  [${label}]`;
  });
  return [
    `Price-bound guidance for this pool (${binStep} bps bin step, active $${activeBinPrice.toFixed(2)}):`,
    ...lines,
    `These %-tiers are starting points, not fixed buckets — scale the actual width to current volatility (indicators.atrPct). Higher atrPct → lean wider; lower → lean narrower.`,
    `Bounds are absolute USD prices — pin them to real TA levels (S/R, EMA, swing).`,
    `Asymmetric bounds are encouraged (bullish: skew upper higher; bearish: skew lower lower).`,
    `Hard constraint: derived bin width must satisfy 5 ≤ width ≤ 343 — otherwise the decision is REJECTED.`,
  ].join("\n");
}

export function buildSystemPrompt(input: DecisionInput): string {
  const schemaText = JSON.stringify(DECISION_JSON_SCHEMA, null, 2);

  const cycleInstructions =
    input.cycle === "intraday"
      ? `Cycle: intraday. Be terse — only escalate to ROLL/OPEN if indicator pack clearly demands it. ` +
        `Omit "signals" and "scenarios" fields to save tokens. Lead with headline + dlmm + reasoning.`
      : `Cycle: ${input.cycle}. Full analysis required. ` +
        `You MUST include "signals" (3–6 items) and "scenarios" (bull/base/bear, probabilities sum to 100). ` +
        `The daily pass is your main strategic call — full reasoning.`;

  const rangeGuidance = buildPriceBoundExamples(
    input.pool.binStep,
    input.pool.activeBinPrice,
  );

  const horizonGuidance =
    input.constraints.rebalanceHorizon === "multiday"
      ? `REBALANCE HORIZON: MULTIDAY (2–3 day hold target).\n` +
        `  - Size for SURVIVAL, not peak density: favor the WIDER %-tiers (lean to the 15–30% band, not 2–5%). The range must hold through 2–3 days of SOL swings without the active bin exiting it.\n` +
        `  - Prefer Spot/uniform over Curve — a concentrated middle dies fast over multi-day moves; you want broad time-in-range.\n` +
        `  - Hold harder: ROLL/OPEN only on an edge breach (activeBinOffsetPct ≤ ~0.1 or ≥ ~0.9) or a confirmed regime / volatility-regime shift. Tolerate mid-range drift and single-cycle wiggles a daily horizon would re-center on — each execution costs SOL + slippage, and a wide band is meant to be HELD.\n` +
        `  - Reality: max derivable width here is ~14–15% (343-bin cap). If the 2–3 day expected range exceeds that, pick the widest valid band and accept a re-center on a genuine breakout — do NOT over-tighten chasing fee density.`
      : `REBALANCE HORIZON: DAILY (12–24h hold target). Standard behavior — size width to current volatility (atrPct) and re-center on edge breaches per the heuristics above.`;

  return [
    BASE_SYSTEM_PROMPT,
    "",
    rangeGuidance,
    "",
    horizonGuidance,
    "",
    cycleInstructions,
    "",
    `Hard constraints from the safety layer (you cannot override these):`,
    `  - max position value: $${input.constraints.maxDeployUsd}`,
    "",
    `JSON Schema for your response:`,
    schemaText,
  ].join("\n");
}

// ─── User message ────────────────────────────────────────────────────────────

const omit = <T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

export function buildUserMessage(input: DecisionInput): string {
  const lite = {
    cycle: input.cycle,
    nowIso: new Date().toISOString(),
    pool: input.pool,
    positions: input.positions,
    btcContext: input.btcContext,
    btcResearch: input.btcResearch,
    btcShortTerm: input.btcShortTerm,
    indicators: {
      "1H": input.indicators["1H"]
        ? omit(input.indicators["1H"], ["candleCount"])
        : null,
      "4H": input.indicators["4H"]
        ? omit(input.indicators["4H"], ["candleCount"])
        : null,
      "1D": input.indicators["1D"]
        ? omit(input.indicators["1D"], ["candleCount"])
        : null,
    },
    priorReadings: input.priorReadings,
    recentDecisions: input.recentDecisions,
  };

  const baseSymbol = input.positions[0]?.tokenX.symbol ?? "the base token";

  const taskList =
    input.cycle === "intraday"
      ? [
          `TASK:`,
          `1. Quick technical pass on ${baseSymbol} using current indicators + priorReadings trajectory + btcContext.`,
          `2. Evaluate active positions (drift vs active bin, fee accrual, range health).`,
          `3. Decide: HOLD unless a clear regime shift demands ROLL/OPEN/CLOSE. If rebalancing, recommend optimal lowerBoundPrice + upperBoundPrice + strategyType.`,
          `4. Respond with ONE JSON object matching the schema — no prose outside JSON, no markdown fences. Omit "signals" and "scenarios" to save tokens.`,
        ].join("\n")
      : [
          `TASK:`,
          `1. Full multi-timeframe technical analysis of ${baseSymbol} using current indicators, priorReadings trajectory, and btcContext.`,
          `2. Evaluate active positions (drift vs active bin, fee accrual, range health).`,
          input.constraints.rebalanceHorizon === "multiday"
            ? `3. Recommend Meteora DLMM bounds (lowerBoundPrice, upperBoundPrice, strategyType) to STAY IN-RANGE and farm fees over the next 2–3 days with minimal rebalancing — prioritize time-in-range over per-hour fee density.`
            : `3. Recommend optimal Meteora DLMM bounds (lowerBoundPrice, upperBoundPrice, strategyType) for max fee farming over the next 12–24h.`,
          `4. Provide 3–6 ranked signals and bull/base/bear scenarios summing to 100%.`,
          `5. Respond with ONE JSON object matching the schema — no prose outside JSON, no markdown fences.`,
        ].join("\n");

  return [
    `Latest market data + active DLMM pool state below.`,
    "",
    `DATA PAYLOAD:`,
    "```json",
    JSON.stringify(lite, null, 2),
    "```",
    "",
    taskList,
  ].join("\n");
}
