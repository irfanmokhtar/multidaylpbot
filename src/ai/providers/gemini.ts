/**
 * Gemini provider — uses @google/genai with native JSON mode + responseJsonSchema.
 * Default model: gemini-2.5-flash (free tier: 1,500 RPD).
 */

import { GoogleGenAI } from "@google/genai";
import type { GenerateJsonArgs, LLMProvider } from "../types";
import { logger } from "../../logger";

const DEFAULT_MODEL = "gemini-2.5-flash";

export function createGeminiProvider(args: {
  apiKey: string;
  model?: string;
}): LLMProvider {
  if (!args.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required for the Gemini provider. " +
        "Get a free key at https://aistudio.google.com/apikey",
    );
  }
  const client = new GoogleGenAI({ apiKey: args.apiKey });
  const model = args.model || DEFAULT_MODEL;

  return {
    name: "gemini",
    model,

    async generateJson<T>(req: GenerateJsonArgs<T>): Promise<T> {
      const start = Date.now();
      const maxOutputTokens = req.maxOutputTokens ?? 4096;
      const response = await client.models.generateContent({
        model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          // Gemini's responseJsonSchema accepts standard JSON Schema (since v1.9).
          responseJsonSchema: req.schemaJson,
          temperature: req.temperature ?? 0.4,
          maxOutputTokens,
          // Gemini 2.5 Flash burns "thinking" tokens against the same
          // maxOutputTokens budget. Cap the thinking spend so the visible
          // JSON gets the rest. Set to 0 to disable thinking entirely.
          thinkingConfig: { thinkingBudget: 1024 },
        },
      });

      // Detect MAX_TOKENS truncation BEFORE attempting to parse. If we don't,
      // the caller sees a confusing "Unterminated string" JSON error instead
      // of the real cause.
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === "MAX_TOKENS") {
        throw new Error(
          `Gemini hit MAX_TOKENS (budget=${maxOutputTokens}). ` +
            `Increase LLM_MAX_OUTPUT_TOKENS or shrink the prompt. ` +
            `Usage: ${JSON.stringify(response.usageMetadata)}`,
        );
      }

      const text = response.text;
      if (!text) {
        throw new Error(
          `Gemini returned empty response (finishReason=${finishReason})`,
        );
      }

      const parsed = parseAndValidate(text, req.schema);
      logger.debug(
        {
          provider: "gemini",
          model,
          ms: Date.now() - start,
          usage: response.usageMetadata,
        },
        "LLM response",
      );
      return parsed;
    },
  };
}

function parseAndValidate<T>(
  raw: string,
  schema: { parse: (data: unknown) => T },
): T {
  // Some models (rarely) wrap JSON in fences despite responseMimeType.
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```\s*$/i, "");
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from Gemini: ${
        err instanceof Error ? err.message : err
      }\nRaw response (first 500 chars): ${raw.slice(0, 500)}`,
    );
  }
  return schema.parse(json);
}
