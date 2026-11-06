import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import {
  bindNativeAgentMaterialWorkspace,
  selectLocalAgentMaterialDefinition,
} from '@/modules/runtime-management/composition/localAgentMaterial'
import { composeLocalTaskAgentRuntimeBindings } from '@/modules/runtime-management/composition/taskAgentRuntimeBindings'
import { composeLocalTaskAgentMaterialReferences } from '@/modules/resource-catalog/composition/taskAgentMaterialReferences'
import { composeLocalTaskAgentWorkspaceContents } from '@/modules/source-control/composition/taskAgentWorkspaceContents'
import { bindNativeAgentWorkspaceGitControlObservation } from '@/modules/source-control/composition/agentWorkspaceGitControl'
import type { TaskAgentRunFamily } from '../application/ports/taskAgentRunFamily'
import type { NodeRunRuntimePersistence } from '../application/ports/nodeRunRuntimePersistence'
import type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
import type { NodeRunPromptOperations } from '../application/ports/nodeRunPromptContent'
import type { PortArtifactOperations } from '../application/ports/portArtifactContent'
import { createLocalTaskAgentRunFamily } from '../infrastructure/local/taskAgentRunFamily'
import { composePortOutputContentValidation } from './portOutputValidation'
import { freezeBinaryConfig } from './runtimeConfigFreeze'

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
): TaskAgentRunFamily {
  const operationConfiguration =
    binding.operationConfiguration === undefined
      ? binding.request.operationConfiguration
      : binding.operationConfiguration
  return composeLocalTaskAgentRunFamily({
    appHome: binding.request.appHome,
    ...(binding.request.binaryOverride === undefined
      ? {}
      : { binaryOverride: binding.request.binaryOverride }),
    ...(binding.request.configPath === undefined ? {} : { configPath: binding.request.configPath }),
    nodeRunRuntime: binding.nodeRunRuntime,
    runtimeRegistry: binding.runtimeRegistry,
    nodeRunPrompts: binding.nodeRunPrompts,
    portArtifacts: binding.portArtifacts,
    ...(operationConfiguration === undefined ? {} : { operationConfiguration }),
  })
}

/** Native bootstrap facts stay at the local composition boundary. Normal
 * Task consumers receive only complete families and owner content references. RFC-422: the opener is
 * infrastructure/local/taskAgentRunFamily.ts; this root selects the runtime-management, resource-catalog and
 * source-control providers. */
export function composeLocalTaskAgentRunFamily(input: {
  readonly appHome: string
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly runtimeRegistry: RuntimeExecutionQueries
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly binaryOverride?: readonly string[]
  readonly configPath?: string
  readonly operationConfiguration?: TaskOperationConfigurationQueries
}): TaskAgentRunFamily {
  return createLocalTaskAgentRunFamily(input, {
    runtimes: composeLocalTaskAgentRuntimeBindings({
      persistence: input.nodeRunRuntime,
      registry: input.runtimeRegistry,
      readBinaryConfiguration: () =>
        freezeBinaryConfig(input.configPath, input.operationConfiguration),
    }),
    resources: composeLocalTaskAgentMaterialReferences({ appHome: input.appHome }),
    workspaceContents: composeLocalTaskAgentWorkspaceContents,
    gitControlObservation: bindNativeAgentWorkspaceGitControlObservation,
    materialWorkspaces: bindNativeAgentMaterialWorkspace,
    materialDefinitions: selectLocalAgentMaterialDefinition,
    outputValidation: composePortOutputContentValidation,
  })
}
