import type { SelectedPipelineEvidenceExecution } from '../composition'
import type { PipelineEvidencePort } from '../application/ports/reconcilerPorts'
import type { PipelineStagingFactories } from '../application/ports/evidenceStaging'
import { createSelectedPipelineEvidence } from '../application/selectedPipelineEvidence'
export {
  composeLegacyDevelopmentPipelineEvidence,
  type LegacyPipelineEvidencePort,
} from '../infrastructure/local/legacyPipelineEvidence'

export function composeSelectedDevelopmentPipelineEvidence(
  runner: SelectedPipelineEvidenceExecution,
  staging: PipelineStagingFactories,
): {
  readonly pipelineEvidence: PipelineEvidencePort
} {
  return { pipelineEvidence: createSelectedPipelineEvidence(runner, staging) }
}
