import { spawn } from "child_process";
import type { GenerateJsonArgs, LLMProvider } from "../types";
import { logger } from "../../logger";

const DEFAULT_MODEL = "claude-opus-5";

function runClaude(model: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["--print", "--no-session-persistence", "--model", model]);
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("claudecli: timed out after 180s"));
    }, 180_000);

    // setEncoding gives us a StringDecoder per stream, so multi-byte UTF-8
    // (≤, —, →) split across chunk boundaries is reassembled instead of mangled.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => { stdout += d; });
    proc.stderr.on("data", (d: string) => { stderr += d; });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      // Some CLI failures (e.g. "OAuth session expired") are written to stdout,
      // not stderr — fall back to stdout so the reason isn't swallowed.
      else reject(new Error(`claude exited ${code ?? signal}: ${(stderr || stdout).trim().slice(0, 300)}`));
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();
  });
}

/**
 * Pull the first complete top-level JSON object out of arbitrary CLI stdout.
 * Handles markdown fences, preamble/postamble prose, and trailing commentary by
 * brace-scanning (string- and escape-aware) from the first `{` to its match.
 * Returns null when no balanced object exists — i.e. the output was truncated.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function createClaudeCliProvider(args: { model?: string }): LLMProvider {
  const model = args.model || DEFAULT_MODEL;

  return {
    name: "claudecli",
    model,

    async generateJson<T>(req: GenerateJsonArgs<T>): Promise<T> {
      const start = Date.now();

      const prompt = [
        req.system,
        "---",
        req.user,
        "---",
        `Respond with ONLY valid JSON matching the ${req.schemaName} schema. No explanation, no markdown fences, no preamble. Output raw JSON only.`,
      ].join("\n\n");

      const retries = parseInt(process.env.LLM_CLI_TIMEOUT_RETRIES ?? "2", 10);
      const maxAttempts = 1 + (Number.isFinite(retries) && retries >= 0 ? retries : 2);

      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const stdout = await runClaude(model, prompt);
          const raw = stdout.trim();
          const candidate = extractJsonObject(raw);

          if (!candidate) {
            // No balanced object → the CLI cut the response short (hit its output
            // ceiling or was interrupted). Log head+tail so truncation is obvious.
            logger.error(
              {
                provider: "claudecli",
                model,
                attempt,
                rawLen: raw.length,
                rawHead: raw.slice(0, 1000),
                rawTail: raw.slice(-1000),
              },
              "claudecli: no balanced JSON object in output (truncated?)",
            );
            throw new Error(
              `claudecli: JSON extraction failed — no balanced object in ${raw.length} chars of output (likely truncated)`,
            );
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(candidate);
          } catch (parseErr) {
            logger.error(
              {
                provider: "claudecli",
                model,
                attempt,
                rawLen: raw.length,
                candidateLen: candidate.length,
                candidate: candidate.slice(0, 4000),
              },
              "claudecli: JSON parse failed",
            );
            throw new Error(
              `claudecli: JSON parse failed (${candidate.length} chars): ${
                parseErr instanceof Error ? parseErr.message : String(parseErr)
              }`,
            );
          }

          const res = req.schema.safeParse(parsed);
          if (!res.success) {
            // No structured-output enforcement on this provider — dump the raw
            // payload so schema violations are diagnosable after the fact.
            logger.error(
              { provider: "claudecli", model, attempt, issues: res.error.issues, raw: raw.slice(0, 4000) },
              "claudecli: schema validation failed",
            );
            throw res.error;
          }
          const out = res.data;
          logger.debug(
            { provider: "claudecli", model, ms: Date.now() - start, attempt },
            "LLM response",
          );
          return out;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Timeouts and malformed/truncated stdout are transient CLI failures —
          // worth another attempt. Schema violations are not (systematic).
          const retryable =
            msg.includes("timed out") ||
            msg.includes("JSON parse failed") ||
            msg.includes("JSON extraction failed");
          if (retryable && attempt < maxAttempts) {
            logger.warn(
              { attempt, maxAttempts, elapsedMs: Date.now() - start, reason: msg.slice(0, 200) },
              "claudecli: transient failure, retrying",
            );
            lastErr = err as Error;
            continue;
          }
          throw err;
        }
      }
      throw lastErr ?? new Error("claudecli: all attempts failed");
    },
  };
}
