import type { DbClient } from '../../src/db/client'
import { createSqliteTaskDagCollaborationOperations } from '../../src/modules/collaboration/infrastructure/sqliteTaskDagCollaborationOperations'
import { createSqliteCollaborationRuntimeMechanics } from '../../src/modules/collaboration/infrastructure/sqliteCollaborationRuntimeMechanics'
import type { SchedulerDriverPort } from '../../src/modules/task-execution/public/commands'
import type { SchedulerRuntimeTopology } from '../../src/modules/task-execution/public/participants'
import { composeTaskExecutionRuntime } from '../../src/modules/task-execution/composition/taskExecutionRuntime'
import { createSqliteTaskExecutionPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import { createSqliteTaskExecutionRuntimeParticipants } from '../../src/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants'
import { createSqliteRuntimeSessionLeaseOperations } from '../../src/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'
import { driveTaskEngineApplication } from '../../src/modules/task-execution/composition/taskEngineApplication'
import type { RunTaskOptions } from '../../src/services/execution/taskEngineRuntimeOptions'
import { createIdentityAccessRuntime } from '../../src/modules/identity-access/composition'
import { composeTaskExecutionResourceBinding } from '../../src/modules/resource-catalog/composition/taskExecution'
import { legacyTaskExecutionResourceDependencies } from '../../src/services/execution/legacyTaskExecutionResourceDependencies'
import { createSqliteTaskExecutionResourceBinding } from '../../src/services/execution/taskExecutionResources'
import { runGit } from '../../src/util/git'
import { sqliteMemoryInjectionQueries } from './memoryInjection'
import { composeSqliteRuntimeRegistryOperations } from '../../src/platform/runtime-registry/composition'
import { createSqliteWorkgroupTurnsOperations } from '../../src/modules/task-execution/infrastructure/sqliteWorkgroupTurnsOperations'
import { createSqliteChildExecutionLaunchOperations } from '../../src/modules/task-execution/infrastructure/sqliteChildExecutionLaunchOperations'
import { composeSqliteDynamicWorkflowPersistence } from '../../src/modules/task-execution/composition/dynamicWorkflowPersistence'
import { buildWorkflowValidationContext } from '../../src/services/workflow.validator'
import type { CodeHostConnectionsService } from '../../src/services/codeHost/connections'

type TaskDriveRequest = Parameters<SchedulerDriverPort['drive']>[0]

export function createTestRepositoryPublicationTransport(runNetwork: typeof runGit = runGit) {
  return Object.freeze({
    async open(input: { readonly remoteUrl: string }) {
      return {
        ok: true as const,
        session: {
          endpointUrl: input.remoteUrl,
          receipt: {
            credentialSource: 'legacy' as const,
            credentialRevision: null,
            endpointSource: 'local-fixture' as const,
            endpointBindingDigest: null,
          },
          runNetwork,
          close() {},
        },
      }
    },
  })
}

function createTaskExecutionTestIdentity(db: DbClient) {
  const identityAccess = createIdentityAccessRuntime({ db })
  return Object.freeze({
    identityAccess,
    resources: Object.freeze({
      delegatedRequests: identityAccess.delegatedRequests,
      taskExecutionResources: createSqliteTaskExecutionResourceBinding(
        db,
        composeTaskExecutionResourceBinding(legacyTaskExecutionResourceDependencies),
      ),
    }),
  })
}

/** Shared direct-runtime helper: test schedulers use the same admitted owner. */
export function composeTaskExecutionTestRuntime(
  db: DbClient,
  options: Readonly<{ codeHostConnections?: CodeHostConnectionsService }> = {},
) {
  const identity = createTaskExecutionTestIdentity(db)
  const persistence = createSqliteTaskExecutionPersistence(db)
  return composeTaskExecutionRuntime({
    readModels: persistence.reads,
    participants: createSqliteTaskExecutionRuntimeParticipants({
      db,
      identityAccess: identity.resources,
      memoryInjectionQueries: sqliteMemoryInjectionQueries(db),
      collaborationRuntime: createSqliteCollaborationRuntimeMechanics(db),
      persistence,
      runtimeSessionLeases: createSqliteRuntimeSessionLeaseOperations(db),
      runtimeRegistry: composeSqliteRuntimeRegistryOperations(db),
      dynamicWorkflow: {
        persistence: composeSqliteDynamicWorkflowPersistence(db),
        validationContext: { load: () => buildWorkflowValidationContext(db) },
      },
      ...(options.codeHostConnections === undefined
        ? {}
        : { codeHostConnections: options.codeHostConnections }),
      repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
    }),
  })
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
export function runTaskWithRealTestTopology(
  options: RunTaskOptions & { readonly db: DbClient },
): Promise<void> {
  const identity =
    options.identityAccess === undefined ? createTaskExecutionTestIdentity(options.db) : undefined
  const identityAccess = options.identityAccess ?? identity?.resources
  if (identityAccess === undefined) throw new Error('task-execution-test-identity-missing')
  const memoryInjectionQueries =
    options.memoryInjectionQueries ?? sqliteMemoryInjectionQueries(options.db)
  const persistence = options.persistence ?? createSqliteTaskExecutionPersistence(options.db)
  const runtimeSessionLeases =
    options.runtimeSessionLeases ?? createSqliteRuntimeSessionLeaseOperations(options.db)
  const runtimeRegistry =
    options.runtimeRegistry ?? composeSqliteRuntimeRegistryOperations(options.db)
  const repositoryPublicationTransport =
    options.repositoryPublicationTransport ?? createTestRepositoryPublicationTransport()
  const dynamicWorkflow =
    options.dynamicWorkflow ??
    Object.freeze({
      persistence: composeSqliteDynamicWorkflowPersistence(options.db),
      validationContext: { load: () => buildWorkflowValidationContext(options.db) },
    })
  const runtime = composeTaskExecutionRuntime({
    readModels: persistence.reads,
    participants: createSqliteTaskExecutionRuntimeParticipants({
      db: options.db,
      identityAccess,
      memoryInjectionQueries,
      collaborationRuntime: createSqliteCollaborationRuntimeMechanics(options.db),
      persistence,
      runtimeSessionLeases,
      runtimeRegistry,
      dynamicWorkflow,
      repositoryPublicationTransport,
    }),
  })
  return driveTaskEngineApplication(
    {
      ...options,
      identityAccess,
      memoryInjectionQueries,
      persistence,
      runtimeSessionLeases,
      runtimeRegistry,
      taskDagCollaboration:
        options.taskDagCollaboration ?? createSqliteTaskDagCollaborationOperations(options.db),
      collaborationRuntime:
        options.collaborationRuntime ?? createSqliteCollaborationRuntimeMechanics(options.db),
      workgroupTurns: options.workgroupTurns ?? createSqliteWorkgroupTurnsOperations(options.db),
      childLaunch: options.childLaunch ?? createSqliteChildExecutionLaunchOperations(options.db),
      dynamicWorkflow,
      processConcurrencyScope: options.processConcurrencyScope ?? options.db,
      repositoryPublicationTransport,
    },
    runtime.topology,
    runtime,
  )
}
