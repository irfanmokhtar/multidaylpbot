import pino from "pino";
import { loadConfig } from "./config";

const cfg = loadConfig();

export const logger = pino({
  level: cfg.LOG_LEVEL,
  redact: {
    paths: ["WALLET_PRIVATE_KEY", "*.WALLET_PRIVATE_KEY", "secretKey", "*.secretKey"],
    censor: "[REDACTED]",
  },
  transport:
    process.stdout.isTTY
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});
