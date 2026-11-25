import { createTaskWorkspaceQueries } from './application/workspaceRead'
export { createFileTaskOperationConfiguration } from './infrastructure/local/fileTaskOperationConfiguration'
// RFC-534: the terminal workspace prune policy is a required Task Execution dependency (bootstrap hands integration's
// webhook policy to the session's assembly); the named never-prune policy is for the maintenance worker and tests.
export { neverPruneTerminalWorkspaces } from './infrastructure/terminalWorkspacePrune'
// RFC-553: the inbound projection of an authenticated actor's source onto the launch initiator (RFC-301: only inbound sees
// the source). Bootstrap binds it into other contexts' launch routes (knowledge-evolution's fusions) as their own port.
export { directTaskInitiatorFromActorSource } from './inbound/directTaskInitiator'
// RFC-582: the port-artifact and worktree-file HTTP bindings live in this module's inbound layer; server.ts mounts them here.
export { mountPortArtifactRoutes } from './inbound/http/portArtifactRoutes'
// RFC-587: the manual task archive binding.
export { mountTaskArchiveRoutes } from './inbound/http/taskArchiveRoutes'
export { mountWorktreeFilesRoutes } from './inbound/http/worktreeFilesRoutes'
import {
  bindTaskWorkspaceReadScope,
  type TaskWorkspaceReadDependencies,
} from './infrastructure/workspaceRead'
import type {
  TaskWorkspaceReadPort,
  WorkspaceReadCapability,
} from './application/ports/workspaceLaunch'
// RFC-328 — the daemon-owned task-execution composition root.

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { TaskExecutionPersistence } from './application/ports/taskExecutionPersistence'
import type { NodeRunQueries } from './application/ports/nodeRunQueries'
import { createNodeRunQueries as createNodeRunQueriesWithContent } from './infrastructure/nodeRunQueries'
import {
  ProviderTaskExecutionModule,
  TaskExecutionModule,
} from './infrastructure/taskExecutionModule'
// RFC-517: the module classes, their claim result, the ownership lease constants and the shutdown controller live in
// infrastructure; the root keeps the two module factories (RFC-530: no process-level instance).
export {
  DEFAULT_OWNERSHIP_HEARTBEAT_MS,
  DEFAULT_OWNERSHIP_LEASE_MS,
  ProviderTaskExecutionModule,
  TaskExecutionModule,
  createTaskExecutionShutdownController,
  type ClaimedTaskExecution,
} from './infrastructure/taskExecutionModule'

// RFC-530: no instance at import time — the SQLite execution binding builds one per session from the daemon generation
// bootstrap passes, as the PostgreSQL session binding always has.
export function createProcessTaskExecutionModule(daemonGeneration: string): TaskExecutionModule {
  return new TaskExecutionModule(daemonGeneration)
}

export function createProviderTaskExecutionModule(input: {
  readonly daemonGeneration: string
  readonly persistence: TaskExecutionPersistence
}): ProviderTaskExecutionModule {
  return new ProviderTaskExecutionModule(input.daemonGeneration, input.persistence)
}

// RFC-363: the Task query root binds the required port for one admitted read.
export function composeTaskWorkspaceQueries(input: TaskWorkspaceReadDependencies) {
  const bind: (taskId: string) => Promise<{
    readonly port: TaskWorkspaceReadPort
    readonly capability: WorkspaceReadCapability
    close(): void
  }> = (taskId) => bindTaskWorkspaceReadScope(input, taskId)
  return createTaskWorkspaceQueries(bind)
}

export { createEmployeeExecutionArtifactQueries } from './infrastructure/employeeExecutionArtifacts'

export { schemaContribution } from './composition/schema'

import { composeRealtimeTaskFactsPort } from './application/adapters/runtime-management-adapter'
import { createRealtimeTaskFacts } from './infrastructure/realtimeTaskFacts'

