/**
 * Lifecycle state machines for trials and mandates.
 *
 * Transitions are enumerated rather than implied so that an illegal move fails
 * at the boundary instead of leaving a mandate in a state the UI will describe
 * incorrectly. Two rules are load-bearing:
 *  - `ERROR` never becomes `FAILED`; infrastructure trouble is not an agent's fault.
 *  - There is no `PAUSED` state, because a mandate that looks paused while its
 *    session still executes would be a lie told by the interface.
 */

export const TRIAL_STATES = [
  "DRAFT",
  "SPEC_FROZEN",
  "QUEUED",
  "ENVIRONMENT_READY",
  "RUNNING",
  "EVALUATING",
  "PASSED",
  "FAILED",
  "ERROR",
  "RECEIPT_PUBLISHED",
] as const;

export type TrialState = (typeof TRIAL_STATES)[number];

const TRIAL_TRANSITIONS: Record<TrialState, readonly TrialState[]> = {
  DRAFT: ["SPEC_FROZEN"],
  SPEC_FROZEN: ["QUEUED"],
  QUEUED: ["ENVIRONMENT_READY", "ERROR"],
  ENVIRONMENT_READY: ["RUNNING", "ERROR"],
  RUNNING: ["EVALUATING", "ERROR"],
  EVALUATING: ["PASSED", "FAILED", "ERROR"],
  PASSED: ["RECEIPT_PUBLISHED"],
  FAILED: ["RECEIPT_PUBLISHED"],
  ERROR: [],
  RECEIPT_PUBLISHED: [],
};

export const MANDATE_STATES = [
  "DRAFT",
  "TRIAL_REQUIRED",
  "TRIAL_RUNNING",
  "TRIAL_FAILED",
  "TRIAL_ERROR",
  "TRIAL_PASSED",
  "READY",
  "HIRE_PENDING",
  "HIRED",
  "HIRE_FAILED",
  "GRANT_PENDING",
  "GRANT_FAILED",
  "ACTIVE",
  "EXPIRING",
  "EXPIRED",
  "REVOKE_PENDING",
  "REVOKED",
  "SECURITY_INVALIDATED",
  "RENEWAL_REQUIRED",
] as const;

export type MandateState = (typeof MANDATE_STATES)[number];

const MANDATE_TRANSITIONS: Record<MandateState, readonly MandateState[]> = {
  DRAFT: ["TRIAL_REQUIRED"],
  TRIAL_REQUIRED: ["TRIAL_RUNNING"],
  TRIAL_RUNNING: ["TRIAL_PASSED", "TRIAL_FAILED", "TRIAL_ERROR"],
  TRIAL_ERROR: ["TRIAL_REQUIRED"],
  TRIAL_FAILED: ["TRIAL_REQUIRED"],
  TRIAL_PASSED: ["READY"],
  READY: ["HIRE_PENDING", "GRANT_PENDING"],
  HIRE_PENDING: ["HIRED", "HIRE_FAILED"],
  HIRE_FAILED: ["READY"],
  // A funded commercial job with no wallet session is a legitimate resting
  // state, so HIRED does not imply the agent may touch anything.
  HIRED: ["GRANT_PENDING"],
  GRANT_PENDING: ["ACTIVE", "GRANT_FAILED"],
  GRANT_FAILED: ["READY"],
  ACTIVE: ["EXPIRING", "REVOKE_PENDING", "SECURITY_INVALIDATED"],
  EXPIRING: ["EXPIRED", "REVOKE_PENDING", "SECURITY_INVALIDATED"],
  EXPIRED: ["RENEWAL_REQUIRED"],
  REVOKE_PENDING: ["REVOKED"],
  REVOKED: [],
  SECURITY_INVALIDATED: ["REVOKE_PENDING"],
  RENEWAL_REQUIRED: ["TRIAL_REQUIRED", "READY"],
};

export class IllegalTransitionError extends Error {
  constructor(machine: string, from: string, to: string) {
    super(`${machine}: ${from} -> ${to} is not a legal transition`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransitionTrial(from: TrialState, to: TrialState): boolean {
  return TRIAL_TRANSITIONS[from].includes(to);
}

export function assertTrialTransition(from: TrialState, to: TrialState): void {
  if (!canTransitionTrial(from, to)) throw new IllegalTransitionError("trial", from, to);
}

export function canTransitionMandate(from: MandateState, to: MandateState): boolean {
  return MANDATE_TRANSITIONS[from].includes(to);
}

export function assertMandateTransition(from: MandateState, to: MandateState): void {
  if (!canTransitionMandate(from, to)) throw new IllegalTransitionError("mandate", from, to);
}

export function trialTransitions(from: TrialState): readonly TrialState[] {
  return TRIAL_TRANSITIONS[from];
}

export function mandateTransitions(from: MandateState): readonly MandateState[] {
  return MANDATE_TRANSITIONS[from];
}

/** States in which a session can move user funds. Anything else must not display as live authority. */
export const AUTHORITY_LIVE_STATES: readonly MandateState[] = ["ACTIVE", "EXPIRING"];

export function hasLiveAuthority(state: MandateState): boolean {
  return AUTHORITY_LIVE_STATES.includes(state);
}

/**
 * Why an execution attempt did not succeed.
 *
 * These stay separate because they call for different responses: a blocked
 * out-of-scope call is the system working, while an RPC error is not. Collapsing
 * them into one "failed" bucket would hide the distinction the product exists to
 * make.
 */
export const EXECUTION_FAILURE_REASONS = [
  "MARKET_CHANGED",
  "INSUFFICIENT_SCOPE",
  "PROTOCOL_REVERT",
  "AGENT_ERROR",
  "RPC_ERROR",
  "EXPIRED",
  "REVOKED",
] as const;

export type ExecutionFailureReason = (typeof EXECUTION_FAILURE_REASONS)[number];

/** Agent-endpoint failure modes, kept distinct so a slow agent is not recorded as a broken one. */
export const AGENT_ERROR_CODES = [
  "ENDPOINT_OFFLINE",
  "ENDPOINT_TIMEOUT",
  "UNSUPPORTED_TASK",
  "AGENT_PROTOCOL_ERROR",
  "AGENT_EXECUTION_ERROR",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** Chain confirmation depth. A transaction is not a result until policy says it is. */
export const CONFIRMATION_STATES = ["SUBMITTED", "MINED", "CONFIRMED", "FINALIZED_BY_POLICY"] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];
