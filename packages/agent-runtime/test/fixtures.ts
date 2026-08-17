import type { AgentExecutor, Proposal, ProposalRequest } from "../src/executor.js";
import type { AgentRuntimeConfig } from "../src/config.js";

export const TEST_WALLET = "0x1111111111111111111111111111111111111111" as const;
export const TEST_TARGET = "0x2222222222222222222222222222222222222222" as const;

export const TEST_CONFIG: AgentRuntimeConfig = {
  host: "127.0.0.1",
  port: 0,
  publicUrl: "http://localhost:9000",
  chainId: 97,
  rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
  fallbackRpcUrl: undefined,
  logLevel: "error",
};

/** An executor with no chain access, so wire behaviour can be tested in isolation. */
export function stubExecutor(overrides: Partial<AgentExecutor> = {}): AgentExecutor {
  return {
    slug: "stub-agent",
    displayName: "Stub Agent",
    description: "Fixture agent.",
    category: "HEALTH_FACTOR",
    skills: [
      { id: "restore-health-factor", name: "Restore health factor", description: "Fixture.", tags: ["venus"] },
    ],
    policy: { thresholdMantissa: "1300000000000000000" },
    propose(request: ProposalRequest): Promise<Proposal> {
      return Promise.resolve({
        decision: "PROPOSE",
        action: {
          target: TEST_TARGET,
          selector: "0x0e752702",
          args: [{ type: "uint256", value: "1000000" }],
          rationale: `acting for ${request.wallet}`,
        },
        observations: { requestId: request.requestId },
      });
    },
    ...overrides,
  };
}

export function messageSend(data: Record<string, unknown>, id: number | string = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "11111111-2222-3333-4444-555555555555",
        parts: [{ kind: "data", data }],
      },
    },
  };
}
