import { bindNativeAgentProtocol } from '@/modules/runtime-management/infrastructure/local/agentProtocol'
import {
  bindNativeAgentMaterialWorkspace,
  selectLocalAgentMaterialDefinition,
} from '@/modules/runtime-management/composition/localAgentMaterial'
import type { createLocalRuntimeDiagnosticTargets } from '@/modules/runtime-management/composition/runtimeDiagnosticTargets'
import type { SystemAgentObservationFactory } from '../application/ports/systemAgentObservation'
import { createLocalRuntimeSmokeRunFamily } from '../infrastructure/local/runtimeSmokeRunFamily'

/** The native root pairs the target owner, original material builder and
 * executor. The normal family never receives their physical locations. RFC-422: the opener is
 * infrastructure/local/runtimeSmokeRunFamily.ts; this root selects the runtime-management providers. */
export function composeLocalRuntimeSmokeRunFamily(input: {
  appHome(): string
  readonly targets: ReturnType<typeof createLocalRuntimeDiagnosticTargets>
  readonly observations?: () => SystemAgentObservationFactory
}) {
  return createLocalRuntimeSmokeRunFamily(input, {
    materialWorkspaces: bindNativeAgentMaterialWorkspace,
    materialDefinitions: selectLocalAgentMaterialDefinition,
    bindProtocol: bindNativeAgentProtocol,
  })
}
