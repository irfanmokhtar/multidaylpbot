import { spawn } from "child_process";
import type { GenerateJsonArgs, LLMProvider } from "../types";
import { logger } from "../../logger";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function runClaude(model: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["--print", "--no-session-persistence", "--model", model]);
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("claudecli: timed out after 180s"));
    }, 180_000);

    proc.stdout.on("data", (d: Buffer) => { stdout += d; });
    proc.stderr.on("data", (d: Buffer) => { stderr += d; });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code ?? signal}: ${stderr.slice(0, 300)}`));
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();
  });
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

          // Strip markdown fences if present
          const raw = stdout.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error(`claudecli: JSON parse failed. Raw output:\n${raw.slice(0, 500)}`);
          }

          const out = req.schema.parse(parsed);
          logger.debug(
            { provider: "claudecli", model, ms: Date.now() - start, attempt },
            "LLM response",
          );
          return out;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isTimeout = msg.includes("timed out");
          if (isTimeout && attempt < maxAttempts) {
            logger.warn(
              { attempt, maxAttempts, elapsedMs: Date.now() - start },
              "claudecli: timeout, retrying",
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
