import {
  createCrewStationRuntimeManagementEffects,
  type HostedRuntimeCapabilities,
} from '@/modules/runtime-management/composition/crewstationRuntimeManagement'
import { composeRuntimeManagement } from '@/modules/runtime-management/composition/runtimeManagement'
import { composeCrewStationSystemAgentContents } from '@/modules/runtime-management/composition/crewstationSystemAgentMaterial'
import type { HostedRunFamilyInput } from '../infrastructure/crewstation/hostedRunFamilyProviders'
import { createHostedRuntimeSmokeProbe } from '../infrastructure/crewstation/runtimeSmokeRunFamily'
import type { composeLocalRuntimeManagement } from './localRuntimeManagement'

export { HOSTED_RUNTIME_PROBE_BUDGET_MS } from '../infrastructure/crewstation/runtimeSmokeRunFamily'

/** RFC-422: the hosted probe is infrastructure/crewstation/runtimeSmokeRunFamily.ts; this root pairs it with
 * runtime-management's hosted contents, effects and management binding. */
export function createCrewStationRuntimeManagement(
  input: HostedRunFamilyInput & {
    readonly initialCapabilities: HostedRuntimeCapabilities
    readonly capabilities: () => Promise<HostedRuntimeCapabilities>
  },
): typeof composeLocalRuntimeManagement {
  return (options) => {
    const smoke = createHostedRuntimeSmokeProbe(input, options, {
      contents: composeCrewStationSystemAgentContents,
    })
    return composeRuntimeManagement({
      runtimeRegistry: options.runtimeRegistry,
      effects: createCrewStationRuntimeManagementEffects({
        ...input,
        configuration: options.configuration,
        runtimeTests: options.runtimeTests,
        smoke,
      }),
    })
  }
}
