import type { RuntimeManagementEffects } from '../application/ports/runtimeManagement'
import { createRuntimeProfileConfigurationCommands } from '../application/runtimeConfiguration'
import { withRuntimeProbeConfigFence } from '../infrastructure/runtimeProbeFence'
import type { RuntimeRegistryOperations } from '@/modules/runtime-management/application/ports/runtimeRegistry'
import { createRuntimeManagement } from '../application/runtimeManagement'
import { createRuntimeObservationQueries } from '../application/runtimeObservationQueries'

export type { RuntimeDiagnosticDependencies } from '../infrastructure/runtimeManagementEffects'

/** Pure binding exposes the actual application context only to explicit
 * bootstrap compatibility projections; ordinary effects keep their receiver. */
export function bindRuntimeManagement(input: {
  readonly runtimeRegistry: RuntimeRegistryOperations
  readonly effects: RuntimeManagementEffects
}) {
  const runtimeRegistry = input.runtimeRegistry
  const effects = input.effects
  const beforeProbeReceipt = effects.beforeProbeReceipt
  const dependencies = {
    registry: runtimeRegistry,
    get config() {
      return effects.config
    },
    get drivers() {
      return effects.drivers
    },
    get modelDiscovery() {
      return effects.modelDiscovery
    },
    get tests() {
      return effects.tests
    },
    get statusProbeTimeoutMs() {
      return effects.statusProbeTimeoutMs
    },
    beforeProbeReceipt: () => beforeProbeReceipt.call(effects),
  }
  const application = createRuntimeManagement(dependencies)
  const management = Object.freeze({
    observations: createRuntimeObservationQueries(runtimeRegistry),
    models: application.models,
    configuration: createRuntimeProfileConfigurationCommands(runtimeRegistry),
    runtimes: Object.freeze({
      protocols: effects.protocols,
      profiles: application.profiles,
      queries: application.queries,
      diagnostics: application.diagnostics,
    }),
  })
  return { dependencies, management }
}

/** One required family supplies both ordinary management route families. */
export function composeRuntimeManagement(input: Parameters<typeof bindRuntimeManagement>[0]) {
  return bindRuntimeManagement(input).management
}

export function composeRuntimeProbeConfigFence(configPath: string) {
  return <T>(operation: () => Promise<T>): Promise<T> =>
    withRuntimeProbeConfigFence(configPath, operation)
}