export function composeRealtimeTaskFacts(db: PersistenceDb) {
  return composeRealtimeTaskFactsPort(createRealtimeTaskFacts(db))
}

import { composeSubjectTaskReferenceParticipant } from './application/adapters/resource-catalog-adapter'
import { createSubjectTaskReferences } from './infrastructure/subjectTaskReferences'

export function composeSubjectTaskReferencePort(tx: PersistenceTx) {
  return composeSubjectTaskReferenceParticipant(createSubjectTaskReferences(tx))
}

import { TaskWorkspaceMaintenanceStore } from './infrastructure/taskWorkspaceMaintenanceStore'
import {
  composeWorkspaceGcTaskPort,
  composeTaskWorkspacePruneParticipant,
  composeCachedRepositoryTaskUsagePort,
  composeTaskRepositorySourceSealingPort,
} from './application/adapters/source-control-adapter'

export function composeSourceControlTaskPorts(db: PersistenceDb) {
  const workspace = new TaskWorkspaceMaintenanceStore(db)
  return {
    taskUsage: composeCachedRepositoryTaskUsagePort(createTaskRepositoryUsageQueries(db)),
    sourceSealing: composeTaskRepositorySourceSealingPort(createTaskRepositorySourceStore(db)),
    workspaceGc: composeWorkspaceGcTaskPort(workspace),
    workspacePrune: composeTaskWorkspacePruneParticipant(workspace),
  }
}

export { existingTaskIds } from './infrastructure/existingTaskIds'

import {
  createTaskRepositoryUsageQueries,
  createTaskRepositorySourceStore,
} from './infrastructure/taskRepositoryUsage'

export { createTaskWorktreeLocator } from './infrastructure/taskWorktreeLocator'

import { composeHumanGateTaskLockParticipant } from './application/adapters/collaboration-adapter'
import { createHumanGatePersistenceParticipantInTx } from './infrastructure/humanGatePersistenceParticipant'

export function composeHumanGateTaskLockPort(tx: PersistenceTx) {
  return composeHumanGateTaskLockParticipant(createHumanGatePersistenceParticipantInTx(tx))
}

export { createTaskCodeWorkspaceQueries } from './infrastructure/taskCodeWorkspaceQueries'
export { createTaskNodeEventArchiveStore } from './infrastructure/taskNodeEventArchiveStore'
export { createTaskResourceLimitFacts } from './infrastructure/taskResourceLimitFacts'

import { composeDoctorTaskLifecyclePort } from './application/adapters/system-operations-adapter'
import { createTaskLifecycleCounts } from './infrastructure/taskStatusCounts'
export { createTaskStatusCounts } from './infrastructure/taskStatusCounts'

export function composeSystemOperationsTaskPorts() {
  return composeDoctorTaskLifecyclePort(createTaskLifecycleCounts())
}
// RFC-562: Task Execution's hosted restore normalization participant — System Operations' other required port. The
// hosted restore composition takes it here; it is no longer handed out from public/participants.
export { createHostedRestoreTaskNormalization } from './infrastructure/hostedRestoreNormalization'

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition.
export { createTaskExecutionMaintenanceJobHandlers } from './application/maintenanceJobs'
// RFC-452: the maintenance job table runs the lifecycle invariant scan and the stuck-task detector, the daemon
// session drains running tasks through graceful shutdown, and HTTP composition builds the tasks route's diagnostics.
export { runLifecycleInvariants } from './application/lifecycleAlerts/lifecycleInvariants'
export { runStuckTaskDetector } from './application/lifecycleAlerts/stuckTaskDetector'
export { gracefulShutdown } from './application/recovery/gracefulShutdown'
export { composeTaskDiagnostics } from './composition/taskDiagnostics'
// RFC-402: bootstrap builds exactly one permit registry per daemon scope (and one per maintenance Worker graph).
export { createExecutionPermitRegistry } from './engine/kernel/permits'
export type { TaskExecutionPermitRegistry } from './application/ports/taskExecutionPermits'

