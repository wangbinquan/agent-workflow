import type { DbClient } from '../../src/db/client'
import { composeTaskExecutionHumanGateAdapter } from '../../src/modules/collaboration/application/adapters/task-execution-human-gate-adapter'
import type { SchedulerDriverPort } from '../../src/modules/task-execution/public/commands'
import type { SchedulerRuntimeTopology } from '../../src/modules/task-execution/public/participants'
import { composeTaskExecutionRuntime } from '../../src/modules/task-execution/composition/taskExecutionRuntime'
import { driveTaskEngineApplication } from '../../src/modules/task-execution/composition/taskEngineApplication'
import type { RunTaskOptions } from '../../src/services/execution/taskEngineRuntimeOptions'
import { createIdentityAccessRuntime } from '../../src/modules/identity-access/composition'
import { composeTaskExecutionResourceBinding } from '../../src/modules/resource-catalog/composition/taskExecution'
import { legacyTaskExecutionResourceDependencies } from '../../src/services/execution/legacyTaskExecutionResourceDependencies'

type TaskDriveRequest = Parameters<SchedulerDriverPort['drive']>[0]

function createTaskExecutionTestIdentity(db: DbClient) {
  const identityAccess = createIdentityAccessRuntime({ db })
  return Object.freeze({
    identityAccess,
    resources: Object.freeze({
      delegatedRequests: identityAccess.delegatedRequests,
      taskExecutionResources: composeTaskExecutionResourceBinding(
        legacyTaskExecutionResourceDependencies,
      ),
    }),
  })
}

/** Shared direct-runtime helper: test schedulers use the same admitted owner. */
export function composeTaskExecutionTestRuntime(db: DbClient) {
  const identity = createTaskExecutionTestIdentity(db)
  return composeTaskExecutionRuntime({ db, identityAccess: identity.resources })
}

export interface RecordingSchedulerDriver {
  readonly driver: SchedulerDriverPort
  readonly kicks: TaskDriveRequest[]
  readonly cancellations: Array<Parameters<SchedulerDriverPort['cancelChild']>[0]>
  readonly resumptions: Array<Parameters<SchedulerDriverPort['resumeChild']>[0]>
  readonly activeChecks: string[]
}

export function createRecordingSchedulerDriver(
  active: (taskId: string) => boolean = () => false,
): RecordingSchedulerDriver {
  const kicks: TaskDriveRequest[] = []
  const cancellations: RecordingSchedulerDriver['cancellations'] = []
  const resumptions: RecordingSchedulerDriver['resumptions'] = []
  const activeChecks: string[] = []
  return {
    kicks,
    cancellations,
    resumptions,
    activeChecks,
    driver: {
      async drive(request) {
        kicks.push(request)
      },
      async cancelChild(input) {
        cancellations.push(input)
      },
      async resumeChild(input) {
        resumptions.push(input)
      },
      isTaskActive(taskId) {
        activeChecks.push(taskId)
        return active(taskId)
      },
    },
  }
}

export function createNoopSchedulerDriver(): SchedulerDriverPort {
  return {
    async drive() {},
    async cancelChild() {},
    async resumeChild() {},
    isTaskActive: () => false,
  }
}

export function createPoisonSchedulerDriver(
  label = 'unexpected scheduler driver call',
): SchedulerDriverPort {
  const fail = (): never => {
    throw new TypeError(label)
  }
  return {
    drive: async () => fail(),
    cancelChild: async () => fail(),
    resumeChild: async () => fail(),
    isTaskActive: fail,
  }
}

/**
 * RFC-331 test-only instance factory. Every direct task fixture chooses its
 * driver deliberately; production never imports this module and has no
 * implicit no-op/fallback path.
 */
export function createTaskExecutionTestTopology(input: {
  readonly db: DbClient
  readonly driver: 'real' | 'noop' | 'poison' | SchedulerDriverPort
}): SchedulerRuntimeTopology {
  const topology = composeTaskExecutionTestRuntime(input.db).topology
  const schedulerDriver =
    input.driver === 'real'
      ? topology.schedulerDriver
      : input.driver === 'noop'
        ? createNoopSchedulerDriver()
        : input.driver === 'poison'
          ? createPoisonSchedulerDriver()
          : input.driver
  return { ...topology, schedulerDriver }
}

/** Direct scheduler fixtures explicitly select the real instance topology. */
export function runTaskWithRealTestTopology(options: RunTaskOptions): Promise<void> {
  const identity =
    options.identityAccess === undefined ? createTaskExecutionTestIdentity(options.db) : undefined
  const identityAccess = options.identityAccess ?? identity?.resources
  if (identityAccess === undefined) throw new Error('task-execution-test-identity-missing')
  const runtime = composeTaskExecutionRuntime({ db: options.db, identityAccess })
  return driveTaskEngineApplication(
    { ...options, identityAccess },
    runtime.topology,
    composeTaskExecutionHumanGateAdapter(),
    runtime,
  )
}
