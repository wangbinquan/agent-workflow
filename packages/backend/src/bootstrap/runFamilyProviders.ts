// RFC-489 — bootstrap binds the other modules' implementations into Task Execution's run families (runtime-management's
// material workspaces, material definitions, runtime bindings and retained contents; resource-catalog's material
// references; source-control's workspace contents and git observation), and pairs runtime-management's own
// runtime-management assembly with Task Execution's smoke run families (native and hosted). The run-family roots keep
// their Task Execution logic; no module's composition imports another module's composition or infrastructure for this.
import {
  bindNativeAgentMaterialWorkspace,
  selectLocalAgentMaterialDefinition,
} from '@/modules/runtime-management/composition/localAgentMaterial'
import {
  createLocalSystemAgentRetainedContents,
  createLocalSystemAgentRuntimeBindings,
} from '@/modules/runtime-management/composition/systemAgentMaterial'
import { composeLocalTaskAgentRuntimeBindings } from '@/modules/runtime-management/composition/taskAgentRuntimeBindings'
import { composeCrewStationSystemAgentContents } from '@/modules/runtime-management/composition/crewstationSystemAgentMaterial'
import {
  composeLocalRuntimeManagement,
  type LocalRuntimeManagementInput,
} from '@/modules/runtime-management/composition/localRuntimeManagement'
import { composeCrewStationRuntimeManagement } from '@/modules/runtime-management/composition/crewstationRuntimeManagement'
import { composeLocalTaskAgentMaterialReferences } from '@/modules/resource-catalog/composition/taskAgentMaterialReferences'
import { composeLocalTaskAgentWorkspaceContents } from '@/modules/source-control/composition/taskAgentWorkspaceContents'
import { bindNativeAgentWorkspaceGitControlObservation } from '@/modules/source-control/composition/agentWorkspaceGitControl'
import {
  composeLocalRuntimeSmokeRunFamily,
  type LocalRuntimeSmokeRunProviders,
} from '@/modules/task-execution/composition/localRuntimeSmokeRunFamily'
import {
  composeLocalSystemAgentRunFamily,
  type LocalSystemAgentRunProviders,
} from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import { createCrewStationSystemAgentRunFamily } from '@/modules/task-execution/composition/crewstationSystemAgentRunFamily'
import type { LocalTaskAgentRunProviders } from '@/modules/task-execution/composition/localTaskAgentRunFamily'
import { createHostedRuntimeSmokeProbe } from '@/modules/task-execution/composition/crewstationRuntimeSmoke'

/** The native smoke run family's providers (runtime-management). */
export const localRuntimeSmokeRunProviders: LocalRuntimeSmokeRunProviders = Object.freeze({
  materialWorkspaces: bindNativeAgentMaterialWorkspace,
  materialDefinitions: selectLocalAgentMaterialDefinition,
})

/** The native system agent run family's providers (runtime-management). */
export const localSystemAgentRunProviders: LocalSystemAgentRunProviders<
  ReturnType<typeof createLocalSystemAgentRuntimeBindings>['bindRuntime']
> = Object.freeze({
  runtimes: createLocalSystemAgentRuntimeBindings,
  contents: createLocalSystemAgentRetainedContents,
  materialDefinitions: selectLocalAgentMaterialDefinition,
})

/** The native task agent run family's providers (runtime-management, resource-catalog, source-control). */
export const localTaskAgentRunProviders: LocalTaskAgentRunProviders = Object.freeze({
  runtimes: composeLocalTaskAgentRuntimeBindings,
  resources: composeLocalTaskAgentMaterialReferences,
  workspaceContents: composeLocalTaskAgentWorkspaceContents,
  gitControlObservation: bindNativeAgentWorkspaceGitControlObservation,
  materialWorkspaces: bindNativeAgentMaterialWorkspace,
  materialDefinitions: selectLocalAgentMaterialDefinition,
})

/** The native system agent run family selection: one family per call. */
export function composeLocalSystemAgentRunFamilySelection(
  input: Parameters<typeof composeLocalSystemAgentRunFamily>[0],
) {
  return composeLocalSystemAgentRunFamily(input, localSystemAgentRunProviders)
}

/** What the observation modules pass the runtime-management selection: Runtime Management's assembly input without
 * the smoke run family, plus what Task Execution's smoke run family reads. */
export interface RuntimeManagementSelectionInput extends Omit<
  LocalRuntimeManagementInput,
  'smoke'
> {
  appHome(): string
  readonly observations?: Parameters<typeof composeLocalRuntimeSmokeRunFamily>[0]['observations']
}

/** Native runtime management: Runtime Management's own assembly, with Task Execution's native smoke run family over
 * the assembly's diagnostic targets. Every read of the selection input keeps its original timing. */
export function composeLocalRuntimeManagementSelection(input: RuntimeManagementSelectionInput) {
  return composeLocalRuntimeManagement({
    get configuration() {
      return input.configuration
    },
    get runtimeTests() {
      return input.runtimeTests
    },
    get runtimeDiagnosticTestDependencies() {
      return input.runtimeDiagnosticTestDependencies
    },
    get runtimeRegistry() {
      return input.runtimeRegistry
    },
    smoke: (targets) =>
      composeLocalRuntimeSmokeRunFamily(
        {
          targets,
          appHome: () => input.appHome(),
          ...(input.observations ? { observations: input.observations } : {}),
        },
        localRuntimeSmokeRunProviders,
      ),
  })
}

/** The hosted Agent inputs the CrewStation run families share (Task Execution's hosted run-family input plus the capability
 * readers runtime management takes) — the input the two pairings had before RFC-489. */
type CrewStationHostedAgents = Parameters<typeof createCrewStationSystemAgentRunFamily>[0] &
  Pick<
    Parameters<typeof composeCrewStationRuntimeManagement>[0]['effects'],
    'initialCapabilities' | 'capabilities'
  >

/** The CrewStation run-family selections: the hosted System Agent family over runtime-management's hosted contents,
 * and runtime-management's hosted runtime management with the hosted smoke probe. Each receives the same input it
 * received before RFC-489 (the System Agent family without the capability readers). */
export function composeCrewStationRunFamilySelections(hosted: CrewStationHostedAgents) {
  const {
    capabilities: _capabilities,
    initialCapabilities: _initialCapabilities,
    ...hostedRunFamily
  } = hosted
  return {
    systemAgentRunFamily: createCrewStationSystemAgentRunFamily(hostedRunFamily, {
      contents: composeCrewStationSystemAgentContents,
      local: localSystemAgentRunProviders,
    }),
    runtimeManagement: (options: RuntimeManagementSelectionInput) => {
      const smoke = createHostedRuntimeSmokeProbe(hosted, options, {
        contents: composeCrewStationSystemAgentContents,
      })
      return composeCrewStationRuntimeManagement({
        runtimeRegistry: options.runtimeRegistry,
        effects: {
          ...hosted,
          configuration: options.configuration,
          runtimeTests: options.runtimeTests,
          smoke,
        },
      })
    },
  }
}
