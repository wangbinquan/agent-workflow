import { createRuntimeProfileConfigurationCommands } from '../application/runtimeConfiguration'
import { withRuntimeProbeConfigFence } from '../infrastructure/runtimeProbeFence'
import type { RuntimeRegistryOperations } from '@/modules/runtime-management/application/ports/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../infrastructure/runtimeRegistryEffects'
import { createRuntimeManagement } from '../application/runtimeManagement'
import { createRuntimeManagementEffects } from '../infrastructure/runtimeManagementEffects'

export type { RuntimeDiagnosticDependencies } from '../infrastructure/runtimeManagementEffects'

/** One management instance supplies both route families; composition only binds effects. */
export function composeRuntimeManagement(
  input: Parameters<typeof createRuntimeManagementEffects>[0] & {
    readonly runtimeRegistry: RuntimeRegistryOperations
  },
) {
  const application = createRuntimeManagement({
    registry: input.runtimeRegistry,
    ...createRuntimeManagementEffects(input),
  })
  return Object.freeze({
    models: application.models,
    configuration: createRuntimeProfileConfigurationCommands(input.runtimeRegistry),
    runtimes: Object.freeze({
      protocols: createRuntimeRegistryEffects().protocols,
      profiles: application.profiles,
      queries: application.queries,
      diagnostics: application.diagnostics,
    }),
  })
}

export function composeRuntimeProbeConfigFence(configPath: string) {
  return <T>(operation: () => Promise<T>): Promise<T> =>
    withRuntimeProbeConfigFence(configPath, operation)
}
