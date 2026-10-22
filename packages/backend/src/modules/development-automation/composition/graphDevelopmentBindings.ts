import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import type { VerificationCommandEffectsFactory } from '../application/ports/verificationCommandEffects'
import { EvidenceStore } from '../infrastructure/evidenceStore'
import { createLocalVerificationCommandEffectsFactory } from '../infrastructure/local/verificationCommandEffects'
import { createGraphDesignArtifacts } from '../infrastructure/graph-development/designArtifacts'

export function createGraphDevelopmentArtifactBinding(
  appHome: string,
  selected?: EvidenceArtifactPort,
): EvidenceArtifactPort {
  return selected ?? new EvidenceStore(appHome)
}
export function createGraphDevelopmentVerificationBinding(
  selected?: VerificationCommandEffectsFactory,
) {
  return selected ?? createLocalVerificationCommandEffectsFactory()
}
export const graphDevelopmentRequestArtifacts = createGraphDesignArtifacts
