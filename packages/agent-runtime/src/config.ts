/**
 * Runtime configuration, read once at boot.
 *
 * Two defaults are chosen rather than inherited and both are operational
 * lessons rather than taste:
 *
 *  - `HOST` defaults to `0.0.0.0`. A process bound to `127.0.0.1` starts
 *    cleanly, serves nothing to the platform, and fails its healthcheck with no
 *    error in the log. That failure mode has already cost this project time on
 *    Anvil (`00-DECISIONS.md` B14) and is not worth repeating.
 *  - `PORT` defaults to 9000, the port the Studio scaffold serves A2A on, and is
 *    overridden by the platform-injected `PORT` wherever one exists.
 */
import { isLogLevel } from "./logging.js";
import type { LogLevel } from "./logging.js";

export const DEFAULT_PORT = 9000;
export const DEFAULT_CHAIN_ID = 97;
export const DEFAULT_RPC_URL = "https://bsc-testnet-rpc.publicnode.com";
export const DEFAULT_FALLBACK_RPC_URL = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";

export interface AgentRuntimeConfig {
  readonly host: string;
  readonly port: number;
  /** Advertised in the agent card. Falls back to the bound address for local runs. */
  readonly publicUrl: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly fallbackRpcUrl: string | undefined;
  readonly logLevel: LogLevel;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function readInteger(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${key} must be a positive integer, received '${raw}'`);
  }
  return parsed;
}

export function readRuntimeConfig(env: EnvSource = process.env): AgentRuntimeConfig {
  const host = env["HOST"] ?? "0.0.0.0";
  const port = readInteger(env, "PORT", DEFAULT_PORT);
  const rawLevel = env["LOG_LEVEL"] ?? "info";
  if (!isLogLevel(rawLevel)) {
    throw new ConfigurationError(`LOG_LEVEL must be one of debug|info|warn|error, received '${rawLevel}'`);
  }

  const fallbackRpcUrl = env["RPC_FALLBACK_URL"] ?? DEFAULT_FALLBACK_RPC_URL;

  return {
    host,
    port,
    publicUrl: env["AGENT_PUBLIC_URL"] ?? `http://localhost:${port}`,
    chainId: readInteger(env, "CHAIN_ID", DEFAULT_CHAIN_ID),
    rpcUrl: env["RPC_URL"] ?? DEFAULT_RPC_URL,
    fallbackRpcUrl: fallbackRpcUrl === "" ? undefined : fallbackRpcUrl,
    logLevel: rawLevel,
  };
}
