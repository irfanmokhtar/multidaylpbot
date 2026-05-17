import { loadConfig } from "./config";

/**
 * Returns the address of the pool the bot manages, or null if POOL_ADDRESS
 * is not set in the environment.
 */
export function resolveActivePool(): string | null {
  return loadConfig().POOL_ADDRESS || null;
}
