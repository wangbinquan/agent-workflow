import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { NodeRunRuntimePersistence } from '../application/ports/nodeRunRuntimePersistence'
import type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import { createLocalTaskAgentRunFamily } from '../infrastructure/local/taskAgentRunFamily'
import { composePortOutputContentValidation } from './portOutputValidation'
import { freezeBinaryConfig } from './runtimeConfigFreeze'

type LocalTaskAgentRunFamilyProviders = Parameters<typeof createLocalTaskAgentRunFamily>[1]

/** RFC-489: the other modules' implementations the native task agent run family receives (bootstrap passes them in):
 * runtime-management's runtime bindings, material workspaces and definitions, resource-catalog's material references,
 * source-control's workspace contents and git observation. RFC-491: runtime-management's plugin-load failure judgment. */
export interface LocalTaskAgentRunProviders {
  runtimes(input: {
    readonly persistence: NodeRunRuntimePersistence
    readonly registry: RuntimeExecutionQueries
    readBinaryConfiguration(): ReturnType<typeof freezeBinaryConfig>
  }): LocalTaskAgentRunFamilyProviders['runtimes']
  resources(input: { readonly appHome: string }): LocalTaskAgentRunFamilyProviders['resources']
  readonly workspaceContents: LocalTaskAgentRunFamilyProviders['workspaceContents']
  readonly gitControlObservation: LocalTaskAgentRunFamilyProviders['gitControlObservation']
  readonly materialWorkspaces: LocalTaskAgentRunFamilyProviders['materialWorkspaces']
  readonly materialDefinitions: LocalTaskAgentRunFamilyProviders['materialDefinitions']
  readonly pluginLoadFailures: LocalTaskAgentRunFamilyProviders['pluginLoadFailures']
}

/** Binding input used only at bootstrap's native composition boundary. */
export interface LocalTaskAgentRunFamilyBinding {
  readonly request: {
    readonly appHome: string
    readonly binaryOverride?: readonly string[]
    readonly configPath?: string
    readonly operationConfiguration?: TaskOperationConfigurationQueries
  }
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly runtimeRegistry: RuntimeExecutionQueries
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly operationConfiguration?: TaskOperationConfigurationQueries
}

/** Explicit local family selection shared by production and fixture roots. */
export function composeLocalTaskAgentRunFamilyFor(
  binding: LocalTaskAgentRunFamilyBinding,
  providers: LocalTaskAgentRunProviders,
): TaskAgentRunFamily {
  const operationConfiguration =
    binding.operationConfiguration === undefined
      ? binding.request.operationConfiguration
      : binding.operationConfiguration
  return composeLocalTaskAgentRunFamily(
    {
      appHome: binding.request.appHome,
      ...(binding.request.binaryOverride === undefined
        ? {}
        : { binaryOverride: binding.request.binaryOverride }),
      ...(binding.request.configPath === undefined
        ? {}
        : { configPath: binding.request.configPath }),
      nodeRunRuntime: binding.nodeRunRuntime,
      runtimeRegistry: binding.runtimeRegistry,
      nodeRunPrompts: binding.nodeRunPrompts,
      portArtifacts: binding.portArtifacts,
      ...(operationConfiguration === undefined ? {} : { operationConfiguration }),
    },
    providers,
  )
}

/** Native bootstrap facts stay at the local composition boundary. Normal
 * Task consumers receive only complete families and owner content references. RFC-422: the opener is
 * infrastructure/local/taskAgentRunFamily.ts. RFC-489: the runtime-management, resource-catalog and source-control
 * providers arrive from bootstrap; this root keeps the binary-configuration freeze and the output validation. */
export function composeLocalTaskAgentRunFamily(
  input: {
    readonly appHome: string
    readonly nodeRunRuntime: NodeRunRuntimePersistence
    readonly runtimeRegistry: RuntimeExecutionQueries
    readonly nodeRunPrompts: NodeRunPromptOperations
    readonly portArtifacts: PortArtifactOperations
    readonly binaryOverride?: readonly string[]
    readonly configPath?: string
    readonly operationConfiguration?: TaskOperationConfigurationQueries
  },
  providers: LocalTaskAgentRunProviders,
): TaskAgentRunFamily {
  return createLocalTaskAgentRunFamily(input, {
    runtimes: providers.runtimes({
      persistence: input.nodeRunRuntime,
      registry: input.runtimeRegistry,
      readBinaryConfiguration: () =>
        freezeBinaryConfig(input.configPath, input.operationConfiguration),
    }),
    resources: providers.resources({ appHome: input.appHome }),
    workspaceContents: providers.workspaceContents,
    gitControlObservation: providers.gitControlObservation,
    materialWorkspaces: providers.materialWorkspaces,
    materialDefinitions: providers.materialDefinitions,
    pluginLoadFailures: providers.pluginLoadFailures,
    outputValidation: composePortOutputContentValidation,
  })
}
