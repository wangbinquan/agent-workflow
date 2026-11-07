import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type { AgentWorkspaceGitControlObservation } from '@/modules/source-control/public/participants'
import type { NodeRunPromptOperations, PortArtifactOperations } from '../../public/types'
import type { AgentExecutionParticipants } from './agentExecutionBinding'
import type { AgentInvocationBinding } from './agentInvocation'
import type { PortOutputContentValidation } from './portOutputValidation'
import type { TaskExecutionEffectPersistence } from './taskExecutionEffectStore'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { Logger } from '@/util/log'
import type { CompiledAgentInvocation } from './agentInvocationPreparation'
import type { NodeStatusEvents } from './nodeExecutionSupport'

/** Complete AW declaration. Resource locations, readers and command fixtures
 * belong to the selected preparation, which adds its own ordered references. */
export type TaskAgentMaterialDeclaration = Omit<
  AgentMaterialIntent,
  'workspace' | 'runContent' | 'taskMounts' | 'runtimeBinding' | 'injection'
> & {
  readonly injection: Omit<AgentMaterialIntent['injection'], 'skills' | 'plugins'>
}

/** Native raw-plan compatibility may omit metadata, as in the original API.
 * Normal compilation supplies its complete declaration and capabilities on
 * the same bound invocation. Neither branch exposes a plan, argv or env. */
export interface TaskCompiledAgentInvocation {
  readonly declared?: CompiledAgentInvocation['declared']
  readonly evidenceCapabilities?: CompiledAgentInvocation['evidenceCapabilities']
  bind(): AgentInvocationBinding
  readDeclaredMcpServers(): readonly string[] | undefined
  reportSpawn(
    log: Logger,
    input: {
      readonly runtime: RuntimeKind
      readonly agentName: string
      readonly nodeRunId: string
    },
  ): void
  detectPluginLoadFailure(line: string): { pluginName: string; message: string } | null
}

export interface TaskAgentMaterialPreparation {
  /** Original mount preparation has a separate failure boundary before compile. */
  prepareMounts(): void
  compile(declaration: TaskAgentMaterialDeclaration): Promise<TaskCompiledAgentInvocation>
}

/** The selected execution owner interprets its own opaque task participant. */
export interface TaskAgentExecutionParticipantInput {
  readonly persistence: TaskExecutionEffectPersistence
  readonly nodeExecution: () => NodeExecutionPersistence
  readonly readOnlyWorkspace: () => boolean
}

export type TaskAgentExecutionParticipants = AgentExecutionParticipants &
  Required<Pick<AgentExecutionParticipants, 'taskEffect'>>

/** One complete invocation purpose. Every capability is required; there is no
 * per-member native fallback. Construction performs no IO or compilation. */
export interface TaskAgentRunPurpose {
  /** Adoptable executions retain the original observation call identity. */
  readonly invocationId?: string
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly workspace: AgentMaterialWorkspace
  readonly gitControlObservation: AgentWorkspaceGitControlObservation
  /** Content dialect of this purpose, shared by validation and archival. */
  readonly outputWorkspaceRef: string
  readonly outputValidation: PortOutputContentValidation
  /** RFC-461: the runner's idempotent `node.status` pings, published by the selected infrastructure. */
  readonly status: NodeStatusEvents
  /** Selection stays after the original envelope-nonce await. */
  selectMaterial(
    runtime: RuntimeKind,
    workspace: AgentMaterialWorkspace,
  ): TaskAgentMaterialPreparation
  bindExecutionParticipants(
    input: TaskAgentExecutionParticipantInput,
  ): TaskAgentExecutionParticipants
}

/** Selected resource owners supply ordered references. They interpret their
 * own locations/readers; no physical resource or fixture field crosses here. */
export interface TaskAgentMaterialResources {
  readonly injection: Pick<AgentMaterialIntent['injection'], 'skills' | 'plugins'>
  readonly runtimeBinding?: AgentMaterialIntent['runtimeBinding']
  prepareMounts(): AgentMaterialIntent['taskMounts']
}

/** The same selected material owner projects its actual MCP declarations and
 * load diagnostics. Core receives closed observations, never raw diagnostics. */
export interface TaskAgentMaterialDiagnostics {
  readDeclaredMcpServers(compiled: CompiledAgentInvocation): readonly string[] | undefined
  reportSpawn(
    compiled: CompiledAgentInvocation,
    ...input: Parameters<TaskCompiledAgentInvocation['reportSpawn']>
  ): void
  detectPluginLoadFailure(
    compiled: CompiledAgentInvocation,
    line: string,
  ): { pluginName: string; message: string } | null
}
