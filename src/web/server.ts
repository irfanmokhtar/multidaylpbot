/**
 * Phase 8 — read-only web dashboard.
 *
 * Embedded Fastify server. Bound to 127.0.0.1 only; no auth (matches the
 * existing trust model — the wallet's private key already lives on the host).
 *
 * Reuses the bot's singletons (config, db, DLMM pool) directly; there is no
 * second process and no IPC. If a route handler throws, Fastify logs and
 * returns 500 — it cannot crash the bot's main loop.
 */

import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { logger } from "../logger";
import { registerStatusRoute } from "./routes/status";
import { registerHealthRoute } from "./routes/health";
import { registerDecisionsRoute } from "./routes/decisions";
import { registerIndicatorsRoute } from "./routes/indicators";
import { registerOhlcvRoute } from "./routes/ohlcv";
import { registerPoolRoute } from "./routes/pool";
import { registerSchedulerRoute } from "./routes/scheduler";
import { registerPnlRoute } from "./routes/pnl";

let server: FastifyInstance | null = null;

export interface StartWebServerArgs {
  host: string;
  port: number;
}

export async function startWebServer(args: StartWebServerArgs): Promise<void> {
  if (server) {
    logger.warn("web server already started — ignoring duplicate startWebServer() call");
    return;
  }

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "dashboard route error",
    );
    reply.status(500).send({ error: err instanceof Error ? err.message : "internal error" });
  });

  await registerStatusRoute(app);
  await registerHealthRoute(app);
  await registerDecisionsRoute(app);
  await registerIndicatorsRoute(app);
  await registerOhlcvRoute(app);
  await registerPoolRoute(app);
  await registerSchedulerRoute(app);
  await registerPnlRoute(app);

  // Serve the Vite-built static dashboard from dist/web. Skip if the build
  // hasn't been produced yet so the API still boots in dev (Vite serves the
  // UI on its own port via `npm run dev:web`).
  const staticRoot = path.resolve(__dirname, "../../dist/web");
  const staticFound = fs.existsSync(staticRoot);
  if (staticFound) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback: any non-API GET that doesn't match a static asset returns index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }
      reply.status(404).send({ error: "not found" });
    });
  }

  await app.listen({ host: args.host, port: args.port });
  server = app;
  logger.info(
    {
      host: args.host,
      port: args.port,
      mode: staticFound ? "spa" : "api-only",
      staticRoot,
    },
    staticFound
      ? "dashboard server listening (UI + API)"
      : "dashboard server listening (API only — run `npm run build:web` to bundle the UI)",
  );
}

export async function stopWebServer(): Promise<void> {
  if (!server) return;
  try {
    await server.close();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "dashboard server stop failed",
    );
  }
  server = null;
}
