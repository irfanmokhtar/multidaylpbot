/**
 * Analyzer — orchestrates inputs from DLMM + Birdeye + Meteora API + SQLite,
 * builds the prompt, calls the LLM, validates the Decision, and persists it.
 */

import { loadConfig } from "../config";
import { resolveActivePool } from "../poolMode";
import { getDlmmPool } from "../dlmm/client";
import { getPortfolioSnapshot } from "../dlmm/positions";
import { fetchOhlcv, BTC_MINT } from "../data/birdeye";
import { computeIndicators } from "../data/indicators";
import { getPool } from "../data/meteora_api";
import { getLatestResearch } from "../data/btcResearch";
import { decisionRepo, indicatorReadingRepo } from "../state/repos";
import { logger } from "../logger";

import { getLlmProvider } from "./llm";
import { buildSystemPrompt, buildUserMessage, DECISION_JSON_SCHEMA } from "./prompts";
import { Decision as DecisionSchema } from "./types";
import type { CycleType, DecisionInput, Decision } from "./types";

export interface AnalyzeResult {
  decision: Decision;
  input: DecisionInput;
  provider: string;
  model: string;
  durationMs: number;
}

export async function runAnalysis(cycle: CycleType): Promise<AnalyzeResult> {
  const start = Date.now();
  const input = await buildDecisionInput(cycle);

  const provider = getLlmProvider();
  const system = buildSystemPrompt(input);
  const user = buildUserMessage(input);

  logger.info(
    {
      cycle,
      provider: provider.name,
      model: provider.model,
      pool: input.pool.address ?? "(none)",
    },
    "running analysis",
  );

  const cfg = loadConfig();
  const defaultMaxTokens = cycle === "intraday" ? 2048 : 4096;
  const maxOutputTokens = cfg.LLM_MAX_OUTPUT_TOKENS || defaultMaxTokens;

  const decision = await provider.generateJson({
    system,
    user,
    schemaName: "Decision",
    schemaJson: DECISION_JSON_SCHEMA,
    schema: DecisionSchema,
    temperature: cycle === "daily" ? 0.4 : 0.2,
    maxOutputTokens,
  });

  decisionRepo.insert({
    cycle,
    provider: provider.name,
    model: provider.model,
    decision,
    input,
  });
  decisionRepo.prune();
  indicatorReadingRepo.prune();

  const durationMs = Date.now() - start;
  logger.info(
    {
      cycle,
      action: decision.action,
      confidence: decision.confidence,
      ms: durationMs,
    },
    "analysis complete",
  );

  return { decision, input, provider: provider.name, model: provider.model, durationMs };
}

// ─── input assembly ──────────────────────────────────────────────────────────

