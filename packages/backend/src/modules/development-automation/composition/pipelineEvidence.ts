import type {
  PipelineEvidencePort,
  SelectedPipelineEvidenceRunnerPort,
} from '../application/ports/reconcilerPorts'
import type { PipelineStagingFactories } from '../application/ports/evidenceStaging'
import { createSelectedPipelineEvidence } from '../application/selectedPipelineEvidence'

export function composeSelectedDevelopmentPipelineEvidence(
  runner: SelectedPipelineEvidenceRunnerPort,
  staging: PipelineStagingFactories,
): {
  readonly pipelineEvidence: PipelineEvidencePort
} {
  return { pipelineEvidence: createSelectedPipelineEvidence(runner, staging) }
}
