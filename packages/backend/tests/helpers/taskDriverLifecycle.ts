// RFC-530 — the driver-lifecycle helpers only tests used. They read the process-level execution module the composition
// root built at import time; production now builds one per session binding, so these act on the tests' module
// (`testTaskExecutionModule`). Bodies as they were in infrastructure/taskDriverLifecycle.ts.
import type { HumanGateOpenParticipantFactory } from '@/modules/task-execution/application/ports/humanGateOpenFactory'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TaskDriverLifecyclePort } from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import type { TaskExecutionPersistence } from '@/modules/task-execution/application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import { TaskExecutionError } from '@/modules/task-execution/application/taskExecutionError'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  neverPruneTerminalWorkspaces,
  type TerminalWorkspacePrunePolicy,
} from '@/modules/task-execution/infrastructure/terminalWorkspacePrune'
import { ownershipTokenKey } from '@/modules/task-execution/domain/ownership'
import {
  clearTaskDriverLifecycleForTesting as clearOwnerHeartbeats,
  createTaskDriverLifecyclePort,
} from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { testTaskExecutionModule } from './taskExecutionModule'

export function activeTaskDriverController(taskId: string): AbortController | undefined {
  const registry = testTaskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  return token === null ? undefined : (registry.controllerFor(token) ?? undefined)
}

export function isTaskDriverActive(taskId: string): boolean {
  return testTaskExecutionModule.runtimeRegistry.hasTask(taskId)
}

/** 两阶段停机：driver 已停但库里 owner 行 / intent 还在转移时等它 settle（准入前调用）。 */
export async function awaitTaskDriverReleasedSettled(taskId: string): Promise<void> {
  await testTaskExecutionModule.runtimeRegistry.awaitReleasedSettled(taskId)
}

/** Wait for the current process-local owner to release without requesting a stop. */
export async function awaitTaskDriverIdle(taskId: string): Promise<void> {
  const registry = testTaskExecutionModule.runtimeRegistry
  const token = registry.tokenForTask(taskId)
  if (token === null) return
  const result = await registry.awaitStopped({ token, tokenKey: ownershipTokenKey(token) })
  if (result.kind === 'unreaped') {
    throw new TaskExecutionError(
      'task-execution-recovery-required',
      `task '${taskId}' owner stopped with unreaped work (${result.code})`,
    )
  }
}

/** Test isolation: the owner heartbeats and the tests' module registry. */
export function clearTaskDriverLifecycleForTesting(): void {
  clearOwnerHeartbeats()
  testTaskExecutionModule.runtimeRegistry.clearForTesting()
}

/** A SQLite driver lifecycle port over the tests' module, persistence built from `db` and the legacy connection. */
export function createDatabaseTaskDriverLifecyclePort(options: {
  readonly humanGateOpen: HumanGateOpenParticipantFactory
  readonly historyRestrictions: HistoryRestrictionPort
  readonly db: PersistenceDb
  readonly persistence?: TaskExecutionPersistence
  /** RFC-526: required (the persistence built here, and the per-claim execution context, need the presence). */
  readonly workspacePresence: WorkspacePresenceQueries
  /** RFC-534: the persistence built here prunes with this policy (never, unless a case exercises reclamation). */
  readonly terminalWorkspacePrune?: TerminalWorkspacePrunePolicy
  readonly log: TaskExecutionTopologyLogger
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}): TaskDriverLifecyclePort {
  return createTaskDriverLifecyclePort({
    db: options.db,
    module: testTaskExecutionModule,
    claim: (intentId) => testTaskExecutionModule.claim({ db: options.db, intentId }),
    persistence:
      options.persistence ??
      createTaskExecutionPersistence(options.db, {
        ...options,
        terminalWorkspacePrune: options.terminalWorkspacePrune ?? neverPruneTerminalWorkspaces,
      }),
    log: options.log,
    finalizeWorkspace: options.finalizeWorkspace,
    legacyConnection: options.db,
  })
}