async function buildDecisionInput(cycle: CycleType): Promise<DecisionInput> {
  const cfg = loadConfig();
  const activePool = resolveActivePool();
  const symbol = "SOL";

  // Indicators across timeframes. For intraday cycles we skip the 1D fetch
  // to keep the request light (and to stay under Birdeye's 3-endpoint cap).
  const indicators: DecisionInput["indicators"] = {
    "1H": null,
    "4H": null,
    "1D": null,
  };
  const intervals: Array<"1H" | "4H" | "1D"> =
    cycle === "intraday" ? ["1H", "4H"] : ["1H", "4H", "1D"];
  for (const interval of intervals) {
    try {
      const candles = await fetchOhlcv({ interval, candles: 220 });
      const pack = computeIndicators(candles);
      indicators[interval] = pack;
      // Persist compact snapshot for prior-reading delta context.
      indicatorReadingRepo.insert({
        symbol,
        interval,
        close: pack.close,
        rsi14: pack.rsi14,
        ema20: pack.ema20,
        bbPctB: pack.bb?.pctB ?? null,
        macdHist: pack.macd?.histogram ?? null,
        atr14: pack.atr14,
        ema50: pack.ema50,
      });
    } catch (err) {
      logger.warn(
        { interval, err: err instanceof Error ? err.message : err },
        "OHLCV fetch failed — proceeding without this timeframe",
      );
    }
  }

  // Load last 5 prior readings per timeframe (skip the just-inserted current).
  const priorReadings: DecisionInput["priorReadings"] = {
    "1H": indicatorReadingRepo.recent(symbol, "1H", 6).slice(1),
    "4H": indicatorReadingRepo.recent(symbol, "4H", 6).slice(1),
    "1D": indicatorReadingRepo.recent(symbol, "1D", 6).slice(1),
  };

  // Pool metadata from Meteora data API (APR, TVL, fee metrics).
  let poolMeta: Awaited<ReturnType<typeof getPool>> = null;
  if (activePool) {
    try {
      poolMeta = await getPool(activePool);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        "Meteora API getPool failed — proceeding without it",
      );
    }
  }

  // Position snapshot (only if we have a pool).
  let pool: DecisionInput["pool"] = {
    address: activePool,
    binStep: poolMeta?.binStep ?? null,
    activeBinId: null,
    activeBinPrice: null,
    apr24h: poolMeta?.apr ?? null,
    feeTvlRatio24hPct: poolMeta?.feeTvlRatio24hPct ?? null,
    tvlUsd: poolMeta?.tvlUsd ?? null,
  };
  let positions: DecisionInput["positions"] = [];

  if (activePool) {
    try {
      const snap = await getPortfolioSnapshot();
      pool = {
        ...pool,
        binStep: snap.binStep,
        activeBinId: snap.activeBinId,
        activeBinPrice: parseFloat(snap.activeBinPrice),
      };
      const priceY = parseFloat(snap.activeBinPrice);
      const stepFactor = 1 + snap.binStep / 10000;
      positions = snap.positions.map((p) => {
        const valueUsd = snap.tokenY.isStablecoin
          ? (p.totalX + p.feeX) * priceY + (p.totalY + p.feeY)
          : null;
        // USD bounds from bin IDs: price(bin) = activePrice × stepFactor^(bin − activeBin).
        const lowerPriceUsd = priceY * stepFactor ** (p.lowerBinId - snap.activeBinId);
        const upperPriceUsd = priceY * stepFactor ** (p.upperBinId - snap.activeBinId);
        const binsToLowerEdge = snap.activeBinId - p.lowerBinId;
        const binsToUpperEdge = p.upperBinId - snap.activeBinId;
        const activeBinOffsetPct = p.width > 1 ? binsToLowerEdge / (p.width - 1) : 0;
        return {
          lowerBinId: p.lowerBinId,
          upperBinId: p.upperBinId,
          width: p.width,
          inRange: p.inRange,
          holdings: { x: p.totalX, y: p.totalY },
          fees: { x: p.feeX, y: p.feeY },
          valueUsd,
          tokenX: { symbol: snap.tokenX.symbol },
          tokenY: { symbol: snap.tokenY.symbol },
          lowerPriceUsd,
          upperPriceUsd,
          activeBinOffsetPct,
          binsToLowerEdge,
          binsToUpperEdge,
        };
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        "DLMM portfolio fetch failed — analyzer running with no position context",
      );
    }
  }

  const recentDecisions = decisionRepo.recent(1).map((r) => ({
    cycle: r.cycle,
    action: r.action,
    confidence: r.confidence,
    reasoning: r.decision.reasoning,
    decidedAtIso: new Date(r.decidedAt).toISOString(),
  }));

  let btcContext: DecisionInput["btcContext"] = null;
  try {
    const btcCandles = await fetchOhlcv({ address: BTC_MINT, interval: "1D", candles: 55 });
    if (btcCandles.length >= 20) {
      const pack = computeIndicators(btcCandles);
      const { close: price, ema20, ema50 } = pack;
      const aboveEma20 = ema20 !== null && price > ema20;
      const aboveEma50 = ema50 !== null && price > ema50;
      const belowEma20 = ema20 !== null && price < ema20;
      const belowEma50 = ema50 !== null && price < ema50;
      const parts: string[] = [];
      if (ema20 !== null) parts.push(aboveEma20 ? "above EMA20" : "below EMA20");
      if (ema50 !== null) parts.push(aboveEma50 ? "above EMA50" : "below EMA50");
      const trend =
        aboveEma20 && aboveEma50 ? "bullish" :
        belowEma20 && belowEma50 ? "bearish" : "neutral";
      btcContext = { price, trend, detail: parts.join(", ") };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "BTC context fetch failed — skipping");
  }

  // Live 4H BTC momentum — fresh read that catches intraday spikes the 1D trend
  // + daily brief miss. Independent of btcContext so one failure doesn't drop the
  // other.
  let btcShortTerm: DecisionInput["btcShortTerm"] = null;
  try {
    const btc4h = await fetchOhlcv({ address: BTC_MINT, interval: "4H", candles: 220 });
    if (btc4h.length >= 7) {
      const pack = computeIndicators(btc4h);
      const closes = btc4h.map((c) => c.c);
      const prior = closes[closes.length - 7]; // 6 × 4H = 24h ago
      const changePct24h = prior ? ((pack.close - prior) / prior) * 100 : 0;
      btcShortTerm = {
        interval: "4H",
        price: pack.close,
        changePct24h,
        rsi14: pack.rsi14,
        macdHist: pack.macd?.histogram ?? null,
        atrPct: pack.atrPct,
      };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "BTC 4H momentum fetch failed — skipping");
  }

  // Full-analysis cycles (daily + manual ad_hoc) get the BTC research brief;
  // intraday skips it to save tokens.
  const btcResearch = cycle !== "intraday" ? getLatestResearch() : null;

  return {
    cycle,
    pool,
    positions,
    indicators,
    priorReadings,
    recentDecisions,
    btcContext,
    btcResearch,
    btcShortTerm,
    constraints: {
      maxDeployUsd: cfg.MAX_DEPLOY_USD,
      rebalanceHorizon: cfg.REBALANCE_HORIZON,
    },
  };
}

