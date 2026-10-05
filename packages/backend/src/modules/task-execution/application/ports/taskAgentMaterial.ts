import type { ObservationNativeProcessFact } from '@agent-workflow/shared'
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

/** The selected execution owner interprets its own opaque task participant.
 * This optional observation is a capture fact, never an execution payload. */
export interface TaskAgentExecutionParticipantInput {
  readonly persistence: TaskExecutionEffectPersistence
  readonly nodeExecution: () => NodeExecutionPersistence
  readonly readOnlyWorkspace: () => boolean
  readonly observeNativeProcess?: (fact: ObservationNativeProcessFact) => Promise<void>
}

export type TaskAgentExecutionParticipants = AgentExecutionParticipants &
  Required<Pick<AgentExecutionParticipants, 'taskEffect'>>

/** One complete invocation purpose. Every capability is required; there is no
 * per-member native fallback. Construction performs no IO or compilation. */
export interface TaskAgentRunPurpose {
  readonly nodeRunPrompts: NodeRunPromptOperations
  readonly portArtifacts: PortArtifactOperations
  readonly workspace: AgentMaterialWorkspace
  readonly gitControlObservation: AgentWorkspaceGitControlObservation
  /** Content dialect of this purpose, shared by validation and archival. */
  readonly outputWorkspaceRef: string
  readonly outputValidation: PortOutputContentValidation
  /** Selection stays after the original envelope-nonce await. */
  selectMaterial(
    runtime: RuntimeKind,
    workspace: AgentMaterialWorkspace,
  ): TaskAgentMaterialPreparation
  bindExecutionParticipants(
    input: TaskAgentExecutionParticipantInput,
  ): TaskAgentExecutionParticipants
}
