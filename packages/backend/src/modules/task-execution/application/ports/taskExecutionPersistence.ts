import type { TaskExecutionReadModels } from '../../public/types'
import type { TaskExecutionIntentPersistence } from './taskExecutionIntentPersistence'
import type { TaskOwnershipPersistence } from './taskOwnershipPersistence'
import type { TaskExecutionEffectPersistence } from './taskExecutionEffectStore'
import type { TerminalMaintenanceStore } from './terminalMaintenanceStore'
import type { GateContinuationEffectPersistence } from '../drive/gateContinuationEffectStep'
import type { TaskExecutionIntentTerminalPersistence } from '../terminalizeExecutionIntent'
import type { TaskExecutionRecoveryPersistence } from '../recoverTaskExecutions'
import type { HumanGateDecisionPersistence } from '../acceptHumanGateDecision'
import type { HumanGateTaskLifecycle } from './humanGateTaskLifecycle'
import type { TaskEngineApplicationPersistence } from './taskEngineApplicationPersistence'
import type { GateContinuationPreDrivePersistence } from './gateContinuationPreDrivePersistence'
import type { SchedulerCompletionPersistence } from './schedulerCompletionPersistence'
import type { ChildTaskBudgetQueries } from './childTaskBudgetQueries'
import type { NodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'
import type { NodeRunRuntimePersistence } from './nodeRunRuntimePersistence'
import type { WrapperRunPersistence } from './wrapperRunPersistence'
import type { TaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { NodeActivationSnapshotReader } from './nodeActivationSnapshotReader'
import type { MergeStateLifecyclePersistence } from './mergeStateLifecyclePersistence'
import type { TaskArtifactPathQueries } from './taskArtifactPathQueries'
import type { TaskRecoveryOperations } from './taskRecoveryOperations'
import type { RuntimeSessionCapturePersistence } from './runtimeSessionCapturePersistence'
import type { TaskExecutionShutdownOperations } from './taskExecutionShutdownOperations'

/** Bootstrap-selected task-execution persistence. Every member is a named
 * Promise port; provider clients remain in infrastructure factories. */
export interface TaskExecutionPersistence {
  readonly drive: TaskEngineApplicationPersistence
  readonly ownership: TaskOwnershipPersistence
  readonly intents: TaskExecutionIntentPersistence
  readonly effects: TaskExecutionEffectPersistence
  readonly terminalMaintenance: TerminalMaintenanceStore
  readonly gateContinuationEffects: GateContinuationEffectPersistence
  readonly gateContinuationPreDrive: GateContinuationPreDrivePersistence
  readonly scheduler: SchedulerCompletionPersistence
  readonly childBudget: ChildTaskBudgetQueries
  readonly nodeRuns: NodeRunLifecyclePersistence
  readonly nodeRunRuntime: NodeRunRuntimePersistence
  readonly nodeExecution: NodeExecutionPersistence
  readonly nodeActivation: NodeActivationSnapshotReader
  readonly mergeStates: MergeStateLifecyclePersistence
  readonly artifactPaths: TaskArtifactPathQueries
  readonly wrapperRuns: WrapperRunPersistence
  readonly runtimeLifecycle: TaskRuntimeLifecyclePersistence
  readonly intentTerminalization: TaskExecutionIntentTerminalPersistence
  readonly recovery: TaskExecutionRecoveryPersistence
  readonly humanGateDecisions: HumanGateDecisionPersistence
  readonly humanGateLifecycle: HumanGateTaskLifecycle
  readonly reads: TaskExecutionReadModels
  readonly recoveryAdministration: TaskRecoveryOperations
  readonly shutdown: TaskExecutionShutdownOperations
  readonly runtimeSessionCapture: RuntimeSessionCapturePersistence
}
