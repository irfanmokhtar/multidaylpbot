/**
 * Provider selector. Returns the LLMProvider implementation matching
 * cfg.LLM_PROVIDER. Cached so each provider is constructed once.
 */

import { loadConfig } from "../config";
import { createGeminiProvider } from "./providers/gemini";
import { createGroqProvider } from "./providers/groq";
import { createAnthropicProvider } from "./providers/anthropic";
import { createClaudeCliProvider } from "./providers/claudecli";
import type { LLMProvider } from "./types";

let cached: LLMProvider | null = null;

export function getLlmProvider(): LLMProvider {
  if (cached) return cached;
  const cfg = loadConfig();
  const model = cfg.LLM_MODEL || undefined;

  switch (cfg.LLM_PROVIDER) {
    case "gemini":
      cached = createGeminiProvider({ apiKey: cfg.GEMINI_API_KEY, model });
      break;
    case "groq":
      cached = createGroqProvider({ apiKey: cfg.GROQ_API_KEY, model });
      break;
    case "anthropic":
      cached = createAnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, model });
      break;
    case "claudecli":
      cached = createClaudeCliProvider({ model });
      break;
  }
  return cached;
}

/** Test helper. */
export function resetLlmProviderCache(): void {
  cached = null;
}
