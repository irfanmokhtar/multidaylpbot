import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../config";
import { isPaused } from "../../scheduler";

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    const cfg = loadConfig();
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = fs.statSync(cfg.DB_PATH).size;
    } catch {
      dbSizeBytes = null;
    }
    return {
      uptimeSec: Math.round(process.uptime()),
      dbSizeBytes,
      mode: cfg.MODE,
      paused: isPaused(),
    };
  });
}
