/**
 * Anthropic provider — uses @anthropic-ai/sdk Messages API with tool use
 * for guaranteed structured output.
 *
 * Default model: claude-sonnet-4-5 (paid). Drop in claude-haiku-4-5 (cheaper)
 * or claude-sonnet-4-6 by setting LLM_MODEL.
 *
 * Tool-use approach: define a single "submit_decision" tool whose input_schema
 * is our JSON schema. Force the model to call it via tool_choice. Pull the
 * structured result from the first tool_use block. This is more reliable than
 * asking for plain JSON output.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { GenerateJsonArgs, LLMProvider } from "../types";
import { logger } from "../../logger";

const DEFAULT_MODEL = "claude-sonnet-4-5";

export function createAnthropicProvider(args: {
  apiKey: string;
  model?: string;
}): LLMProvider {
  if (!args.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for the Anthropic provider. " +
        "Get a key at https://console.anthropic.com/",
    );
  }
  const client = new Anthropic({ apiKey: args.apiKey });
  const model = args.model || DEFAULT_MODEL;

  return {
    name: "anthropic",
    model,

    async generateJson<T>(req: GenerateJsonArgs<T>): Promise<T> {
      const start = Date.now();
      const toolName = "submit_decision";

      const response = await client.messages.create({
        model,
        max_tokens: req.maxOutputTokens ?? 1024,
        temperature: req.temperature ?? 0.4,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: toolName,
            description:
              `Submit your decision as a structured ${req.schemaName} object.`,
            // Anthropic accepts standard JSON Schema here.
            input_schema: req.schemaJson as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: toolName },
      });

      const toolBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (!toolBlock) {
        throw new Error(
          "Anthropic response had no tool_use block (unexpected when tool_choice is forced)",
        );
      }

      const out = req.schema.parse(toolBlock.input);
      logger.debug(
        {
          provider: "anthropic",
          model,
          ms: Date.now() - start,
          usage: response.usage,
        },
        "LLM response",
      );
      return out;
    },
  };
}