// ─── pretty printing for CLI / Telegram ──────────────────────────────────────

export function formatDecisionText(result: AnalyzeResult): string {
  const { decision, input, provider, model, durationMs } = result;
  const lines: string[] = [];

  lines.push(`🤖 Decision (${input.cycle}, ${provider}/${model})`);
  lines.push(``);

  if (decision.headline) {
    lines.push(`Headline     ${decision.headline}`);
    lines.push(``);
  }

  lines.push(`Action       ${decision.action.toUpperCase()}        DLMM: ${decision.dlmm?.verb ?? "—"}`);
  lines.push(`Confidence   ${(decision.confidence * 100).toFixed(0)}%`);

  if (decision.strategyType || decision.lowerBoundPrice != null) {
    let line = `Strategy     ${decision.strategyType ?? "—"}`;
    if (decision.lowerBoundPrice != null && decision.upperBoundPrice != null) {
      line += `   $${decision.lowerBoundPrice.toFixed(2)} – $${decision.upperBoundPrice.toFixed(2)}`;
    }
    lines.push(line);
  }
  if (decision.keyLevels) {
    const s = decision.keyLevels.support ?? "—";
    const r = decision.keyLevels.resistance ?? "—";
    lines.push(`Key levels   support=${s}   resistance=${r}`);
  }

  if (decision.dlmm) {
    lines.push(``);
    lines.push(`DLMM         ${decision.dlmm.detail}`);
  }

  if (decision.signals && decision.signals.length > 0) {
    lines.push(``);
    lines.push(`Signals`);
    for (const sig of decision.signals) {
      lines.push(`  • ${sig.kind.padEnd(12)} ${sig.title}`);
      lines.push(`    ${sig.note}`);
    }
  }

  if (decision.scenarios) {
    lines.push(``);
    lines.push(`Scenarios`);
    const { bull, base, bear } = decision.scenarios;
    lines.push(`  bull   $${bull.priceTarget}  (${bull.probabilityPct}%)  ${bull.trigger}`);
    lines.push(`  base   $${base.priceTarget}  (${base.probabilityPct}%)  ${base.trigger}`);
    lines.push(`  bear   $${bear.priceTarget}  (${bear.probabilityPct}%)  ${bear.trigger}`);
  }

  lines.push(``);
  lines.push(`Reasoning`);
  lines.push(`  ${decision.reasoning}`);

  lines.push(``);
  lines.push(`(${durationMs}ms)`);
  return lines.join("\n");
}

export function formatDecisionHtml(result: AnalyzeResult): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre>${esc(formatDecisionText(result))}</pre>`;
}