export {
  createTaskNodeStatusEventsParticipantInTx,
  createHumanGateNodeRunStateParticipantInTx,
  createTaskDecisionParticipantInTx,
  createHumanGateNodeRunMintParticipantInTx,
  createHumanGateTaskTransitionParticipantInTx,
  createHumanGateNodeRunMintOperations,
} from './infrastructure/humanGateTaskParticipants'
export {
  createTaskAuthorizationQueries,
  createTaskAuthorizationParticipantInTx,
} from './infrastructure/taskAuthorization'
// RFC-477: collaboration's review rollback planning and clarify self-rollback enter through its own
// `NodeRunWorkspaceRollbackPort`; bootstrap hands this factory to collaboration's participant bindings.
export { createNodeRunWorkspaceRollback } from './infrastructure/nodeRollback'
// RFC-482: collaboration's remaining transaction participants and small reads arrive through the same participant
// bindings; bootstrap hands these factory references over (task-execution's public keeps only their interfaces).
export { createHumanGatePersistenceParticipantInTx } from './infrastructure/humanGatePersistenceParticipant'
export { createConsumedInputsParticipantInTx } from './infrastructure/consumedInputsParticipant'
export { createTaskClarifyDirectivePersistence } from './infrastructure/taskClarifyDirectivePersistence'
// RFC-568: bound with Resource Catalog's workflow read factory by bootstrap.
export { bindTaskSubjectQueries } from './composition/taskSubjectQueries'
export { createRunSelectionReader } from './infrastructure/runSelection/table/reader'
// RFC-485: the node-run, node-output and task-gate query factories reach collaboration through the same bindings and
// memory through its assembly input (task-execution's public keeps only the closed read interfaces). The node-run factory
// keeps the owner's database content reader, as the public wrapper did.
export function createNodeRunQueries(db: PersistenceDb): NodeRunQueries {
  return createNodeRunQueriesWithContent(db)
}
export { createNodeOutputQueries } from './infrastructure/nodeOutputQueries'
export { createTaskGateQueries } from './infrastructure/taskGateQueries'
// RFC-565: the task knowledge and trigger reads, and the retention fragment, for bootstrap to build on the root handle and
// hand to memory and integration (they left the public, which may not carry a database handle).
export { createTaskKnowledgeQueries } from './infrastructure/taskKnowledgeQueries'
export { createTaskTriggerQueries } from './infrastructure/taskTriggerQueries'
export { nonTerminalTaskExists } from './infrastructure/nonTerminalTaskExists'
// RFC-483: the task scope conditions collaboration's badge read model composes into its single-statement counts
// (RFC-359 AC-11), handed over through its participant bindings rather than the public.
export { nodeRunStatusCondition } from './infrastructure/nodeRunQueries'
// RFC-567: the open condition is bound with Resource Catalog's workflow name fragment (bootstrap hands it over).
export {
  bindTaskGateOpenCondition,
  taskGateVisibleCondition,
} from './infrastructure/taskGateQueries'
// RFC-477: the daemon's resource-limit tick runs task-execution's policy; bootstrap composes its operations (task facts
// plus system-operations' cancel audit) and schedules it.
export {
  enforceLimits,
  type EnforceLimitsResult,
  type ResourceLimitOperations,
} from './application/resourceLimitEnforcement'

// RFC-456: the terminal-watch hook the daemon root calls from committed-event callbacks (the root reaches it here, not
// in infrastructure/). RFC-533: the child-task budget is the session's — the daemon builds one per Task Execution
// assembly and calls it from the lifecycle consumer and the settings hot apply.
export {
  createChildTaskBudgetRuntime,
  type ChildTaskBudgetLimits,
  type ChildTaskBudgetRuntime,
} from './infrastructure/childBudget'
// RFC-535: the session's terminal watch (built next to its child-task budget).
export { createTaskTerminalWatch, type TaskTerminalWatch } from './infrastructure/executionWatch'
