// Test-side assembly of the production task drive components. RFC-424 moved the coordinator factory assembly and the
// exact-intent human-gate wake here from services/task.ts (where RFC-387 had registered them as test-only): production
// assembles the factory in bootstrap alone. Everything assembled here is a production implementation — the application
// factory, the task-execution / collaboration composition entries — and this file only wires them for fixtures that
// inject a scheduler driver, runtime overrides or a completion mode.
// RFC-395 II-pre：生产启动 / 延续依赖及工作区租约改接线，保留既有断言。
import { taskExecutionParticipants } from './taskExecutionParticipantBindings'
import {
  composeGateContinuationSupport,
  composeHumanGateOpenParticipantFactory,
} from '@/modules/collaboration/composition'
import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import {
  skipRepositoryPreparation,
  type AdmittedContinuationStep,
  type GateContinuationPreDriveStep,
  type RepositoryPreparationStep,
  type TaskDriveFailureReporter,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import {
  createTaskDriveCoordinatorFactory,
  type TaskDriveCoordinatorFactory,
} from '@/modules/task-execution/application/drive/taskDriveCoordinatorFactory'
import { createRoomContinuation } from '@/modules/task-execution/application/drive/roomContinuation'
import {
  composeHumanGateTaskLockPort,
  composeSourceControlTaskPorts,
} from '@/modules/task-execution/composition'
import { composeGateContinuationPreDrive } from '@/modules/task-execution/composition/gateContinuationPreDrive'
import type { HumanGateOpenParticipantFactory } from '@/modules/task-execution/composition/required-ports'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  TaskExecutionError,
  createGateContinuationDriver,
  composeWorktreeResumePreflight,
} from '@/modules/task-execution/public/participants'
import {
  awaitTaskDriverIdle,
  createDatabaseTaskDriverLifecyclePort,
  isTaskDriverActive,
} from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { resolveTaskSubagentLiveCapture } from '@/modules/task-execution/public/queries'
import { resolveTaskLaunchRuntimeConfiguration } from '@/modules/task-execution/application/launchConfiguration'
import type { TaskLaunchConfigurationQueries } from '@/modules/task-execution/application/ports/taskLaunchConfiguration'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import {
  composeWorkspaceMaintenanceCommand,
  createFileWorkspacePresenceQueries,
} from '@/modules/source-control/composition'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { getTask } from '@/modules/task-execution/infrastructure/taskDetailRead'
import { runtimeConfigOpts } from '@/modules/task-execution/composition/taskDriveRuntimeOptions'
import type { TaskContinuationDependencies } from './taskContinuationDependencies'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('task')

export function createTestTaskDriveCoordinator(
  input: Omit<
    Parameters<typeof composeTestTaskDriveFactory>[0],
    'historyRestrictions' | 'taskExecutionParticipants'
  > & {
    readonly historyRestrictions?: Parameters<
      typeof composeTestTaskDriveFactory
    >[0]['historyRestrictions']
    readonly admittedContinuation?: AdmittedContinuationStep
    readonly engineFailureMessage?: string
    readonly failureReporter?: TaskDriveFailureReporter
  },
) {
  return composeTestTaskDriveFactory({
    taskExecutionParticipants,
    ...input,
    historyRestrictions:
      input.historyRestrictions ?? epoch2RuntimeTestPorts(input.deps.db).historyRestrictions,
  }).coordinatorFor({
    admittedContinuation: input.admittedContinuation,
  })
}

export function composeTestRoomContinuation(input: {
  readonly db: TaskContinuationDependencies['db']
  readonly configPath: string
  readonly schedulerDriver: TaskContinuationDependencies['schedulerDriver']
  readonly taskRecoveryOperations: TaskRecoveryOperations
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly launchConfiguration?: TaskLaunchConfigurationQueries
}) {
  const presence = input.workspacePresence ?? createFileWorkspacePresenceQueries()
  return createRoomContinuation({
    assertResumable: composeWorktreeResumePreflight({
      getTask: (id) => getTask(input.db, id),
      taskRecoveryOperations: input.taskRecoveryOperations,
      worktreeExists: (reference) => presence.exists(reference),
    }),
    gateContinuation: createGateContinuationDriver({
      isDriving: isTaskDriverActive,
      coordinator: createTestTaskDriveCoordinator({
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
        deps: input,
        appHome: Paths.root,
      }),
    }),
    log: createLogger('rfc387-room-test'),
  })
}

const missingMemoryDistillEnqueuer: MemoryDistillEnqueuer = Object.freeze({
  async enqueue() {
    throw new TaskExecutionError(
      'task-execution-recovery-required',
      'memory distill enqueuer is not composed for clarify continuation convergence',
    )
  },
})

