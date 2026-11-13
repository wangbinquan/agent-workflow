// RFC-489 — Runtime Management assembles its own native runtime management: diagnostic targets, effects, application and
// binding (moved from Task Execution's root). The smoke run family is Task Execution's; bootstrap passes it in through
// the effects' own smoke port, built over this assembly's diagnostic targets.
import { createLocalRuntimeDiagnosticTargets } from './runtimeDiagnosticTargets'
import { createLocalRuntimeManagementEffects } from '../infrastructure/local/runtimeManagementEffects'
import { bindRuntimeManagement } from './runtimeManagement'

type LocalRuntimeManagementEffectsInput = Parameters<typeof createLocalRuntimeManagementEffects>[0]

/** The diagnostic targets one native assembly shares between its effects and its smoke run family. */
export type LocalRuntimeDiagnosticTargets = LocalRuntimeManagementEffectsInput['targets']

/** The effects' own smoke port. */
export type LocalRuntimeSmoke = LocalRuntimeManagementEffectsInput['smoke']

export interface LocalRuntimeManagementInput extends Omit<
  LocalRuntimeManagementEffectsInput,
  'targets' | 'smoke'
> {
  readonly runtimeRegistry: Parameters<typeof bindRuntimeManagement>[0]['runtimeRegistry']
  /** The smoke run family over this assembly's diagnostic targets (bound by bootstrap). */
  smoke(targets: LocalRuntimeDiagnosticTargets): LocalRuntimeSmoke
}

/** A native root selects every capability as one family; ordinary management
 * receives required effects and never chooses an implicit native runner. */
export function composeLocalRuntimeManagement(input: LocalRuntimeManagementInput) {
  const targets = createLocalRuntimeDiagnosticTargets()
  const smoke = input.smoke(targets)
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
