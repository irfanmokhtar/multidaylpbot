import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

const STALE_FAST = 15_000; // 15s — status, scheduler, health
const STALE_MED = 60_000; // 1m — decisions, indicators
const STALE_SLOW = 300_000; // 5m — pool metadata, ohlcv

export const useStatus = () =>
  useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    staleTime: STALE_FAST,
    refetchInterval: STALE_FAST,
  });

export const useHealth = () =>
  useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    staleTime: STALE_FAST,
    refetchInterval: STALE_FAST,
  });

export const useScheduler = () =>
  useQuery({
    queryKey: ["scheduler"],
    queryFn: api.scheduler,
    staleTime: STALE_FAST,
    refetchInterval: STALE_FAST,
  });

export const usePool = () =>
  useQuery({
    queryKey: ["pool"],
    queryFn: api.pool,
    staleTime: STALE_SLOW,
  });

export const useDecisions = (limit = 50) =>
  useQuery({
    queryKey: ["decisions", limit],
    queryFn: () => api.decisions(limit),
    staleTime: STALE_MED,
  });

export const useDecision = (id: number | null) =>
  useQuery({
    queryKey: ["decision", id],
    queryFn: () => api.decision(id as number),
    enabled: id != null,
    staleTime: STALE_MED,
  });

export const useIndicators = () =>
  useQuery({
    queryKey: ["indicators"],
    queryFn: api.indicators,
    staleTime: STALE_MED,
  });

export const useOhlcv = (interval: "1H" | "4H" | "1D") =>
  useQuery({
    queryKey: ["ohlcv", interval],
    queryFn: () => api.ohlcv(interval),
    staleTime: STALE_SLOW,
  });

export const usePnl = () =>
  useQuery({
    queryKey: ["pnl"],
    queryFn: api.pnl,
    staleTime: STALE_MED,
    refetchInterval: STALE_MED,
  });

export const usePositionHistory = (positionAddress: string | null) =>
  useQuery({
    queryKey: ["pnl-history", positionAddress],
    queryFn: () => api.pnlHistory(positionAddress as string),
    enabled: positionAddress != null,
    staleTime: STALE_MED,
  });