/** RFC-424: moved from services/task.ts — exactly the dependency fields the factory assembly below reads. */
export type TaskDriveCoordinatorDependencies = Parameters<typeof runtimeConfigOpts>[0] &
  Pick<
    TaskContinuationDependencies,
    | 'schedulerDriver'
    | 'binaryOverride'
    | 'configPath'
    | 'subagentLiveCapture'
    | 'memoryDistillEnqueuer'
    | 'workspacePresence'
    | 'launchConfiguration'
    | 'launchConfigurationOverrides'
  > & {
    /**
     * RFC-359 AC-1（plan §5hm）：收成中立句柄。此前这一格是从 `TaskContinuationDependencies` Pick 来的
     * `PersistenceDb`——**不是因为协调器真要 SQLite**，而是它装的驱动生命周期端口
     * 当年只有 SQLite 一份（要 `DbClient`）。端口合一之后那个约束没了：
     * 协调器这一路上读 `db` 的三处（生命周期端口、闸门继续前置、工作区清理）全是中立实现。
     * `TaskContinuationDependencies` 仍然满足这个更宽的类型，所以本文件内既有构造点一个字都不用改。
     */
    readonly db: PersistenceDb
  }

/** RFC-424: moved verbatim from services/task.ts — the test-side assembly of the production coordinator factory. */
export function composeTestTaskDriveFactory(input: {
  readonly taskExecutionParticipants: Parameters<
    typeof composeGateContinuationSupport
  >[0]['taskExecutionParticipants']
  readonly humanGateOpen: HumanGateOpenParticipantFactory
  readonly historyRestrictions: HistoryRestrictionPort
  readonly deps: TaskDriveCoordinatorDependencies
  readonly appHome: string
  readonly persistence?: ReturnType<typeof createTaskExecutionPersistence>
  readonly repositoryPreparation?: RepositoryPreparationStep
  readonly gateContinuationPreDrive?: GateContinuationPreDriveStep
  readonly refreshLaunchConfig?: () =>
    | Partial<TaskDriveCoordinatorDependencies>
    | Promise<Partial<TaskDriveCoordinatorDependencies>>
  readonly launchConfiguration?: TaskLaunchConfigurationQueries
}): TaskDriveCoordinatorFactory {
  const persistence =
    input.persistence ??
    createTaskExecutionPersistence(input.deps.db, {
      humanGateOpen: input.humanGateOpen,
      historyRestrictions: input.historyRestrictions,
      workspacePresence: input.deps.workspacePresence,
    })
  const maintenance = composeWorkspaceMaintenanceCommand({
    ...composeSourceControlTaskPorts(input.deps.db),
    appHome: input.appHome,
    terminalMaintenance: persistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: () => {},
  })
  return createTaskDriveCoordinatorFactory({
    async runConfiguration() {
      const source = input.launchConfiguration ?? input.deps.launchConfiguration
      const fresh =
        source === undefined
          ? await input.refreshLaunchConfig?.()
          : {
              ...(await resolveTaskLaunchRuntimeConfiguration(source)),
              subagentLiveCapture: await resolveTaskSubagentLiveCapture(source),
              ...input.deps.launchConfigurationOverrides,
            }
      const deps = { ...input.deps, ...fresh }
      return {
        appHome: input.appHome,
        ...(deps.binaryOverride === undefined ? {} : { binaryOverride: deps.binaryOverride }),
        ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
        ...(deps.subagentLiveCapture === undefined
          ? {}
          : { subagentLiveCapture: deps.subagentLiveCapture }),
        ...runtimeConfigOpts(
          source === undefined
            ? deps
            : {
                ...fresh,
                memoryDistillEnqueuer: input.deps.memoryDistillEnqueuer,
              },
        ),
      }
    },
    lifecycle: createDatabaseTaskDriverLifecyclePort({
      humanGateOpen: input.humanGateOpen,
      historyRestrictions: input.historyRestrictions,
      db: input.deps.db,
      persistence,
      workspacePresence: input.deps.workspacePresence,
      log,
      finalizeWorkspace: (taskId) => maintenance.finalizeClaimedWorkspace(taskId),
    }),
    gateContinuationPreDrive:
      input.gateContinuationPreDrive ??
      composeGateContinuationPreDrive({
        persistence,
        ...composeGateContinuationSupport({
          taskExecutionParticipants: input.taskExecutionParticipants,
          historyRestrictions: input.historyRestrictions,
          db: input.deps.db,
          taskLock: composeHumanGateTaskLockPort,
          memoryDistillEnqueuer: input.deps.memoryDistillEnqueuer ?? missingMemoryDistillEnqueuer,
        }),
      }),
    repositoryPreparation: input.repositoryPreparation ?? skipRepositoryPreparation,
    engine: () => input.deps.schedulerDriver,
    failures: persistence,
    log,
  })
}

/** RFC-424: moved verbatim from services/task.ts — the exact-intent human-gate wake over the test-side factory. */
export async function wakeHumanGateContinuation(
  taskId: string,
  continuationRef: string,
  deps: TaskContinuationDependencies,
): Promise<void> {
  if (deps.awaitScheduler === true) await awaitTaskDriverIdle(taskId)
  else if (isTaskDriverActive(taskId)) return
  await composeTestTaskDriveFactory({
    taskExecutionParticipants: deps.taskExecutionParticipants,
    humanGateOpen: deps.humanGateOpen,
    deps,
    historyRestrictions: deps.historyRestrictions,
    appHome: deps.appHome ?? Paths.root,
  }).session.submit({
    taskId,
    intentId: continuationRef,
    completionMode: deps.awaitScheduler === true ? 'await-settle' : 'background',
  })
}
