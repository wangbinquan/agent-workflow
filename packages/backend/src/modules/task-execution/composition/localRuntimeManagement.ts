import { createLocalRuntimeDiagnosticTargets } from '@/modules/runtime-management/composition/runtimeDiagnosticTargets'
import { createLocalRuntimeManagementEffects } from '@/modules/runtime-management/infrastructure/local/runtimeManagementEffects'
import { bindRuntimeManagement } from '@/modules/runtime-management/composition/runtimeManagement'
import { composeLocalRuntimeSmokeRunFamily } from './localRuntimeSmokeRunFamily'

/** A native root selects every capability as one family; ordinary management
 * receives required effects and never chooses an implicit native runner. */
export function composeLocalRuntimeManagement(
  input: Omit<Parameters<typeof createLocalRuntimeManagementEffects>[0], 'targets' | 'smoke'> & {
    readonly runtimeRegistry: Parameters<typeof bindRuntimeManagement>[0]['runtimeRegistry']
    appHome(): string
  },
) {
  const targets = createLocalRuntimeDiagnosticTargets()
  const smoke = composeLocalRuntimeSmokeRunFamily({
    targets,
    appHome: () => input.appHome(),
  })
  const runtimeRegistry = input.runtimeRegistry
  const effects = createLocalRuntimeManagementEffects({
    get configuration() {
      return input.configuration
    },
    get runtimeTests() {
      return input.runtimeTests
    },
    get runtimeDiagnosticTestDependencies() {
      return input.runtimeDiagnosticTestDependencies
    },
    targets,
    smoke,
  })
  const binding = bindRuntimeManagement({ runtimeRegistry, effects })
  // Original native fixtures were copied into the actual application deps and
  // invoked there. Only this explicit native root restores that exact callback.
  binding.dependencies.beforeProbeReceipt = effects.beforeProbeReceipt
  return binding.management
}
