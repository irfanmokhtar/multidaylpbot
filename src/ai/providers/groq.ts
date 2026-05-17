/**
 * Groq provider — uses groq-sdk (OpenAI-compatible chat completions).
 * Default model: llama-3.3-70b-versatile (free tier: 1,000 RPD, 30 RPM).
 *
 * Groq supports `response_format: { type: "json_object" }` for JSON mode but
 * does NOT enforce a schema server-side. We compensate by:
 *   1. embedding the JSON Schema in the system prompt (already there),
 *   2. parsing + Zod-validating + retrying once on failure.
 */

import Groq from "groq-sdk";
import type { GenerateJsonArgs, LLMProvider } from "../types";
import { logger } from "../../logger";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

export function createGroqProvider(args: {
  apiKey: string;
  model?: string;
}): LLMProvider {
  if (!args.apiKey) {
    throw new Error(
      "GROQ_API_KEY is required for the Groq provider. " +
        "Get a free key at https://console.groq.com/keys",
    );
  }
  const client = new Groq({ apiKey: args.apiKey });
  const model = args.model || DEFAULT_MODEL;

  return {
    name: "groq",
    model,

    async generateJson<T>(req: GenerateJsonArgs<T>): Promise<T> {
      const start = Date.now();

      const callOnce = async (): Promise<string> => {
        const completion = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          response_format: { type: "json_object" },
          temperature: req.temperature ?? 0.4,
          max_tokens: req.maxOutputTokens,
        });
        const text = completion.choices[0]?.message?.content;
        if (!text) throw new Error("Groq returned empty response");
        return text;
      };

      // One attempt + one retry. The retry hint reminds the model to obey
      // the schema if it produced something malformed.
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await callOnce();
          const out = parseAndValidate(text, req.schema);
          logger.debug(
            { provider: "groq", model, ms: Date.now() - start, attempt: attempt + 1 },
            "LLM response",
          );
          return out;
        } catch (err) {
          lastError = err;
          logger.warn(
            {
              provider: "groq",
              attempt: attempt + 1,
              err: err instanceof Error ? err.message : err,
            },
            "Groq generateJson failed; retrying once",
          );
          // Append a stronger instruction for the retry attempt.
          if (attempt === 0) {
            req = {
              ...req,
              user:
                req.user +
                "\n\nIMPORTANT: previous attempt returned invalid JSON. " +
                "Return ONE JSON object matching the schema exactly. No prose, no fences.",
            };
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

function parseAndValidate<T>(
  raw: string,
  schema: { parse: (data: unknown) => T },
): T {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```\s*$/i, "");
  return schema.parse(JSON.parse(cleaned));
}
