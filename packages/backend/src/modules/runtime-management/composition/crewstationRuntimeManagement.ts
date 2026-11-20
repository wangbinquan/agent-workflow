import { composeRuntimeManagement } from './runtimeManagement'
import { createCrewStationRuntimeManagementEffects } from '../infrastructure/crewstation/runtimeManagementEffects'
// RFC-519: the hosted effects, the capability schema and the profile mapping live in infrastructure/crewstation.
export {
  HostedRuntimeCapabilitiesSchema,
  createCrewStationRuntimeManagementEffects,
  type HostedRuntimeCapabilities,
  type HostedRuntimeProfileMapping,
} from '../infrastructure/crewstation/runtimeManagementEffects'

/** RFC-489: Runtime Management assembles its hosted runtime management itself (moved from Task Execution's root); the
 * hosted smoke probe is Task Execution's and arrives inside the effects input (bound by bootstrap). */
export function composeCrewStationRuntimeManagement(input: {
  readonly runtimeRegistry: Parameters<typeof composeRuntimeManagement>[0]['runtimeRegistry']
  readonly effects: Parameters<typeof createCrewStationRuntimeManagementEffects>[0]
}) {
  return composeRuntimeManagement({
    runtimeRegistry: input.runtimeRegistry,
    effects: createCrewStationRuntimeManagementEffects(input.effects),
  })
}
