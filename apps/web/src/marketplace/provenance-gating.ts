import type { EvidenceProvenance } from "@mandate/domain";
import { provenanceRank } from "@mandate/domain";

export interface AllowedProvenanceFields {
  canShowIdentityLink: boolean;
  canShowEndpointStatus: boolean;
  canShowTrialPass: boolean;
  canShowTrialReceipt: boolean;
  canShowMandateExecution: boolean;
  canShowIndependentVerification: boolean;
}

export function getAllowedProvenanceFields(provenance: EvidenceProvenance): AllowedProvenanceFields {
  const rank = provenanceRank(provenance);
  return {
    canShowIdentityLink: rank >= 2,
    canShowEndpointStatus: true,
    canShowTrialPass: rank >= 3,
    canShowTrialReceipt: rank >= 3,
    canShowMandateExecution: rank >= 4,
    canShowIndependentVerification: rank >= 5,
  };
}

export function formatTrialOutcome(provenance: EvidenceProvenance, rawOutcome?: string | null): string {
  const allowed = getAllowedProvenanceFields(provenance);
  if (!allowed.canShowTrialPass) {
    return "Not yet evidenced";
  }
  if (!rawOutcome) return "Not yet evidenced";
  return rawOutcome;
}
