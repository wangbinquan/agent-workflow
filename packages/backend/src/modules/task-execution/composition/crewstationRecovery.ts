import { createHostedRecoverySelection } from '../infrastructure/crewstation/hostedRecoverySelection'
import type { TaskRecoveryDeploymentSelection } from '../infrastructure/taskRecoverySelection'

/** RFC-370 §9.2 V4 — hosted platform recovery for AW tasks. RFC-423: the selection is
 * infrastructure/crewstation/hostedRecoverySelection.ts; bootstrap keeps this composition entry. */
export function composeCrewStationRecovery(
  input: Parameters<typeof createHostedRecoverySelection>[0],
): TaskRecoveryDeploymentSelection {
  return createHostedRecoverySelection(input)
}
